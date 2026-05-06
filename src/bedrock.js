const {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const { getDb, persist } = require("./db");

// ── Bedrock pricing table ────────────────────────────────────────────────────
// Prices in USD per 1,000 tokens (on-demand, as of early 2025)
const BEDROCK_PRICING = [
  { match: "claude-3-5-sonnet-20241022", input: 0.003,    output: 0.015   },
  { match: "claude-3-5-sonnet-20240620", input: 0.003,    output: 0.015   },
  { match: "claude-3-5-haiku",           input: 0.0008,   output: 0.004   },
  { match: "claude-3-opus",              input: 0.015,    output: 0.075   },
  { match: "claude-3-sonnet",            input: 0.003,    output: 0.015   },
  { match: "claude-3-haiku",             input: 0.00025,  output: 0.00125 },
  { match: "claude-v2",                  input: 0.008,    output: 0.024   },
  { match: "claude-2",                   input: 0.008,    output: 0.024   },
  { match: "claude-instant",             input: 0.0008,   output: 0.0024  },
];

// ── Config helpers ───────────────────────────────────────────────────────────

const CONFIG_KEYS = [
  "bedrock_access_key_id",
  "bedrock_secret_access_key",
  "bedrock_session_token",
  "bedrock_region",
  "bedrock_log_group_name",
  "bedrock_poll_interval_minutes",
  "bedrock_last_sync_time",
];

async function getBedrockConfig() {
  const db = await getDb();
  const stmt = db.prepare(
    `SELECT key, value FROM config WHERE key LIKE 'bedrock_%'`
  );
  const map = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    map[row.key] = row.value;
  }
  stmt.free();

  return {
    accessKeyId:          map.bedrock_access_key_id || null,
    secretAccessKey:      map.bedrock_secret_access_key || null,
    sessionToken:         map.bedrock_session_token || null,
    region:               map.bedrock_region || null,
    logGroupName:         map.bedrock_log_group_name || null,
    pollIntervalMinutes:  parseInt(map.bedrock_poll_interval_minutes) || 0,
    lastSyncTime:         map.bedrock_last_sync_time || null,
  };
}

async function setBedrockConfig(updates) {
  const db = await getDb();
  const keyMap = {
    accessKeyId:         "bedrock_access_key_id",
    secretAccessKey:     "bedrock_secret_access_key",
    sessionToken:        "bedrock_session_token",
    region:              "bedrock_region",
    logGroupName:        "bedrock_log_group_name",
    pollIntervalMinutes: "bedrock_poll_interval_minutes",
    lastSyncTime:        "bedrock_last_sync_time",
  };

  for (const [jsKey, dbKey] of Object.entries(keyMap)) {
    if (jsKey in updates) {
      const val = updates[jsKey];
      if (val === null || val === "") {
        db.run("DELETE FROM config WHERE key = ?", [dbKey]);
      } else {
        db.run(
          "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
          [dbKey, String(val), String(val)]
        );
      }
    }
  }
  persist();
}

// ── Utility functions ────────────────────────────────────────────────────────

function parseIamUser(arn) {
  if (!arn) return null;
  // "arn:aws:sts::123456789012:assumed-role/MyRole/john@example.com" → "john@example.com"
  // "arn:aws:iam::123456789012:user/john" → "john"
  const parts = arn.split("/");
  return parts[parts.length - 1] || null;
}

function normalizeModelId(raw) {
  if (!raw) return null;
  // Strip cross-region inference profile prefix (e.g. "us.anthropic..." → "anthropic..."),
  // then strip "anthropic." prefix.
  return raw
    .replace(/^(us|eu|apac|ap|ca|sa|af)\./, "")
    .replace(/^anthropic\./, "");
}

function bedrockPricingUsd(modelId, inputTokens, outputTokens) {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  const entry = BEDROCK_PRICING.find(p => id.includes(p.match));
  if (!entry) return null; // unknown model — store null, not 0
  const inCost  = (inputTokens  || 0) * entry.input  / 1000;
  const outCost = (outputTokens || 0) * entry.output / 1000;
  return Math.round((inCost + outCost) * 1e8) / 1e8;
}

