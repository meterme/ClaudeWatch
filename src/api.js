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
const {
  getBedrockConfig,
  setBedrockConfig,
  syncBedrockLogs,
  startBedrockPoller,
} = require("./bedrock");
const { maskRows, unmaskFilter, aliasFor, isObscureMode } = require("./user-mask");

const router = express.Router();

// ── Summary stats ───────────────────────────────────────────────────────────
router.get("/stats/summary", async (req, res) => {
  const db = await getDb();
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);
  // user_prompts / api_errors have no `source` column, so reuse a source-less
  // clause for them — applying the source filter there throws "no such column".
  const wcNoSrc = whereClause(from, to, audience, null, "user_prompts");

  const totalCost = scalar(db,
    `SELECT COALESCE(SUM(cost_usd), 0) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalRequests = scalar(db,
    `SELECT COUNT(*) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalTokensIn = scalar(db,
    `SELECT COALESCE(SUM(input_tokens), 0) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalTokensOut = scalar(db,
    `SELECT COALESCE(SUM(output_tokens), 0) AS v FROM api_requests ${wc.sql}`, wc.params);
  const totalPrompts = scalar(db,
    `SELECT COUNT(*) AS v FROM user_prompts ${wcNoSrc.sql}`, wcNoSrc.params);
  const totalErrors = scalar(db,
    `SELECT COUNT(*) AS v FROM api_errors ${wcNoSrc.sql}`, wcNoSrc.params);
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
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);
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
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);
  const rows = query(db,
    `SELECT model,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens
     FROM api_requests ${wc.sql}
     GROUP BY model
     ORDER BY cost DESC`, wc.params);
  res.json(rows);
});

// ── Usage by user ───────────────────────────────────────────────────────────
router.get("/stats/by-user", async (req, res) => {
  const db = await getDb();
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);
  const rows = query(db,
    `SELECT user_email,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens,
            COUNT(DISTINCT session_id) AS sessions
     FROM api_requests ${wc.sql}
     GROUP BY user_email
     ORDER BY cost DESC`, wc.params);

  // Per-user, per-model breakdown — drives both the "top model" column and the
  // expandable per-model sub-rows in the Usage by user table.
  const modelRows = query(db,
    `SELECT user_email, model,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
                + COALESCE(cache_read_tokens,0) + COALESCE(cache_creation_tokens,0)) AS total_tokens
     FROM api_requests ${wc.sql}
     GROUP BY user_email, model
     ORDER BY user_email, total_tokens DESC`, wc.params);

  const topModelByUser = {};
  const modelsByUser = {};
  for (const r of modelRows) {
    if (!topModelByUser[r.user_email]) {
      topModelByUser[r.user_email] = { model: r.model, tokens: r.total_tokens };
    }
    if (!modelsByUser[r.user_email]) modelsByUser[r.user_email] = [];
    modelsByUser[r.user_email].push({
      model: r.model,
      requests: r.requests,
      cost: r.cost,
      total_tokens: r.total_tokens,
    });
  }
  for (const r of rows) {
    const tm = topModelByUser[r.user_email];
    r.top_model = tm?.model || null;
    r.top_model_tokens = tm?.tokens || 0;
    r.models = modelsByUser[r.user_email] || [];
  }

  await maskRows(rows);
  res.json(rows);
});

// ── Tool usage breakdown ────────────────────────────────────────────────────
router.get("/stats/tools", async (req, res) => {
  const db = await getDb();
  const { from, to } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, null, "tool_uses");
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
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);
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
  const audience = await parseAudience(db, req);

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
            input_tokens, output_tokens, source
     FROM api_requests ${userWhere}
     UNION ALL
     SELECT 'tool_use', timestamp, user_email, tool_name, duration_ms, session_id,
            NULL, NULL, NULL
     FROM tool_uses ${userWhere}
     UNION ALL
     SELECT 'prompt', timestamp, user_email, NULL, prompt_length, session_id,
            NULL, NULL, NULL
     FROM user_prompts ${userWhere}
     UNION ALL
     SELECT 'error', timestamp, user_email, error_message, status_code, session_id,
            NULL, NULL, NULL
     FROM api_errors ${userWhere}
     ORDER BY timestamp DESC
     LIMIT ?`,
    [...userParams, ...userParams, ...userParams, ...userParams, limit]);
  await maskRows(rows);
  res.json(rows);
});

