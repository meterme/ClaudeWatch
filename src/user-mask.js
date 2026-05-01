const { getDb, persist } = require("./db");

const ALIAS_PREFIX = "USER-";
const ALIAS_RE = /^USER-\d+$/;

function isObscureMode() {
  return process.env.OBSCURE_USERS === "1";
}

async function aliasFor(email) {
  if (!email) return null;
  const db = await getDb();
  const stmt = db.prepare("SELECT alias FROM user_aliases WHERE email = ?");
  stmt.bind([email]);
  const found = stmt.step() ? stmt.getAsObject().alias : null;
  stmt.free();
  return found;
}

async function emailFor(alias) {
  if (!alias) return null;
  const db = await getDb();
  const stmt = db.prepare("SELECT email FROM user_aliases WHERE alias = ?");
  stmt.bind([alias]);
  const found = stmt.step() ? stmt.getAsObject().email : null;
  stmt.free();
  return found;
}

async function assignAliasIfMissing(email) {
  if (!email) return null;
  const db = await getDb();

  const existing = await aliasFor(email);
  if (existing) return existing;

  const stmt = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(alias, ?) AS INTEGER)), 0) + 1 AS n
     FROM user_aliases`
  );
  stmt.bind([ALIAS_PREFIX.length + 1]); // SUBSTR is 1-indexed
  stmt.step();
  const n = stmt.getAsObject().n;
  stmt.free();

  const alias = `${ALIAS_PREFIX}${n}`;
  const now = new Date().toISOString();
  // INSERT OR IGNORE handles the rare race where two ingests for the same
  // email collide — second loses, both end up resolving to the first alias.
  db.run(
    `INSERT OR IGNORE INTO user_aliases (email, alias, created_at) VALUES (?, ?, ?)`,
    [email, alias, now]
  );
  persist();
  return (await aliasFor(email)) || alias;
}

async function ensureAliasesForAllUsers() {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT DISTINCT user_email AS email FROM api_requests WHERE user_email IS NOT NULL
    UNION
    SELECT DISTINCT user_email FROM tool_uses     WHERE user_email IS NOT NULL
    UNION
    SELECT DISTINCT user_email FROM user_prompts  WHERE user_email IS NOT NULL
    UNION
    SELECT DISTINCT user_email FROM api_errors    WHERE user_email IS NOT NULL
    UNION
    SELECT DISTINCT user_email FROM tool_decisions WHERE user_email IS NOT NULL
  `);
  const emails = [];
  while (stmt.step()) emails.push(stmt.getAsObject().email);
  stmt.free();

  let assigned = 0;
  for (const email of emails) {
    const had = await aliasFor(email);
    if (!had) {
      await assignAliasIfMissing(email);
      assigned++;
    }
  }

  const totalStmt = db.prepare("SELECT COUNT(*) AS v FROM user_aliases");
  totalStmt.step();
  const total = totalStmt.getAsObject().v;
  totalStmt.free();

  console.log(`[user-mask] assigned ${assigned} new alias${assigned === 1 ? "" : "es"} (${total} total)`);
}

// Build a lookup map for a batch of rows so we hit the DB once instead of N times.
async function buildAliasMap(emails) {
  const unique = [...new Set(emails.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const db = await getDb();
  const placeholders = unique.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT email, alias FROM user_aliases WHERE email IN (${placeholders})`
  );
  stmt.bind(unique);
  const map = new Map();
  while (stmt.step()) {
    const r = stmt.getAsObject();
    map.set(r.email, r.alias);
  }
  stmt.free();
  return map;
}

// Replace `keys` in each row with the alias for row.user_email (or row[lookupKey]).
// `keys` defaults to ["user_email"]. Pass extra keys (e.g. "name") for endpoints
// where multiple fields carry the user's identity.
async function maskRows(rows, keys = ["user_email"], lookupKey = "user_email") {
  if (!isObscureMode() || !rows || rows.length === 0) return rows;
  const map = await buildAliasMap(rows.map((r) => r[lookupKey]));
  for (const row of rows) {
    const alias = map.get(row[lookupKey]);
    if (!alias) continue;
    for (const k of keys) {
      if (k in row) row[k] = alias;
    }
  }
  return rows;
}

// Translate a `?user=` filter param. If obscure mode is on and the value
// looks like an alias, swap to the real email; else passthrough.
async function unmaskFilter(value) {
  if (!isObscureMode() || !value) return value;
  if (!ALIAS_RE.test(value)) return value;
  const email = await emailFor(value);
  return email || value;
}

module.exports = {
  isObscureMode,
  aliasFor,
  emailFor,
  assignAliasIfMissing,
  ensureAliasesForAllUsers,
  maskRows,
  unmaskFilter,
};