// ── Main sync function ───────────────────────────────────────────────────────

async function syncBedrockLogs() {
  const cfg = await getBedrockConfig();

  if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.region || !cfg.logGroupName) {
    throw new Error("Bedrock not configured. Set AWS credentials, region, and log group name in Settings.");
  }

  const credentials = {
    accessKeyId:     cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  };
  if (cfg.sessionToken) credentials.sessionToken = cfg.sessionToken;

  const client = new CloudWatchLogsClient({
    region: cfg.region,
    credentials,
  });

  // Default to 24h ago on first sync
  const endTime = Date.now();
  const startTime = cfg.lastSyncTime
    ? new Date(cfg.lastSyncTime).getTime()
    : endTime - 24 * 60 * 60 * 1000;

  const db = await getDb();
  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const params = {
    logGroupName: cfg.logGroupName,
    startTime,
    endTime,
    filterPattern: '{ $.schemaType = "ModelInvocationLog" }',
  };

  let nextToken;
  do {
    if (nextToken) params.nextToken = nextToken;

    let response;
    try {
      response = await client.send(new FilterLogEventsCommand(params));
    } catch (err) {
      errors.push(err.message);
      break;
    }

    for (const event of response.events || []) {
      let log;
      try {
        log = JSON.parse(event.message);
      } catch {
        continue;
      }

      if (log.schemaType !== "ModelInvocationLog") continue;
      if (log.operation !== "InvokeModel") continue;

      const requestId = log.requestId;
      if (!requestId) continue;

      // Deduplication check
      const existing = db.prepare("SELECT 1 FROM api_requests WHERE aws_request_id = ? LIMIT 1");
      existing.bind([requestId]);
      const alreadyExists = existing.step();
      existing.free();
      if (alreadyExists) { skipped++; continue; }

      const rawModel    = log.modelId || null;
      const model       = normalizeModelId(rawModel);
      const inputTokens = log.input?.inputTokenCount  || 0;
      const outputTokens = log.output?.outputTokenCount || 0;
      const costUsd     = bedrockPricingUsd(model, inputTokens, outputTokens);
      const userEmail   = parseIamUser(log.identity?.arn);
      const timestamp   = log.timestamp
        ? new Date(log.timestamp).toISOString()
        : new Date(event.timestamp).toISOString();

      try {
        db.run(
          `INSERT INTO api_requests
             (timestamp, user_email, model, cost_usd,
              input_tokens, output_tokens,
              source, aws_request_id)
           VALUES (?, ?, ?, ?, ?, ?, 'bedrock', ?)`,
          [timestamp, userEmail, model, costUsd, inputTokens, outputTokens, requestId]
        );
        inserted++;
      } catch (err) {
        if (err.message.includes("UNIQUE")) {
          skipped++;
        } else {
          errors.push(`Insert failed for ${requestId}: ${err.message}`);
        }
      }
    }

    nextToken = response.nextToken;
  } while (nextToken);

  // Persist and update high-water mark
  if (inserted > 0) persist();
  await setBedrockConfig({ lastSyncTime: new Date(endTime).toISOString() });

  return { inserted, skipped, errors };
}

// ── Background poller ────────────────────────────────────────────────────────

let pollerHandle = null;

async function startBedrockPoller() {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }

  const cfg = await getBedrockConfig();
  const minutes = cfg.pollIntervalMinutes || 0;
  if (minutes <= 0) return; // manual-only mode

  pollerHandle = setInterval(async () => {
    console.log("[bedrock] polling CloudWatch logs...");
    try {
      const result = await syncBedrockLogs();
      console.log(`[bedrock] sync complete: ${result.inserted} inserted, ${result.skipped} skipped`);
      if (result.errors.length) console.error("[bedrock] errors:", result.errors);
    } catch (err) {
      console.error("[bedrock] sync error:", err.message);
    }
  }, minutes * 60 * 1000);

  console.log(`[bedrock] poller started (interval=${minutes}min)`);
}

module.exports = {
  getBedrockConfig,
  setBedrockConfig,
  parseIamUser,
  normalizeModelId,
  bedrockPricingUsd,
  syncBedrockLogs,
  startBedrockPoller,
};