// ── Sessions list ───────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  const db = await getDb();
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);
  const rows = query(db,
    `SELECT session_id,
            user_email,
            MIN(timestamp) AS started,
            MAX(timestamp) AS ended,
            COUNT(*) AS requests,
            SUM(cost_usd) AS cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            GROUP_CONCAT(DISTINCT model) AS models
     FROM api_requests ${wc.sql}
     GROUP BY session_id
     ORDER BY started DESC
     LIMIT 100`, wc.params);
  await maskRows(rows);
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
  await maskRows(rows);
  // After masking, sort aliases naturally so USER-2 < USER-10.
  const out = rows.map(r => r.user_email);
  if (isObscureMode()) {
    out.sort((a, b) => {
      const na = parseInt((a || "").slice(5), 10);
      const nb = parseInt((b || "").slice(5), 10);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
  }
  res.json(out);
});

// ── Plan config CRUD ────────────────────────────────────────────────────────
router.get("/plan-config", async (req, res) => {
  const db = await getDb();
  const rows = query(db, "SELECT * FROM plan_config LIMIT 1");
  const apiKey = await getAdminApiKey();
  // Unify imported org_members with any user we've seen in telemetry so the
  // settings page can flip billing_model on users that were never CSV-imported.
  const members = query(db, `
    SELECT email, name, seat_tier, billing_model, status, imported_at, source
    FROM (
      SELECT email, name, seat_tier,
             COALESCE(billing_model, 'seat') AS billing_model,
             status, imported_at, 'imported' AS source
      FROM org_members
      UNION
      SELECT DISTINCT ar.user_email AS email, NULL AS name, NULL AS seat_tier,
             'seat' AS billing_model, NULL AS status, NULL AS imported_at,
             'telemetry' AS source
      FROM api_requests ar
      WHERE ar.user_email IS NOT NULL
        AND LOWER(ar.user_email) NOT IN (SELECT LOWER(email) FROM org_members)
    )
    ORDER BY COALESCE(name, email)
  `);
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
    standard_seat_included_usd = null,
    standard_seat_overage_pct = 0,
    premium_seat_included_usd = null,
    premium_seat_overage_pct = 0,
    commitment_amount_usd = null,
    commitment_start_date = null,
    commitment_end_date = null,
    commitment_discount_pct = 0,
    admin_api_key,
  } = req.body || {};

  const now = new Date().toISOString();
  const existing = query(db, "SELECT id FROM plan_config LIMIT 1");
  const day = Math.min(28, Math.max(1, billing_cycle_day));
  const commitAmt = commitment_amount_usd === null || commitment_amount_usd === "" ? null : Number(commitment_amount_usd);
  const discount = Math.min(100, Math.max(0, Number(commitment_discount_pct) || 0));
  const startDate = commitment_start_date || null;
  const endDate = commitment_end_date || null;
  const stdIncluded = standard_seat_included_usd === null || standard_seat_included_usd === "" ? null : Number(standard_seat_included_usd);
  const premIncluded = premium_seat_included_usd === null || premium_seat_included_usd === "" ? null : Number(premium_seat_included_usd);
  const stdOver = Math.min(100, Math.max(0, Number(standard_seat_overage_pct) || 0));
  const premOver = Math.min(100, Math.max(0, Number(premium_seat_overage_pct) || 0));

  if (existing.length > 0) {
    db.run(
      `UPDATE plan_config SET billing_cycle_day=?, standard_seat_cost_usd=?,
       premium_seat_cost_usd=?, standard_seat_included_usd=?, standard_seat_overage_pct=?,
       premium_seat_included_usd=?, premium_seat_overage_pct=?,
       commitment_amount_usd=?, commitment_start_date=?,
       commitment_end_date=?, commitment_discount_pct=?, updated_at=? WHERE id=?`,
      [day, standard_seat_cost_usd, premium_seat_cost_usd,
       stdIncluded, stdOver, premIncluded, premOver,
       commitAmt, startDate, endDate, discount, now, existing[0].id]
    );
  } else {
    db.run(
      `INSERT INTO plan_config (billing_cycle_day, standard_seat_cost_usd,
       premium_seat_cost_usd, standard_seat_included_usd, standard_seat_overage_pct,
       premium_seat_included_usd, premium_seat_overage_pct,
       commitment_amount_usd, commitment_start_date,
       commitment_end_date, commitment_discount_pct, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [day, standard_seat_cost_usd, premium_seat_cost_usd,
       stdIncluded, stdOver, premIncluded, premOver,
       commitAmt, startDate, endDate, discount, now, now]
    );
  }

  if (admin_api_key !== undefined) {
    await setAdminApiKey(admin_api_key);
  }

  persist();
  res.json({ ok: true });
});

// Upsert a single member's billing_model and/or seat_tier from the Settings UI.
// If the email hasn't been CSV-imported yet (just seen in telemetry), we create
// an org_members row on the fly so the choice sticks. Either field may be
// omitted to leave it unchanged.
router.patch("/members/:email", async (req, res) => {
  const incoming = decodeURIComponent(req.params.email);
  const body = req.body || {};
  const updates = {};

  if (body.billing_model !== undefined) {
    const bm = String(body.billing_model).toLowerCase();
    if (!["seat", "enterprise"].includes(bm)) {
      return res.status(400).json({ error: "billing_model must be 'seat' or 'enterprise'" });
    }
    updates.billing_model = bm;
  }
  if (body.seat_tier !== undefined) {
    const t = String(body.seat_tier);
    if (!["Standard", "Premium"].includes(t)) {
      return res.status(400).json({ error: "seat_tier must be 'Standard' or 'Premium'" });
    }
    updates.seat_tier = t;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No update fields provided" });
  }

  const db = await getDb();
  const email = await unmaskFilter(incoming);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO org_members (email, billing_model, seat_tier, imported_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       billing_model = COALESCE(?, org_members.billing_model),
       seat_tier     = COALESCE(?, org_members.seat_tier)`,
    [
      email,
      updates.billing_model || 'seat',
      updates.seat_tier || null,
      now,
      updates.billing_model ?? null,
      updates.seat_tier ?? null,
    ]
  );
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
  const iStatus = col("status"), iTier = col("seat tier"), iModel = col("billing model");

  if (iEmail === -1) return res.status(400).json({ error: "CSV missing Email column" });

  const db = await getDb();
  const now = new Date().toISOString();
  let upserted = 0;

  for (const line of lines.slice(1)) {
    const cells = line.split(",").map(c => c.trim());
    const email = cells[iEmail];
    if (!email) continue;

    // billing_model: only override existing values when the CSV column was provided
    // AND non-empty, so UI edits aren't clobbered by a re-import that omits the column.
    const rawModel = iModel >= 0 ? (cells[iModel] || "").trim().toLowerCase() : "";
    const csvProvidedModel = iModel >= 0 && rawModel !== "";
    const billingModel = rawModel === "enterprise" ? "enterprise" : "seat";

    db.run(
      `INSERT INTO org_members (email, name, role, status, seat_tier, billing_model, imported_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET
         name=excluded.name, role=excluded.role, status=excluded.status,
         seat_tier=excluded.seat_tier,
         billing_model=CASE WHEN ? = 1 THEN excluded.billing_model ELSE org_members.billing_model END,
         imported_at=excluded.imported_at`,
      [
        email,
        iName >= 0 ? cells[iName] || null : null,
        iRole >= 0 ? cells[iRole] || null : null,
        iStatus >= 0 ? cells[iStatus] || null : null,
        iTier >= 0 ? cells[iTier] || null : null,
        billingModel,
        now,
        csvProvidedModel ? 1 : 0,
      ]
    );
    upserted++;
  }

  persist();
  const members = query(db, "SELECT email, name, seat_tier, billing_model, status, imported_at FROM org_members ORDER BY name");
  res.json({ ok: true, upserted, members });
});

