const initSQL = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "usage.db");

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSQL();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  migrate(db);
  return db;
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

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

  // Indexes for common query patterns
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_ts ON api_requests(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_user ON api_requests(user_email)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_req_model ON api_requests(model)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tool_uses_ts ON tool_uses(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_prompts_ts ON user_prompts(timestamp)`);

  persist();
}

module.exports = { getDb, persist };
