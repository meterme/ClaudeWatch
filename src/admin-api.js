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
  if (from) params.set("start_date", from);
  if (to) params.set("end_date", to);

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
  if (from) params.set("start_date", from);
  if (to) params.set("end_date", to);
  if (groupBy) params.set("group_by", groupBy);

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

module.exports = {
  getAdminApiKey,
  setAdminApiKey,
  fetchCostReport,
  fetchUsageReport,
};