// ── 5-hour session windows ──────────────────────────────────────────────────
router.get("/stats/session-windows", async (req, res) => {
  const db = await getDb();
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);

  // Roll requests up to 5-hour (18000s) gap-based windows per user, then
  // aggregate those windows to per-user totals — all in SQL. We deliberately
  // do NOT return the raw per-window rows (thousands of them); the dashboard
  // only needs per-user rollups + a global summary, so shipping every window
  // is what previously ballooned memory and payload size.
  const perUser = query(db, windowStatsSql(wc.sql, 18000), wc.params);

  await maskRows(perUser);
  res.json({ summary: computeWindowSummary(perUser), per_user: perUser });
});

// ── Billing period summary (informational, no overage guessing) ─────────────
router.get("/stats/billing-summary", async (req, res) => {
  const db = await getDb();
  const configRows = query(db, "SELECT * FROM plan_config LIMIT 1");
  const config = configRows[0] || {
    billing_cycle_day: 1,
    standard_seat_cost_usd: 20,
    premium_seat_cost_usd: 100,
    commitment_amount_usd: null,
    commitment_start_date: null,
    commitment_end_date: null,
    commitment_discount_pct: 0,
  };
  const period = getBillingPeriod(config.billing_cycle_day);
  const discountFactor = 1 - (Number(config.commitment_discount_pct) || 0) / 100;

  // Per-user spend in this billing period (seat users keep the prorated-plan
  // calc on the client; enterprise users contribute to the commitment pool)
  const byUser = query(db,
    `SELECT ar.user_email,
            COALESCE(m.name, ar.user_email) AS name,
            COALESCE(m.seat_tier, 'Standard') AS seat_tier,
            COALESCE(m.billing_model, 'seat') AS billing_model,
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
    // Effective cost = list × (1 - discount). Only meaningful for enterprise
    // users (seat users get the prorated-plan calc instead) but cheap to compute.
    u.effective_cost = Math.round((u.api_equivalent_cost || 0) * discountFactor * 10000) / 10000;
  }

  // Commitment pool: list-price cost across only enterprise-billed users in
  // the configured commitment window (falls back to the billing period if
  // commitment dates aren't set, so the UI still has something to show).
  let commitment = null;
  if (config.commitment_amount_usd && config.commitment_amount_usd > 0) {
    const start = config.commitment_start_date || period.start.slice(0, 10);
    const end = config.commitment_end_date || period.end.slice(0, 10);
    const startIso = start.length === 10 ? start + "T00:00:00.000Z" : start;
    const endIso = end.length === 10 ? end + "T23:59:59.999Z" : end;

    const poolRow = query(db,
      `SELECT COALESCE(SUM(ar.cost_usd), 0) AS list_cost
       FROM api_requests ar
       LEFT JOIN org_members m ON LOWER(ar.user_email) = LOWER(m.email)
       WHERE ar.timestamp >= ? AND ar.timestamp < ?
         AND COALESCE(m.billing_model, 'seat') = 'enterprise'`,
      [startIso, endIso])[0] || { list_cost: 0 };

    const consumedEffective = (poolRow.list_cost || 0) * discountFactor;
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);
    const now = new Date();
    const msPerDay = 86400000;
    const totalDays = Math.max(1, Math.round((endDate - startDate) / msPerDay));
    const daysElapsed = Math.max(0, Math.min(totalDays, Math.round((now - startDate) / msPerDay)));
    const daysRemaining = Math.max(0, totalDays - daysElapsed);
    const expectedSoFar = (config.commitment_amount_usd * daysElapsed) / totalDays;

    commitment = {
      amount_usd: config.commitment_amount_usd,
      discount_pct: Number(config.commitment_discount_pct) || 0,
      start: startIso,
      end: endIso,
      list_consumed: Math.round((poolRow.list_cost || 0) * 100) / 100,
      consumed: Math.round(consumedEffective * 100) / 100,
      remaining: Math.round((config.commitment_amount_usd - consumedEffective) * 100) / 100,
      pct_consumed: config.commitment_amount_usd > 0
        ? Math.round((consumedEffective / config.commitment_amount_usd) * 1000) / 10
        : 0,
      total_days: totalDays,
      days_elapsed: daysElapsed,
      days_remaining: daysRemaining,
      expected_so_far: Math.round(expectedSoFar * 100) / 100,
      // Positive = ahead of pace (burning faster than commitment supports);
      // negative = behind pace (risk of under-utilising the commit).
      pace_delta: Math.round((consumedEffective - expectedSoFar) * 100) / 100,
    };
  }

  // Mask both user_email and the joined-from-org_members `name` so privacy
  // isn't leaked through the friendly name column.
  await maskRows(byUser, ["user_email", "name"]);

  res.json({
    billing_period: period,
    seat_costs: {
      standard: config.standard_seat_cost_usd,
      premium: config.premium_seat_cost_usd,
      // included_usd defaults to the base seat cost when unset, matching the
      // "no overage" assumption (subscription covers exactly what you pay for).
      standard_included: config.standard_seat_included_usd ?? config.standard_seat_cost_usd,
      premium_included: config.premium_seat_included_usd ?? config.premium_seat_cost_usd,
      standard_overage_pct: config.standard_seat_overage_pct ?? 0,
      premium_overage_pct: config.premium_seat_overage_pct ?? 0,
    },
    commitment,
    total_api_equivalent_cost: Math.round(totalCost * 100) / 100,
    total_tokens: totalTokens,
    by_user: byUser,
  });
});

// ── 7-day weekly rolling windows ────────────────────────────────────────────
router.get("/stats/weekly-windows", async (req, res) => {
  const db = await getDb();
  const { from, to, source } = req.query;
  const audience = await parseAudience(db, req);
  const wc = whereClause(from, to, audience, source);

  // Same gap-based approach as the 5-hour windows but with a 7-day (604800s)
  // threshold, aggregated to per-user totals in SQL (see session-windows note).
  const perUser = query(db, windowStatsSql(wc.sql, 604800), wc.params);

  await maskRows(perUser);
  res.json({ summary: computeWindowSummary(perUser), per_user: perUser });
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

    await maskRows(users, ["email"], "email");

    res.json({ available: true, billing_period: period, users });
  } catch (err) {
    console.error("[admin] per-user-cost error:", err.message);
    res.json({ available: false, error: err.message });
  }
});

// ── Ingest token status (read-only; configured via INGEST_TOKEN env) ────────
router.get("/ingest-token", (req, res) => {
  const value = process.env.INGEST_TOKEN || null;
  res.json({ set: !!value, value });
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

// ── Bedrock config & sync ───────────────────────────────────────────────────
router.get("/bedrock/config", async (req, res) => {
  try {
    const cfg = await getBedrockConfig();
    res.json({
      region:              cfg.region || "",
      logGroupName:        cfg.logGroupName || "",
      pollIntervalMinutes: cfg.pollIntervalMinutes || 0,
      lastSyncTime:        cfg.lastSyncTime || null,
      hasCredentials:      !!(cfg.accessKeyId && cfg.secretAccessKey),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/bedrock/config", async (req, res) => {
  try {
    const {
      access_key_id,
      secret_access_key,
      session_token,
      region,
      log_group_name,
      poll_interval_minutes,
    } = req.body || {};

    const updates = {};
    if (region              !== undefined) updates.region              = region;
    if (log_group_name      !== undefined) updates.logGroupName        = log_group_name;
    if (poll_interval_minutes !== undefined) updates.pollIntervalMinutes = String(poll_interval_minutes);
    if (access_key_id       !== undefined) updates.accessKeyId         = access_key_id;
    if (secret_access_key   !== undefined) updates.secretAccessKey     = secret_access_key;
    if (session_token       !== undefined) updates.sessionToken        = session_token;

    await setBedrockConfig(updates);
    await startBedrockPoller();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/bedrock/sync", async (req, res) => {
  try {
    const result = await syncBedrockLogs();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Teams CRUD ──────────────────────────────────────────────────────────────
router.get("/teams", async (req, res) => {
  const db = await getDb();
  const teams = query(db, `SELECT id, name, created_at FROM teams ORDER BY name`);
  const members = query(db, `SELECT team_id, user_email FROM team_members ORDER BY user_email`);
  // Mask members under OBSCURE_USERS so settings shows aliases consistently with /api/users.
  await maskRows(members);
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
  const incoming = (req.body?.email || "").trim();
  if (!incoming) return res.status(400).json({ error: "Email required" });

  const db = await getDb();
  const team = query(db, `SELECT id FROM teams WHERE id = ?`, [id])[0];
  if (!team) return res.status(404).json({ error: "Team not found" });

  // Store the real email even if the client sent an alias (under OBSCURE_USERS),
  // so audience filtering can match api_requests.user_email directly.
  const email = await unmaskFilter(incoming);

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
  const incoming = decodeURIComponent(req.params.email);
  const email = await unmaskFilter(incoming);
  const db = await getDb();
  db.run(`DELETE FROM team_members WHERE team_id = ? AND user_email = ?`, [id, email]);
  persist();
  res.json({ ok: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
// `audience` is either null (no user filter) or an array of emails.
// Empty array means "filter to nobody" → emit 1=0 so the result is empty.
// `source` filters api_requests.source ("anthropic"/"bedrock"/"claude_code"),
// only when querying the api_requests table.
function whereClause(from, to, audience, source, table = "api_requests") {
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

  if (source && source !== "all" && table === "api_requests") {
    if (source === "claude_code") {
      conds.push("(source = 'claude_code' OR source IS NULL)");
    } else {
      conds.push("source = ?"); params.push(source);
    }
  }

  const sql = conds.length ? "WHERE " + conds.join(" AND ") : "";
  return { sql, params };
}

// Resolves `?users=a@b,c@d` and `?teams=1,3` into a flat email array.
// Returns null when neither is set (meaning: no user filter).
// Returns [] when filters were sent but resolve to no emails (meaning: filter to nobody).
// Each value is run through unmaskFilter so callers under OBSCURE_USERS can pass aliases.
async function parseAudience(db, req) {
  const usersParam = req.query.users;
  const teamsParam = req.query.teams;

  if (!usersParam && !teamsParam) return null;

  const raw = new Set();
  if (usersParam) {
    String(usersParam).split(",").map(s => s.trim()).filter(Boolean).forEach(e => raw.add(e));
  }
  if (teamsParam) {
    const ids = String(teamsParam).split(",")
      .map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = query(db,
        `SELECT DISTINCT user_email FROM team_members WHERE team_id IN (${placeholders})`,
        ids);
      rows.forEach(r => { if (r.user_email) raw.add(r.user_email); });
    }
  }

  const emails = new Set();
  for (const v of raw) emails.add(await unmaskFilter(v));
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

// Build the gap-based windowing query for a given gap threshold (seconds),
// rolled up to ONE ROW PER USER. The inner per_window CTE groups requests into
// windows (a new window starts whenever the gap since the previous request for
// that user exceeds gapSeconds); the outer select then aggregates each user's
// windows into the rollup the dashboard actually consumes.
function windowStatsSql(whereSql, gapSeconds) {
  return `
    WITH ordered AS (
      SELECT timestamp, user_email, cost_usd, input_tokens, output_tokens,
        ROUND((julianday(timestamp) - julianday(
          LAG(timestamp) OVER (PARTITION BY user_email ORDER BY timestamp)
        )) * 86400) AS gap_seconds
      FROM api_requests ${whereSql}
    ),
    windowed AS (
      SELECT *,
        SUM(CASE WHEN gap_seconds IS NULL OR gap_seconds > ${gapSeconds} THEN 1 ELSE 0 END)
          OVER (PARTITION BY user_email ORDER BY timestamp) AS window_id
      FROM ordered
    ),
    per_window AS (
      SELECT user_email, window_id,
        SUM(cost_usd) AS total_cost,
        SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS total_tokens,
        COUNT(*) AS request_count,
        (julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 24 AS duration_hours
      FROM windowed
      GROUP BY user_email, window_id
    )
    SELECT user_email,
      COUNT(*) AS window_count,
      ROUND(SUM(total_cost), 6) AS total_cost,
      SUM(total_tokens) AS total_tokens,
      SUM(request_count) AS total_requests,
      ROUND(SUM(duration_hours), 4) AS total_hours
    FROM per_window
    GROUP BY user_email
    ORDER BY total_cost DESC
  `;
}

// Derive the global summary from the per-user rollups (≈55 rows). Note that
// active-hours and total-hours are identical here: zero-duration windows
// contribute 0 either way, so there's no need to track them separately.
function computeWindowSummary(perUser) {
  let totalWindows = 0, totalCost = 0, totalTokens = 0, totalRequests = 0, totalActiveHours = 0;
  for (const u of perUser) {
    totalWindows += u.window_count || 0;
    totalCost += u.total_cost || 0;
    totalTokens += u.total_tokens || 0;
    totalRequests += u.total_requests || 0;
    totalActiveHours += u.total_hours || 0;
  }
  const n = totalWindows;
  return {
    total_windows: n,
    avg_cost_per_window: n ? totalCost / n : 0,
    avg_tokens_per_window: n ? Math.round(totalTokens / n) : 0,
    avg_requests_per_window: n ? Math.round(totalRequests / n) : 0,
    avg_duration_hours: n ? Math.round((totalActiveHours / n) * 100) / 100 : 0,
    avg_cost_per_active_hour: totalActiveHours > 0
      ? Math.round((totalCost / totalActiveHours) * 100) / 100
      : null,
    total_cost: Math.round(totalCost * 100) / 100,
    total_active_hours: Math.round(totalActiveHours * 100) / 100,
  };
}

module.exports = router;
