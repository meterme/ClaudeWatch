const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "usage.db");

let db = null;

// ── sql.js compatibility shim ────────────────────────────────────────────────
// The codebase was written against sql.js's statement API (db.run(sql, params),
// db.prepare(sql) → { bind, step, getAsObject, free }). better-sqlite3 has a
// different, native API. Rather than rewrite ~130 call sites, we wrap a
// better-sqlite3 Database so the existing API keeps working — the real win is
// that queries now execute natively against an on-disk file instead of running
// inside a full copy of the DB held in the V8 heap (sql.js's model, which was
// the source of the memory exhaustion).

// better-sqlite3 is strict about bound values: it throws on undefined and
// booleans, whereas sql.js silently coerced them. Normalize to match the old
// lenient behaviour so existing inserts don't start throwing.
function normParams(params) {
  if (params == null) return [];
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

class StmtShim {
  constructor(stmt) {
    this._stmt = stmt;
    this._params = [];
    this._rows = null;
    this._i = 0;
    this._row = undefined;
  }
  bind(params) {
    this._params = normParams(params);
    this._rows = null;
    this._i = 0;
    return true;
  }
  // Materialize on first step (sql.js materialized results too). Using .all()
  // rather than .iterate() avoids leaving the connection in a "busy" state when
  // callers step once and free without exhausting the cursor.
  step() {
    if (this._rows === null) { this._rows = this._stmt.all(...this._params); this._i = 0; }
    if (this._i >= this._rows.length) { this._row = undefined; return false; }
    this._row = this._rows[this._i++];
    return true;
  }
  getAsObject() { return this._row || {}; }
  free() { this._rows = null; this._i = 0; }
}

class DbShim {
  constructor(real) {
    this._db = real;
    this._runCache = new Map(); // cache write statements by SQL (reused in loops)
  }
  prepare(sql) { return new StmtShim(this._db.prepare(sql)); }
  run(sql, params = []) {
    let stmt = this._runCache.get(sql);
    if (!stmt) { stmt = this._db.prepare(sql); this._runCache.set(sql, stmt); }
    stmt.run(...normParams(params));
    return this;
  }
  // sql.js-style exec(): returns [] when there are no result rows, otherwise
  // [{ columns, values }] (one entry per result-bearing statement). Callers
  // check `res.length` / `res[0].values.length`, so both shapes are handled.
  exec(sql, params = []) {
    let stmt;
    try {
      stmt = this._db.prepare(sql);
    } catch (_) {
      // Multi-statement / DDL that prepare() rejects: run natively, no results.
      this._db.exec(sql);
      return [];
    }
    if (!stmt.reader) { stmt.run(...normParams(params)); return []; }
    const columns = stmt.columns().map((c) => c.name);
    const values = stmt.raw().all(...normParams(params));
    return values.length ? [{ columns, values }] : [];
  }
  pragma(...args) { return this._db.pragma(...args); }
}

function getDb() {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const real = new Database(DB_PATH);
  real.pragma("journal_mode = WAL");   // concurrent reads, durable writes
  real.pragma("synchronous = NORMAL");
  db = new DbShim(real);

  migrate(db);
  return db;
}

// better-sqlite3 writes to disk on every statement, so there's nothing to flush.
// Kept as a no-op so existing `persist()` call sites don't need to change.
function persist() {}

function migrate(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS api_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      session_id    TEXT,
      prompt_id     TEXT,
      user_email    TEXT,
      user_id       TEXT,
      org_id        TEXT,
      model         TEXT,
      cost_usd      REAL,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cache_read_tokens  INTEGER,
      cache_creation_tokens INTEGER,
      duration_ms   INTEGER,
      app_version   TEXT,
      terminal_type TEXT,
      response_content TEXT
    )
  `);

  // Add response_content if upgrading from older schema
  try { db.run(`ALTER TABLE api_requests ADD COLUMN response_content TEXT`); } catch (_) {}
  // Bedrock: identify the event source and deduplicate by AWS request ID
  try { db.run(`ALTER TABLE api_requests ADD COLUMN source TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE api_requests ADD COLUMN aws_request_id TEXT`); } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      session_id    TEXT,
      prompt_id     TEXT,
      user_email    TEXT,
      user_id       TEXT,
      org_id        TEXT,
      tool_name     TEXT,
      success       INTEGER,
      duration_ms   INTEGER,
      error         TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      session_id    TEXT,
      prompt_id     TEXT,
      user_email    TEXT,
      user_id       TEXT,
      org_id        TEXT,
      prompt_length INTEGER,
      prompt_content TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS api_errors (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      session_id    TEXT,
      prompt_id     TEXT,
      user_email    TEXT,
      user_id       TEXT,
      org_id        TEXT,
      error_message TEXT,
      status_code   INTEGER,
      retries       INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tool_decisions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      session_id    TEXT,
      prompt_id     TEXT,
      user_email    TEXT,
      user_id       TEXT,
      org_id        TEXT,
      tool_name     TEXT,
      decision      TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS plan_config (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      billing_cycle_day         INTEGER NOT NULL DEFAULT 1,
      standard_seat_cost_usd    REAL NOT NULL DEFAULT 20.0,
      premium_seat_cost_usd     REAL NOT NULL DEFAULT 100.0,
      commitment_amount_usd     REAL,
      commitment_start_date     TEXT,
      commitment_end_date       TEXT,
      commitment_discount_pct   REAL NOT NULL DEFAULT 0,
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    )
  `);

  // Add new columns if upgrading from previous schema (ignore errors if already exist)
  try { db.run(`ALTER TABLE plan_config ADD COLUMN standard_seat_cost_usd REAL NOT NULL DEFAULT 20.0`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN premium_seat_cost_usd REAL NOT NULL DEFAULT 100.0`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN commitment_amount_usd REAL`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN commitment_start_date TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN commitment_end_date TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN commitment_discount_pct REAL NOT NULL DEFAULT 0`); } catch (_) {}
  // Per-tier overage model: included_usd is the $ of list-price API value
  // included in the seat (NULL → defaults to the base seat cost). overage_pct
  // is the % of list price applied above the included cap (0 = rate-limited,
  // 100 = full list spillover, anything in between = negotiated discount).
  try { db.run(`ALTER TABLE plan_config ADD COLUMN standard_seat_included_usd REAL`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN standard_seat_overage_pct REAL NOT NULL DEFAULT 0`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN premium_seat_included_usd REAL`); } catch (_) {}
  try { db.run(`ALTER TABLE plan_config ADD COLUMN premium_seat_overage_pct REAL NOT NULL DEFAULT 0`); } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS org_members (
      email         TEXT PRIMARY KEY,
      name          TEXT,
      role          TEXT,
      status        TEXT,
      seat_tier     TEXT,
      billing_model TEXT NOT NULL DEFAULT 'seat',
      imported_at   TEXT NOT NULL
    )
  `);
  try { db.run(`ALTER TABLE org_members ADD COLUMN billing_model TEXT NOT NULL DEFAULT 'seat'`); } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_aliases (
      email      TEXT PRIMARY KEY,
      alias      TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS teams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT UNIQUE NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id     INTEGER NOT NULL,
      user_email  TEXT NOT NULL,
      PRIMARY KEY (team_id, user_email)
    )
  `);

  // One-time backfill: strip Bedrock cross-region inference profile prefixes
  // ("us.", "eu.", "apac.", etc.) and the "anthropic." prefix from existing
  // api_requests.model so historical rows match the canonical form written by
  // normalizeModelId() going forward.
  const flagRes = db.exec(
    "SELECT 1 FROM config WHERE key = 'model_ids_normalized_v1'"
  );
  const alreadyNormalized = flagRes.length > 0 && flagRes[0].values.length > 0;
  if (!alreadyNormalized) {
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 4)  WHERE model LIKE 'us.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 4)  WHERE model LIKE 'eu.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 6)  WHERE model LIKE 'apac.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 4)  WHERE model LIKE 'ap.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 4)  WHERE model LIKE 'ca.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 4)  WHERE model LIKE 'sa.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 4)  WHERE model LIKE 'af.%'`);
    db.run(`UPDATE api_requests SET model = SUBSTR(model, 11) WHERE model LIKE 'anthropic.%'`);
    db.run(
      `INSERT INTO config (key, value) VALUES ('model_ids_normalized_v1', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`
    );
  }

  // Indexes for common query patterns
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_ts ON api_requests(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_user ON api_requests(user_email)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_model ON api_requests(model)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_uses_ts ON tool_uses(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_prompts_ts ON user_prompts(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_user_ts ON api_requests(user_email, timestamp)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_req_aws_rid ON api_requests(aws_request_id) WHERE aws_request_id IS NOT NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_source ON api_requests(source)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_aliases_alias ON user_aliases(alias)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(user_email)`);
  // Session-detail / join paths (/sessions/:id stitches these tables by id)
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_session ON api_requests(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_prompt ON api_requests(prompt_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_uses_session ON tool_uses(session_id)`);

  persist();
}

module.exports = { getDb, persist };
