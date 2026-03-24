const express = require("express");
const path = require("path");
const { ingestOtlpLogs } = require("./otlp");
const apiRouter = require("./api");
const { getDb } = require("./db");
const {
  isAuthEnabled,
  authMiddleware,
  loginHandler,
  logoutHandler,
  authCheckHandler,
  loginPageHandler,
} = require("./auth");

const app = express();
const PORT = process.env.PORT || 3456;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));

// ── Auth routes (unauthenticated) ───────────────────────────────────────────
app.get("/login", loginPageHandler);
app.post("/auth/login", loginHandler);
app.post("/auth/logout", logoutHandler);
app.get("/auth/check", authCheckHandler);

// ── OTLP HTTP/JSON receiver (unauthenticated) ──────────────────────────────
// Claude Code sends to: POST /v1/logs
app.post("/v1/logs", async (req, res) => {
  try {
    const count = await ingestOtlpLogs(req.body);
    console.log(`[otlp] ingested ${count} event(s)`);
    // OTLP expects empty 200 on success
    res.status(200).json({});
  } catch (err) {
    console.error("[otlp] ingest error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Also accept the protobuf-style route that some exporters use
app.post("/v1/logs/", async (req, res) => {
  try {
    const count = await ingestOtlpLogs(req.body);
    res.status(200).json({});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auth middleware (everything below requires login) ────────────────────────
app.use(authMiddleware);

// ── Protected static files & API ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/api", apiRouter);

// ── Seed demo data (opt-in via env) ─────────────────────────────────────────
async function maybeSeedDemo() {
  if (process.env.SEED_DEMO !== "1") return;
  const db = await getDb();
  const count = db.prepare("SELECT COUNT(*) AS v FROM api_requests");
  count.step();
  const existing = count.getAsObject().v;
  count.free();
  if (existing > 0) return;

  console.log("[seed] populating demo data...");
  const { seedDemoData } = require("./seed");
  await seedDemoData();
  console.log("[seed] done.");
}

// ── Start ───────────────────────────────────────────────────────────────────
(async () => {
  await getDb(); // ensure DB is initialized
  await maybeSeedDemo();

  app.listen(PORT, () => {
    const auth = isAuthEnabled() ? "enabled" : "disabled (set AUTH_PASS to enable)";
    console.log(`
┌──────────────────────────────────────────────────┐
│  ClaudeWatch                                     │
│  Dashboard:  http://localhost:${PORT}               │
│  OTLP recv:  http://localhost:${PORT}/v1/logs       │
│  Auth:       ${auth.padEnd(35)}│
└──────────────────────────────────────────────────┘
    `);
  });
})();
