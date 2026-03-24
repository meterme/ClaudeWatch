const express = require("express");
const path = require("path");
const { ingestOtlpLogs } = require("./otlp");
const apiRouter = require("./api");
const { getDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3456;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ── OTLP HTTP/JSON receiver ─────────────────────────────────────────────────
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

// ── REST API ────────────────────────────────────────────────────────────────
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
    console.log(`
┌─────────────────────────────────────────────┐
│  Claude Usage Monitor                       │
│  Dashboard:  http://localhost:${PORT}          │
│  OTLP recv:  http://localhost:${PORT}/v1/logs  │
└─────────────────────────────────────────────┘
    `);
  });
})();
