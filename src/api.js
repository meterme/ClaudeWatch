const express = require("express");
const { getDb, persist } = require("./db");
const {
  getAdminApiKey,
  setAdminApiKey,
  fetchCostReport,
  fetchUsageReport,
} = require("./admin-api");

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

// ── Plan config CRUD ────────────────────────────────────────────────────────
router.get("/plan-config", async (req, res) => {
  const db = await getDb();
  const rows = query(db, "SELECT * FROM plan_config LIMIT 1");
  const apiKey = await getAdminApiKey();
  res.json({
    plan: rows[0] || null,
    hasAdminApiKey: !!apiKey,
  });
});

router.post("/plan-config", async (req, res) => {
  const db = await getDb();
  const {
    plan_name = "Team",
    seat_type = "standard",
    seat_count = 1,
    monthly_seat_cost_usd = 20,
    billing_cycle_day = 1,
    admin_api_key,
  } = req.body || {};

  const now = new Date().toISOString();
  const existing = query(db, "SELECT id FROM plan_config LIMIT 1");

  if (existing.length > 0) {
    db.run(
      `UPDATE plan_config SET plan_name=?, seat_type=?, seat_count=?,
       monthly_seat_cost_usd=?, billing_cycle_day=?, updated_at=? WHERE id=?`,
      [plan_name, seat_type, seat_count, monthly_seat_cost_usd,
       Math.min(28, Math.max(1, billing_cycle_day)), now, existing[0].id]
    );
  } else {
    db.run(
      `INSERT INTO plan_config (plan_name, seat_type, seat_count,
       monthly_seat_cost_usd, billing_cycle_day, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [plan_name, seat_type, seat_count, monthly_seat_cost_usd,
       Math.min(28, Math.max(1, billing_cycle_day)), now, now]
    );
  }

  if (admin_api_key !== undefined) {
    await setAdminApiKey(admin_api_key);
  }

  persist();
  res.json({ ok: true });
});

// ── 5-hour session windows ──────────────────────────────────────────────────
router.get("/stats/session-windows", async (req, res) => {
  const db = await getDb();
  const { from, to, user } = req.query;
  const wc = whereClause(from, to, user);

  const windows = query(db, `
    WITH ordered AS (
      SELECT timestamp, user_email, cost_usd, input_tokens, output_tokens,
        ROUND((julianday(timestamp) - julianday(
          LAG(timestamp) OVER (PARTITION BY user_email ORDER BY timestamp)
        )) * 86400) AS gap_seconds
      FROM api_requests ${wc.sql}
    ),
    windowed AS (
      SELECT *,
        SUM(CASE WHEN gap_seconds IS NULL OR gap_seconds > 18000 THEN 1 ELSE 0 END)
          OVER (PARTITION BY user_email ORDER BY timestamp) AS window_id
      FROM ordered
    )
    SELECT user_email, window_id,
      MIN(timestamp) AS window_start, MAX(timestamp) AS window_end,
      COUNT(*) AS request_count,
      ROUND(SUM(cost_usd), 6) AS total_cost,
      SUM(input_tokens) AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS total_tokens,
      ROUND((julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 24, 4) AS duration_hours
    FROM windowed
    GROUP BY user_email, window_id
    ORDER BY window_start DESC
  `, wc.params);

  res.json(computeSessionWindowStats(windows));
});

// ── Monthly overage ─────────────────────────────────────────────────────────
router.get("/stats/overage", async (req, res) => {
  const db = await getDb();
  const configRows = query(db, "SELECT * FROM plan_config LIMIT 1");
  if (configRows.length === 0) {
    return res.json({ configured: false });
  }
  const config = configRows[0];
  const period = getBillingPeriod(config.billing_cycle_day);
  const basePlanCost = config.seat_count * config.monthly_seat_cost_usd;

  const totalCost = scalar(db,
    `SELECT COALESCE(SUM(cost_usd), 0) AS v FROM api_requests
     WHERE timestamp >= ? AND timestamp < ?`,
    [period.start, period.end]);

  const byUser = query(db,
    `SELECT user_email,
            SUM(cost_usd) AS cost,
            COUNT(*) AS requests,
            SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS tokens
     FROM api_requests
     WHERE timestamp >= ? AND timestamp < ?
     GROUP BY user_email
     ORDER BY cost DESC`,
    [period.start, period.end]);

  const overage = Math.max(0, totalCost - basePlanCost);
  const projectedCost = period.daysElapsed > 0
    ? (totalCost / period.daysElapsed) * period.totalDays
    : 0;

  res.json({
    configured: true,
    billing_period: period,
    base_plan_cost: basePlanCost,
    total_cost: totalCost,
    overage,
    projected_end_of_period: Math.round(projectedCost * 100) / 100,
    by_user: byUser,
  });
});

// ── Admin API proxies ───────────────────────────────────────────────────────
router.get("/admin/cost-report", async (req, res) => {
  const apiKey = await getAdminApiKey();
  if (!apiKey) return res.status(400).json({ error: "Admin API key not configured" });

  try {
    const data = await fetchCostReport(apiKey, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get("/admin/usage-report", async (req, res) => {
  const apiKey = await getAdminApiKey();
  if (!apiKey) return res.status(400).json({ error: "Admin API key not configured" });

  try {
    const data = await fetchUsageReport(apiKey, {
      from: req.query.from,
      to: req.query.to,
      groupBy: req.query.group_by,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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

function getBillingPeriod(cycleDayOfMonth) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();

  let periodStart, periodEnd;
  if (day >= cycleDayOfMonth) {
    periodStart = new Date(year, month, cycleDayOfMonth);
    periodEnd = new Date(year, month + 1, cycleDayOfMonth);
  } else {
    periodStart = new Date(year, month - 1, cycleDayOfMonth);
    periodEnd = new Date(year, month, cycleDayOfMonth);
  }

  const msPerDay = 86400000;
  const totalDays = Math.round((periodEnd - periodStart) / msPerDay);
  const daysElapsed = Math.round((now - periodStart) / msPerDay);
  const daysRemaining = totalDays - daysElapsed;

  return {
    start: periodStart.toISOString(),
    end: periodEnd.toISOString(),
    daysElapsed,
    daysRemaining,
    totalDays,
  };
}

function computeSessionWindowStats(windows) {
  if (windows.length === 0) {
    return { windows: [], summary: {
      total_windows: 0, avg_cost_per_window: 0, avg_tokens_per_window: 0,
      avg_requests_per_window: 0, avg_duration_hours: 0,
      avg_cost_per_active_hour: null, total_cost: 0, total_active_hours: 0,
    }};
  }

  const n = windows.length;
  const totalCost = windows.reduce((s, w) => s + (w.total_cost || 0), 0);
  const totalTokens = windows.reduce((s, w) => s + (w.total_tokens || 0), 0);
  const totalRequests = windows.reduce((s, w) => s + w.request_count, 0);
  const totalActiveHours = windows.reduce((s, w) => s + (w.duration_hours || 0), 0);

  const activeHoursForVelocity = windows
    .filter(w => w.duration_hours > 0)
    .reduce((s, w) => s + w.duration_hours, 0);

  return {
    windows,
    summary: {
      total_windows: n,
      avg_cost_per_window: totalCost / n,
      avg_tokens_per_window: Math.round(totalTokens / n),
      avg_requests_per_window: Math.round(totalRequests / n),
      avg_duration_hours: Math.round((totalActiveHours / n) * 100) / 100,
      avg_cost_per_active_hour: activeHoursForVelocity > 0
        ? Math.round((totalCost / activeHoursForVelocity) * 100) / 100
        : null,
      total_cost: Math.round(totalCost * 100) / 100,
      total_active_hours: Math.round(totalActiveHours * 100) / 100,
    },
  };
}

module.exports = router;
