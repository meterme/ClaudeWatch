const express = require("express");
const { getDb, persist } = require("./db");
const {
  getAdminApiKey,
  setAdminApiKey,
  fetchCostReport,
  fetchUsageReport,
  fetchClaudeCodeRange,
} = require("./admin-api");
const {
  listDashboardUsers,
  createDashboardUser,
  updateDashboardUser,
  deleteDashboardUser,
} = require("./auth");

const router = express.Router();

// ── Summary stats ───────────────────────────────────────────────────────────
router.get("/stats/summary", async (req, res) => {
  const db = await getDb();
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);

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
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);
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
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);
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
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);
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

  // Determine top model per user (most tokens in the same window)
  const modelRows = query(db,
    `SELECT user_email, model,
            SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS total_tokens
     FROM api_requests ${wc.sql}
     GROUP BY user_email, model
     ORDER BY user_email, total_tokens DESC`, wc.params);

  const topModelByUser = {};
  for (const r of modelRows) {
    if (!topModelByUser[r.user_email]) {
      topModelByUser[r.user_email] = { model: r.model, tokens: r.total_tokens };
    }
  }
  for (const r of rows) {
    const tm = topModelByUser[r.user_email];
    r.top_model = tm?.model || null;
    r.top_model_tokens = tm?.tokens || 0;
  }

  res.json(rows);
});

// ── Tool usage breakdown ────────────────────────────────────────────────────
router.get("/stats/tools", async (req, res) => {
  const db = await getDb();
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);
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
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);
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
  const audience = parseAudience(db, req);

  let userWhere = "";
  let userParams = [];
  if (Array.isArray(audience)) {
    if (audience.length === 0) {
      userWhere = "WHERE 1=0";
    } else {
      userWhere = `WHERE user_email IN (${audience.map(() => "?").join(",")})`;
      userParams = audience;
    }
  }

  const rows = query(db,
    `SELECT 'api_request' AS type, timestamp, user_email, model, cost_usd, session_id,
            input_tokens, output_tokens
     FROM api_requests ${userWhere}
     UNION ALL
     SELECT 'tool_use', timestamp, user_email, tool_name, duration_ms, session_id,
            NULL, NULL
     FROM tool_uses ${userWhere}
     UNION ALL
     SELECT 'prompt', timestamp, user_email, NULL, prompt_length, session_id,
            NULL, NULL
     FROM user_prompts ${userWhere}
     UNION ALL
     SELECT 'error', timestamp, user_email, error_message, status_code, session_id,
            NULL, NULL
     FROM api_errors ${userWhere}
     ORDER BY timestamp DESC
     LIMIT ?`,
    [...userParams, ...userParams, ...userParams, ...userParams, limit]);
  res.json(rows);
});

// ── Sessions list ───────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  const db = await getDb();
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);
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

// ── Diagnostic: sample raw data to debug token ingestion ────────────────────
router.get("/debug/sample-rows", async (req, res) => {
  const db = await getDb();
  const rows = query(db,
    `SELECT id, timestamp, model, cost_usd, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens
     FROM api_requests ORDER BY id DESC LIMIT 10`);
  res.json(rows);
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
  const members = query(db, "SELECT email, name, seat_tier, status, imported_at FROM org_members ORDER BY name");
  res.json({
    plan: rows[0] || null,
    hasAdminApiKey: !!apiKey,
    members,
  });
});

router.post("/plan-config", async (req, res) => {
  const db = await getDb();
  const {
    billing_cycle_day = 1,
    standard_seat_cost_usd = 20,
    premium_seat_cost_usd = 100,
    admin_api_key,
  } = req.body || {};

  const now = new Date().toISOString();
  const existing = query(db, "SELECT id FROM plan_config LIMIT 1");
  const day = Math.min(28, Math.max(1, billing_cycle_day));

  if (existing.length > 0) {
    db.run(
      `UPDATE plan_config SET billing_cycle_day=?, standard_seat_cost_usd=?,
       premium_seat_cost_usd=?, updated_at=? WHERE id=?`,
      [day, standard_seat_cost_usd, premium_seat_cost_usd, now, existing[0].id]
    );
  } else {
    db.run(
      `INSERT INTO plan_config (billing_cycle_day, standard_seat_cost_usd,
       premium_seat_cost_usd, created_at, updated_at) VALUES (?,?,?,?,?)`,
      [day, standard_seat_cost_usd, premium_seat_cost_usd, now, now]
    );
  }

  if (admin_api_key !== undefined) {
    await setAdminApiKey(admin_api_key);
  }

  persist();
  res.json({ ok: true });
});

