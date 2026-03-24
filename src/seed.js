const { getDb, persist } = require("./db");

const USERS = [
  "alice@example.com",
  "bob@example.com",
  "carol@example.com",
  "dave@example.com",
  "eve@example.com",
];

const MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
];

const TOOLS = [
  "Read", "Edit", "Write", "Bash", "Grep", "Glob",
  "Agent", "WebSearch", "WebFetch", "NotebookEdit",
];

const SAMPLE_CONVERSATIONS = [
  { prompt: "Fix the login form validation — it allows empty passwords", response: "I'll fix the login validation. The issue is in `src/auth/LoginForm.tsx` where the password field check is missing.\n\nI've updated the `handleSubmit` function to validate that the password is non-empty and meets the minimum length requirement before submitting." },
  { prompt: "Add a dark mode toggle to the settings page", response: "I've added a dark mode toggle to the settings page. Changes:\n\n1. Created a `useTheme` hook in `src/hooks/useTheme.ts`\n2. Added a toggle switch component in the settings layout\n3. Updated CSS variables to support both light and dark themes\n\nThe preference is persisted to localStorage." },
  { prompt: "Why is the API response time so slow on the /users endpoint?", response: "The `/users` endpoint is slow because it's making N+1 queries — fetching each user's profile separately. I've refactored it to use a single JOIN query with eager loading, which should reduce response time from ~800ms to ~50ms." },
  { prompt: "Write unit tests for the payment processing module", response: "I've added 12 unit tests covering:\n\n- Successful payment processing\n- Insufficient funds handling\n- Invalid card number validation\n- Currency conversion edge cases\n- Retry logic on network failures\n- Webhook notification delivery\n\nAll tests pass. Run them with `npm test -- --grep payment`." },
  { prompt: "Refactor the database connection pool to use async/await", response: "Refactored the connection pool from callbacks to async/await. Key changes:\n\n- `db.getConnection(callback)` → `await db.getConnection()`\n- Added proper error handling with try/finally for connection release\n- Updated all 14 files that use the pool\n- Connection timeout is now configurable via `DB_POOL_TIMEOUT` env var." },
  { prompt: "Can you help me understand how the caching layer works?", response: "The caching layer uses a two-tier approach:\n\n1. **L1 (in-memory)**: An LRU cache (`src/cache/memory.ts`) with a 5-minute TTL and 1000-entry limit. Checked first on every read.\n\n2. **L2 (Redis)**: For cache misses, falls back to Redis with a 1-hour TTL. Results are promoted back to L1.\n\nCache invalidation happens via pub/sub — when a write occurs, a message is broadcast so all instances flush their L1 for that key." },
  { prompt: "Deploy the staging branch to the preview environment", response: "I've triggered the deployment pipeline for the staging branch:\n\n- Build: completed (2m 14s)\n- Tests: all 247 passing\n- Preview URL: https://staging-preview.example.com\n\nThe deployment should be live within 3 minutes." },
  { prompt: "Add rate limiting to the public API endpoints", response: "Added rate limiting using a sliding window algorithm:\n\n- Default: 100 requests/minute per API key\n- Auth endpoints: 10 requests/minute per IP\n- Headers added: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`\n- Backed by Redis for distributed state\n\nUpdated the API docs with the new rate limit information." },
  { prompt: "There's a memory leak in the WebSocket handler", response: "Found the leak — event listeners weren't being cleaned up on disconnect. In `src/ws/handler.ts`, the `onMessage` and `onError` listeners were attached but never removed when the socket closed.\n\nFixed by storing listener references and calling `removeListener` in the `close` handler. Also added a periodic check that force-closes stale connections older than 30 minutes." },
  { prompt: "Set up the CI pipeline for the new microservice", response: "CI pipeline configured in `.github/workflows/service-orders.yml`:\n\n1. **Lint & typecheck** — runs on every push\n2. **Unit tests** — parallel matrix across Node 18/20\n3. **Integration tests** — spins up Postgres + Redis via services\n4. **Docker build** — builds and pushes to ECR on main branch\n5. **Deploy** — auto-deploys to staging, manual approval for prod\n\nFirst run succeeded — you can see it in the Actions tab." },
  { prompt: "Optimize the search query — it times out on large datasets", response: "The search was doing a full table scan with LIKE '%term%'. I've made three changes:\n\n1. Added a GIN trigram index on the `name` and `description` columns\n2. Switched to `ts_vector` full-text search for multi-word queries\n3. Added pagination with cursor-based navigation instead of OFFSET\n\nQuery time dropped from 12s to 45ms on the 2M-row test dataset." },
  { prompt: "Create a migration to add soft deletes to the orders table", response: "Created migration `20240315_add_soft_deletes_orders.sql`:\n\n- Added `deleted_at TIMESTAMP NULL` column\n- Added partial index on `deleted_at IS NULL` for query performance\n- Updated the `Order` model to include a default scope filtering deleted records\n- Added `restore()` and `forceDelete()` methods to the model\n\nRun with `npm run migrate`." },
];


