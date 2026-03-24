const { getDb, persist } = require("./db");

/**
 * Parse OTLP JSON logs export and insert into SQLite.
 *
 * Claude Code sends events as OTLP log records via HTTP/JSON.
 * The payload shape is: { resourceLogs: [{ scopeLogs: [{ logRecords: [...] }] }] }
 *
 * Each logRecord has:
 *   - timeUnixNano: string
 *   - attributes: [{ key, value: { stringValue | intValue | doubleValue } }]
 *   - body: { stringValue } (the event name like "claude_code.api_request")
 */
async function ingestOtlpLogs(payload) {
  const db = await getDb();
  let inserted = 0;

  const resourceLogs = payload.resourceLogs || [];
  for (const rl of resourceLogs) {
    // Extract resource-level attributes (user, org, etc.)
    const resourceAttrs = attrMap(rl.resource?.attributes || []);

    const scopeLogs = rl.scopeLogs || [];
    for (const sl of scopeLogs) {
      const logRecords = sl.logRecords || [];
      for (const rec of logRecords) {
        const eventName =
          rec.body?.stringValue ||
          attrMap(rec.attributes || [])["event.name"] ||
          "";
        const attrs = {
          ...resourceAttrs,
          ...attrMap(rec.attributes || []),
        };
        const ts = nanoToISO(rec.timeUnixNano || rec.observedTimeUnixNano);

        inserted += insertEvent(db, eventName, ts, attrs);
      }
    }
  }

  if (inserted > 0) persist();
  return inserted;
}

/** Convert OTel attribute array to a flat key→value map */
function attrMap(attributes) {
  const m = {};
  for (const a of attributes) {
    const v = a.value;
    m[a.key] =
      v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? JSON.stringify(v);
  }
  return m;
}

function nanoToISO(nanos) {
  if (!nanos) return new Date().toISOString();
  const ms = Number(BigInt(nanos) / 1_000_000n);
  return new Date(ms).toISOString();
}

function insertEvent(db, eventName, ts, a) {
  const common = {
    ts,
    session_id: a["session.id"] || null,
    prompt_id: a["prompt.id"] || null,
    user_email: a["user.email"] || null,
    user_id: a["user.id"] || a["user.account_uuid"] || null,
    org_id: a["organization.id"] || null,
  };

  switch (eventName) {
    case "claude_code.api_request":
      db.run(
        `INSERT INTO api_requests
          (timestamp, session_id, prompt_id, user_email, user_id, org_id,
           model, cost_usd, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, duration_ms,
           app_version, terminal_type, response_content)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          common.ts,
          common.session_id,
          common.prompt_id,
          common.user_email,
          common.user_id,
          common.org_id,
          a["gen_ai.request.model"] || a["model"] || null,
          toNum(a["cost_usd"] || a["claude_code.cost.usage"]),
          toInt(a["gen_ai.usage.input_tokens"]),
          toInt(a["gen_ai.usage.output_tokens"]),
          toInt(a["cache_read_input_tokens"]),
          toInt(a["cache_creation_input_tokens"]),
          toInt(a["duration_ms"]),
          a["app.version"] || null,
          a["terminal.type"] || null,
          a["response.content"] || a["gen_ai.response.content"] || null,
        ]
      );
      return 1;

    case "claude_code.tool_result":
      db.run(
        `INSERT INTO tool_uses
          (timestamp, session_id, prompt_id, user_email, user_id, org_id,
           tool_name, success, duration_ms, error)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          common.ts,
          common.session_id,
          common.prompt_id,
          common.user_email,
          common.user_id,
          common.org_id,
          a["tool.name"] || a["tool_name"] || null,
          a["tool.success"] === "true" || a["tool.success"] === true ? 1 : 0,
          toInt(a["tool.duration_ms"] || a["duration_ms"]),
          a["tool.error"] || null,
        ]
      );
      return 1;

    case "claude_code.user_prompt":
      db.run(
        `INSERT INTO user_prompts
          (timestamp, session_id, prompt_id, user_email, user_id, org_id,
           prompt_length, prompt_content)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          common.ts,
          common.session_id,
          common.prompt_id,
          common.user_email,
          common.user_id,
          common.org_id,
          toInt(a["prompt.length"]),
          a["prompt.content"] || null,
        ]
      );
      return 1;

    case "claude_code.api_error":
      db.run(
        `INSERT INTO api_errors
          (timestamp, session_id, prompt_id, user_email, user_id, org_id,
           error_message, status_code, retries)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          common.ts,
          common.session_id,
          common.prompt_id,
          common.user_email,
          common.user_id,
          common.org_id,
          a["error.message"] || null,
          toInt(a["http.status_code"]),
          toInt(a["retry.count"]),
        ]
      );
      return 1;

    case "claude_code.tool_decision":
      db.run(
        `INSERT INTO tool_decisions
          (timestamp, session_id, prompt_id, user_email, user_id, org_id,
           tool_name, decision)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          common.ts,
          common.session_id,
          common.prompt_id,
          common.user_email,
          common.user_id,
          common.org_id,
          a["tool.name"] || null,
          a["tool.decision"] || null,
        ]
      );
      return 1;

    default:
      // Unknown event — skip silently
      return 0;
  }
}

function toNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function toInt(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

module.exports = { ingestOtlpLogs };