// ── Members CSV import ───────────────────────────────────────────────────────
router.post("/members/import", express.text({ type: "text/csv", limit: "1mb" }), async (req, res) => {
  const csv = req.body;
  if (!csv) return res.status(400).json({ error: "No CSV body" });

  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: "CSV appears empty" });

  // Parse header row to find column indexes (case-insensitive)
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const col = (name) => headers.indexOf(name);
  const iName = col("name"), iEmail = col("email"), iRole = col("role");
  const iStatus = col("status"), iTier = col("seat tier");

  if (iEmail === -1) return res.status(400).json({ error: "CSV missing Email column" });

  const db = await getDb();
  const now = new Date().toISOString();
  let upserted = 0;

  for (const line of lines.slice(1)) {
    const cells = line.split(",").map(c => c.trim());
    const email = cells[iEmail];
    if (!email) continue;

    db.run(
      `INSERT INTO org_members (email, name, role, status, seat_tier, imported_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET
         name=excluded.name, role=excluded.role, status=excluded.status,
         seat_tier=excluded.seat_tier, imported_at=excluded.imported_at`,
      [
        email,
        iName >= 0 ? cells[iName] || null : null,
        iRole >= 0 ? cells[iRole] || null : null,
        iStatus >= 0 ? cells[iStatus] || null : null,
        iTier >= 0 ? cells[iTier] || null : null,
        now,
      ]
    );
    upserted++;
  }

  persist();
  const members = query(db, "SELECT email, name, seat_tier, status, imported_at FROM org_members ORDER BY name");
  res.json({ ok: true, upserted, members });
});