const MODEL_COST_FACTOR = {
  "claude-sonnet-4-6": 1,
  "claude-opus-4-6": 3.5,
  "claude-haiku-4-5": 0.15,
};

async function seedDemoData() {
  const db = await getDb();
  const now = Date.now();
  const DAY = 86400000;

  for (let d = 29; d >= 0; d--) {
    const dayBase = now - d * DAY;
    // Each user has variable activity per day
    for (const user of USERS) {
      const sessionsToday = 1 + Math.floor(Math.random() * 4);
      for (let s = 0; s < sessionsToday; s++) {
        const sessionId = `sess_${user.split("@")[0]}_d${d}_s${s}`;
        const promptCount = 3 + Math.floor(Math.random() * 12);
        const hourOffset = 8 + Math.floor(Math.random() * 10); // 8am-6pm

        for (let p = 0; p < promptCount; p++) {
          const ts = new Date(dayBase + hourOffset * 3600000 + p * 60000).toISOString();
          const promptId = `p_${d}_${s}_${p}`;
          const model = MODELS[Math.floor(Math.random() * MODELS.length)];
          const inputTokens = 500 + Math.floor(Math.random() * 8000);
          const outputTokens = 200 + Math.floor(Math.random() * 4000);
          const cacheRead = Math.floor(inputTokens * Math.random() * 0.6);
          const cacheCreation = Math.floor(Math.random() * 500);
          const costFactor = MODEL_COST_FACTOR[model];
          const cost = ((inputTokens * 0.000003 + outputTokens * 0.000015) * costFactor);

          const convo = SAMPLE_CONVERSATIONS[Math.floor(Math.random() * SAMPLE_CONVERSATIONS.length)];

          // API request
          db.run(
            `INSERT INTO api_requests
              (timestamp, session_id, prompt_id, user_email, user_id, org_id,
               model, cost_usd, input_tokens, output_tokens,
               cache_read_tokens, cache_creation_tokens, duration_ms,
               app_version, terminal_type, response_content)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [ts, sessionId, promptId, user, user.split("@")[0], "org_demo",
             model, Math.round(cost * 10000) / 10000,
             inputTokens, outputTokens, cacheRead, cacheCreation,
             300 + Math.floor(Math.random() * 5000),
             "1.0.0", Math.random() > 0.5 ? "vscode" : "terminal",
             convo.response]
          );

          // User prompt
          db.run(
            `INSERT INTO user_prompts
              (timestamp, session_id, prompt_id, user_email, user_id, org_id,
               prompt_length, prompt_content)
             VALUES (?,?,?,?,?,?,?,?)`,
            [ts, sessionId, promptId, user, user.split("@")[0], "org_demo",
             convo.prompt.length, convo.prompt]
          );

          // 1-3 tool uses per prompt
          const toolCount = 1 + Math.floor(Math.random() * 3);
          for (let t = 0; t < toolCount; t++) {
            const tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
            const success = Math.random() > 0.05;
            db.run(
              `INSERT INTO tool_uses
                (timestamp, session_id, prompt_id, user_email, user_id, org_id,
                 tool_name, success, duration_ms, error)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
              [ts, sessionId, promptId, user, user.split("@")[0], "org_demo",
               tool, success ? 1 : 0,
               10 + Math.floor(Math.random() * 3000),
               success ? null : "Command failed"]
            );
          }

          // Occasional errors (~3%)
          if (Math.random() < 0.03) {
            db.run(
              `INSERT INTO api_errors
                (timestamp, session_id, prompt_id, user_email, user_id, org_id,
                 error_message, status_code, retries)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [ts, sessionId, promptId, user, user.split("@")[0], "org_demo",
               Math.random() > 0.5 ? "Rate limit exceeded" : "Internal server error",
               Math.random() > 0.5 ? 429 : 500,
               Math.floor(Math.random() * 3)]
            );
          }
        }
      }
    }
  }

  persist();
}

module.exports = { seedDemoData };
