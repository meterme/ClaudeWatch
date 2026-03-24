const { getDb, persist } = require("./db");

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";

// ── Config helpers ──────────────────────────────────────────────────────────

async function getAdminApiKey() {
  const db = await getDb();
  const stmt = db.prepare("SELECT value FROM config WHERE key = ?");
  stmt.bind(["admin_api_key"]);
  const key = stmt.step() ? stmt.getAsObject().value : null;
  stmt.free();
  return key;
}

async function setAdminApiKey(key) {
  const db = await getDb();
  db.run(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    ["admin_api_key", key, key]
  );
  persist();
}

// ── API calls ───────────────────────────────────────────────────────────────

async function fetchCostReport(apiKey, { from, to }) {
  const params = new URLSearchParams();
  if (from) params.set("starting_at", from);
  if (to) params.set("ending_at", to);

  const res = await fetch(
    `${ANTHROPIC_API_BASE}/organizations/cost_report?${params}`,
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic cost_report ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchUsageReport(apiKey, { from, to, groupBy }) {
  const params = new URLSearchParams();
  if (from) params.set("starting_at", from);
  if (to) params.set("ending_at", to);
  if (groupBy) params.append("group_by[]", groupBy);

  const res = await fetch(
    `${ANTHROPIC_API_BASE}/organizations/usage_report/messages?${params}`,
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic usage_report ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Fetch Claude Code Analytics for a single day.
 * Returns all pages of per-user daily usage.
 */
async function fetchClaudeCodeDay(apiKey, dateStr) {
  const allData = [];
  let page = null;

  while (true) {
    const params = new URLSearchParams();
    params.set("starting_at", dateStr);
    params.set("limit", "1000");
    if (page) params.set("page", page);

    const res = await fetch(
      `${ANTHROPIC_API_BASE}/organizations/usage_report/claude_code?${params}`,
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic claude_code ${res.status}: ${body}`);
    }

    const json = await res.json();
    allData.push(...(json.data || []));

    if (!json.has_more) break;
    page = json.next_page;
  }

  return allData;
}

/**
 * Fetch Claude Code Analytics for a date range and aggregate per-user.
 * Returns { [email]: { tokens, estimated_cost_cents, days_active } }
 */
async function fetchClaudeCodeRange(apiKey, startDate, endDate) {
  // Build list of YYYY-MM-DD dates in the range
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  // Fetch days in parallel (batches of 5 to avoid hammering the API)
  const byUser = {};
  for (let i = 0; i < dates.length; i += 5) {
    const batch = dates.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(date => fetchClaudeCodeDay(apiKey, date).catch(() => []))
    );

    for (const dayData of results) {
      for (const record of dayData) {
        const email = record.actor?.email_address;
        if (!email) continue;

        if (!byUser[email]) {
          byUser[email] = { tokens: 0, estimated_cost_cents: 0, days_active: 0 };
        }
        const u = byUser[email];
        u.days_active++;

        for (const mb of record.model_breakdown || []) {
          const t = mb.tokens || {};
          u.tokens += (t.input || 0) + (t.output || 0) + (t.cache_read || 0);
          u.estimated_cost_cents += mb.estimated_cost?.amount || 0;
        }
      }
    }
  }

  return byUser;
}

module.exports = {
  getAdminApiKey,
  setAdminApiKey,
  fetchCostReport,
  fetchUsageReport,
  fetchClaudeCodeRange,
};
