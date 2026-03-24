const express = require("express");
const { getDb } = require("./db");

const router = express.Router();

// ── Summary stats ───────────────────────────────────────────────────────────
router.get("/stats/summary", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);

  const totalCost = scalar(db,
    `SELECT COALESCE(SUM(cost_usd), 0) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalRequests = scalar(db,
    `SELECT COUNT(*) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalTokensIn = scalar(db,
    `SELECT COALESCE(SUM(input_tokens), 0) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalTokensOut = scalar(db,
    `SELECT COALESCE(SUM(output_tokens), 0) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalPrompts = scalar(db,
    `SELECT COUNT(*) AS v FROM user_prompts ${wc.sql}`, wc.params);
  const totalErrors = scalar(db,
    `SELECT COUNT(*) AS v FROM api_errors ${wc.sql}`, wc.params);
  const uniqueUsers = scalar(db,
    `SELECT COUNT(DISTINCT user_email) AS v FROM api_requests ${wc.sql}`, wc.params);
  const uniqueSessions = scalar(db,
    `SELECT COUNT(DISTINCT session_id) AS v FROM api_requests ${wc.sql}`, wc.params);

  res.json({
    totalCost, totalRequests, totalTokensIn, totalTokensOut,
    totalPrompts, totalErrors, uniqueUsers, uniqueSessions,
  });
});

// ── Cost over time (daily) ──────────────────────────────────────────────────
router.get("/stats/cost-over-time", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);
  const rows = query(db,
    `SELECT DATE(timestamp) AS day,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(*) AS requests
     FROM api_requests ${wc.sql}
     GROUP BY DATE(timestamp)
     ORDER BY day`, wc.params);
  res.json(rows);
});

// ── Usage by model ──────────────────────────────────────────────────────────
router.get("/stats/by-model", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);
  const rows = query(db,
    `SELECT model,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM api_requests ${wc.sql}
     GROUP BY model
     ORDER BY cost DESC`, wc.params);
  res.json(rows);
});

// ── Usage by user ───────────────────────────────────────────────────────────
router.get("/stats/by-user", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);
  const rows = query(db,
    `SELECT user_email,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(DISTINCT session_id) AS sessions
     FROM api_requests ${wc.sql}
     GROUP BY user_email
     ORDER BY cost DESC`, wc.params);
  res.json(rows);
});

// ── Tool usage breakdown ────────────────────────────────────────────────────
router.get("/stats/tools", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user, "tool_uses");
  const rows = query(db,
    `SELECT tool_name,
            COUNT(*) AS uses,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
            AVG(duration_ms) AS avg_duration_ms
     FROM tool_uses ${wc.sql}
     GROUP BY tool_name
     ORDER BY uses DESC`, wc.params);
  res.json(rows);
});

// ── Hourly activity heatmap ─────────────────────────────────────────────────
router.get("/stats/hourly-activity", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);
  const rows = query(db,
    `SELECT CAST(strftime('%w', timestamp) AS INTEGER) AS dow,
            CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost
     FROM api_requests ${wc.sql}
     GROUP BY dow, hour
     ORDER BY dow, hour`, wc.params);
  res.json(rows);
});

// ── Recent events feed ──────────────────────────────────────────────────────
router.get("/events/recent", async (req, res) => {
  const db = await getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const rows = query(db,
    `SELECT 'api_request' AS type, timestamp, user_email, model, cost_usd, session_id
     FROM api_requests
     UNION ALL
     SELECT 'tool_use', timestamp, user_email, tool_name, duration_ms, session_id
     FROM tool_uses
     UNION ALL
     SELECT 'prompt', timestamp, user_email, NULL, prompt_length, session_id
     FROM user_prompts
     UNION ALL
     SELECT 'error', timestamp, user_email, error_message, status_code, session_id
     FROM api_errors
     ORDER BY timestamp DESC
     LIMIT ?`, [limit]);
  res.json(rows);
});

// ── Sessions list ───────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);
  const rows = query(db,
    `SELECT session_id,
            user_email,
            MIN(timestamp) AS started,
            MAX(timestamp) AS ended,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM api_requests ${wc.sql}
     GROUP BY session_id
     ORDER BY started DESC
     LIMIT 100`, wc.params);
  res.json(rows);
});

// ── Single session conversation ─────────────────────────────────────────────
router.get("/sessions/:id", async (req, res) => {
  const db = await getDb();
  const sid = req.params.id;

  const prompts = query(db,
    `SELECT timestamp, prompt_id, prompt_content, prompt_length
     FROM user_prompts
     WHERE session_id = ?
     ORDER BY timestamp`, [sid]);

  const requests = query(db,
    `SELECT timestamp, prompt_id, model, cost_usd, input_tokens, output_tokens,
            duration_ms, response_content
     FROM api_requests
     WHERE session_id = ?
     ORDER BY timestamp`, [sid]);

  const tools = query(db,
    `SELECT timestamp, prompt_id, tool_name, success, duration_ms, error
     FROM tool_uses
     WHERE session_id = ?
     ORDER BY timestamp`, [sid]);

  // Merge into a conversation timeline grouped by prompt_id
  const promptMap = new Map();
  for (const p of prompts) {
    promptMap.set(p.prompt_id, {
      prompt_id: p.prompt_id,
      timestamp: p.timestamp,
      prompt: p.prompt_content,
      prompt_length: p.prompt_length,
      response: null,
      model: null,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
      tools: [],
    });
  }

  for (const r of requests) {
    let entry = promptMap.get(r.prompt_id);
    if (!entry) {
      entry = {
        prompt_id: r.prompt_id,
        timestamp: r.timestamp,
        prompt: null,
        prompt_length: null,
        response: null,
        model: null,
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 0,
        tools: [],
      };
      promptMap.set(r.prompt_id, entry);
    }
    entry.response = r.response_content;
    entry.model = r.model;
    entry.cost_usd += r.cost_usd || 0;
    entry.input_tokens += r.input_tokens || 0;
    entry.output_tokens += r.output_tokens || 0;
    entry.duration_ms += r.duration_ms || 0;
  }

  for (const t of tools) {
    const entry = promptMap.get(t.prompt_id);
    if (entry) {
      entry.tools.push({
        tool_name: t.tool_name,
        success: t.success,
        duration_ms: t.duration_ms,
        error: t.error,
      });
    }
  }

  const conversation = [...promptMap.values()].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp)
  );

  res.json({ session_id: sid, conversation });
});

// ── List known users ────────────────────────────────────────────────────────
router.get("/users", async (req, res) => {
  const db = await getDb();
  const rows = query(db,
    `SELECT DISTINCT user_email FROM api_requests WHERE user_email IS NOT NULL ORDER BY user_email`);
  res.json(rows.map(r => r.user_email));
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function whereClause(from, to, user, table = "api_requests") {
  const conds = [];
  const params = [];
  if (from) { conds.push("timestamp >= ?"); params.push(from); }
  if (to)   { conds.push("timestamp <= ?"); params.push(to); }
  if (user) { conds.push("user_email = ?"); params.push(user); }
  const sql = conds.length ? "WHERE " + conds.join(" AND ") : "";
  return { sql, params };
}

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function scalar(db, sql, params = []) {
  const rows = query(db, sql, params);
  return rows[0]?.v ?? 0;
}

module.exports = router;