// ── 5-hour session windows ──────────────────────────────────────────────────
router.get("/stats/session-windows", async (req, res) => {
  const db = await getDb();
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);

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

// ── Billing period summary (informational, no overage guessing) ─────────────
router.get("/stats/billing-summary", async (req, res) => {
  const db = await getDb();
  const configRows = query(db, "SELECT * FROM plan_config LIMIT 1");
  const config = configRows[0] || {
    billing_cycle_day: 1,
    standard_seat_cost_usd: 20,
    premium_seat_cost_usd: 100,
  };
  const period = getBillingPeriod(config.billing_cycle_day);

  // Per-user spend in this billing period
  const byUser = query(db,
    `SELECT ar.user_email,
            COALESCE(m.name, ar.user_email) AS name,
            COALESCE(m.seat_tier, 'Standard') AS seat_tier,
            SUM(ar.cost_usd) AS api_equivalent_cost,
            COUNT(*) AS requests,
            SUM(COALESCE(ar.input_tokens,0) + COALESCE(ar.output_tokens,0)) AS tokens
     FROM api_requests ar
     LEFT JOIN org_members m ON LOWER(ar.user_email) = LOWER(m.email)
     WHERE ar.timestamp >= ? AND ar.timestamp < ?
     GROUP BY ar.user_email
     ORDER BY api_equivalent_cost DESC`,
    [period.start, period.end]);

  let totalCost = 0, totalTokens = 0;
  for (const u of byUser) {
    totalCost += u.api_equivalent_cost || 0;
    totalTokens += u.tokens || 0;
  }

  res.json({
    billing_period: period,
    seat_costs: {
      standard: config.standard_seat_cost_usd,
      premium: config.premium_seat_cost_usd,
    },
    total_api_equivalent_cost: Math.round(totalCost * 100) / 100,
    total_tokens: totalTokens,
    by_user: byUser,
  });
});

// ── 7-day weekly rolling windows ────────────────────────────────────────────
router.get("/stats/weekly-windows", async (req, res) => {
  const db = await getDb();
  const { from, to } = req.query;
  const audience = parseAudience(db, req);
  const wc = whereClause(from, to, audience);

  // Group requests into 7-day (168-hour) rolling windows per user,
  // using same gap-based approach as 5-hour windows but with 7-day threshold
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
        SUM(CASE WHEN gap_seconds IS NULL OR gap_seconds > 604800 THEN 1 ELSE 0 END)
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

// ── Per-user Anthropic-reported cost (Claude Code Analytics API) ─────────────
router.get("/admin/per-user-cost", async (req, res) => {
  const apiKey = await getAdminApiKey();
  if (!apiKey) return res.json({ available: false });

  const db = await getDb();
  const configRows = query(db, "SELECT * FROM plan_config LIMIT 1");
  const config = configRows[0] || { billing_cycle_day: 1 };
  const period = getBillingPeriod(config.billing_cycle_day);

  try {
    const byUser = await fetchClaudeCodeRange(
      apiKey,
      period.start.slice(0, 10),
      period.end.slice(0, 10)
    );

    // Convert to array with cost in dollars
    const users = Object.entries(byUser).map(([email, data]) => ({
      email,
      anthropic_cost: Math.round(data.estimated_cost_cents) / 100, // cents → dollars
      anthropic_tokens: data.tokens,
      days_active: data.days_active,
    }));

    res.json({ available: true, billing_period: period, users });
  } catch (err) {
    console.error("[admin] per-user-cost error:", err.message);
    res.json({ available: false, error: err.message });
  }
});

// ── Dashboard user management ───────────────────────────────────────────────
router.get("/dashboard-users", async (req, res) => {
  const users = await listDashboardUsers();
  res.json(users);
});

router.post("/dashboard-users", async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  if (role && !["admin", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or viewer" });
  }
  try {
    await createDashboardUser(username, password, role || "viewer");
    const users = await listDashboardUsers();
    res.json({ ok: true, users });
  } catch (err) {
    const msg = err.message.includes("UNIQUE") ? "Username already exists" : err.message;
    res.status(400).json({ error: msg });
  }
});

router.put("/dashboard-users/:id", async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username) {
    return res.status(400).json({ error: "Username required" });
  }
  if (role && !["admin", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or viewer" });
  }
  try {
    await updateDashboardUser(parseInt(req.params.id), { username, password, role: role || "viewer" });
    const users = await listDashboardUsers();
    res.json({ ok: true, users });
  } catch (err) {
    const msg = err.message.includes("UNIQUE") ? "Username already exists" : err.message;
    res.status(400).json({ error: msg });
  }
});

router.delete("/dashboard-users/:id", async (req, res) => {
  try {
    await deleteDashboardUser(parseInt(req.params.id));
    const users = await listDashboardUsers();
    res.json({ ok: true, users });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Teams CRUD ──────────────────────────────────────────────────────────────
router.get("/teams", async (req, res) => {
  const db = await getDb();
  const teams = query(db, `SELECT id, name, created_at FROM teams ORDER BY name`);
  const members = query(db, `SELECT team_id, user_email FROM team_members ORDER BY user_email`);
  const byTeam = {};
  for (const m of members) {
    (byTeam[m.team_id] = byTeam[m.team_id] || []).push(m.user_email);
  }
  res.json(teams.map(t => ({ ...t, members: byTeam[t.id] || [] })));
});

router.post("/teams", async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Team name required" });

  const db = await getDb();
  try {
    db.run(`INSERT INTO teams (name) VALUES (?)`, [name]);
    persist();
    const team = query(db, `SELECT id, name, created_at FROM teams WHERE name = ?`, [name])[0];
    res.json({ ok: true, team: { ...team, members: [] } });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Team name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

router.patch("/teams/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Team name required" });

  const db = await getDb();
  try {
    db.run(`UPDATE teams SET name = ? WHERE id = ?`, [name, id]);
    persist();
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Team name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete("/teams/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = await getDb();
  db.run(`DELETE FROM team_members WHERE team_id = ?`, [id]);
  db.run(`DELETE FROM teams WHERE id = ?`, [id]);
  persist();
  res.json({ ok: true });
});

router.post("/teams/:id/members", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const email = (req.body?.email || "").trim();
  if (!email) return res.status(400).json({ error: "Email required" });

  const db = await getDb();
  const team = query(db, `SELECT id FROM teams WHERE id = ?`, [id])[0];
  if (!team) return res.status(404).json({ error: "Team not found" });

  db.run(
    `INSERT INTO team_members (team_id, user_email) VALUES (?, ?)
     ON CONFLICT DO NOTHING`,
    [id, email]
  );
  persist();
  res.json({ ok: true });
});

router.delete("/teams/:id/members/:email", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const email = decodeURIComponent(req.params.email);
  const db = await getDb();
  db.run(`DELETE FROM team_members WHERE team_id = ? AND user_email = ?`, [id, email]);
  persist();
  res.json({ ok: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
// `audience` is either null (no user filter) or an array of emails.
// Empty array means "filter to nobody" → emit 1=0 so the result is empty.
function whereClause(from, to, audience) {
  const conds = [];
  const params = [];
  if (from) { conds.push("timestamp >= ?"); params.push(from); }
  if (to)   { conds.push("timestamp <= ?"); params.push(to); }

  if (Array.isArray(audience)) {
    if (audience.length === 0) {
      conds.push("1=0");
    } else {
      conds.push(`user_email IN (${audience.map(() => "?").join(",")})`);
      params.push(...audience);
    }
  }

  const sql = conds.length ? "WHERE " + conds.join(" AND ") : "";
  return { sql, params };
}

// Resolves `?users=a@b,c@d` and `?teams=1,3` into a flat email array.
// Returns null when neither is set (meaning: no user filter).
// Returns [] when filters were sent but resolve to no emails (meaning: filter to nobody).
function parseAudience(db, req) {
  const usersParam = req.query.users;
  const teamsParam = req.query.teams;

  if (!usersParam && !teamsParam) return null;

  const emails = new Set();
  if (usersParam) {
    String(usersParam).split(",").map(s => s.trim()).filter(Boolean).forEach(e => emails.add(e));
  }
  if (teamsParam) {
    const ids = String(teamsParam).split(",")
      .map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = query(db,
        `SELECT DISTINCT user_email FROM team_members WHERE team_id IN (${placeholders})`,
        ids);
      rows.forEach(r => { if (r.user_email) emails.add(r.user_email); });
    }
  }

  return Array.from(emails);
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
