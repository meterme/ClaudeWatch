const crypto = require("crypto");
const { getDb, persist } = require("./db");

// ── Config ──────────────────────────────────────────────────────────────────
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isAuthEnabled() {
  return AUTH_PASS.length > 0;
}

// ── Session store (database-backed) ─────────────────────────────────────────
async function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const db = await getDb();
  db.run("INSERT INTO sessions (token, user, created_at) VALUES (?, ?, ?)", [
    token,
    user,
    Date.now(),
  ]);
  persist();
  return token;
}

async function validateSession(token) {
  const db = await getDb();
  const stmt = db.prepare("SELECT user, created_at FROM sessions WHERE token = ?");
  stmt.bind([token]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();

  if (Date.now() - row.created_at > SESSION_TTL_MS) {
    db.run("DELETE FROM sessions WHERE token = ?", [token]);
    persist();
    return null;
  }
  return { user: row.user, createdAt: row.created_at };
}

// ── Cookie helpers ──────────────────────────────────────────────────────────
function signCookie(value) {
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");
  return value + "." + sig;
}

function unsignCookie(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  if (signCookie(value) === signed) return value;
  return null;
}

function parseCookies(header) {
  const m = {};
  if (!header) return m;
  header.split(";").forEach((pair) => {
    const [k, ...v] = pair.trim().split("=");
    if (k) m[k.trim()] = decodeURIComponent(v.join("="));
  });
  return m;
}

function setSessionCookie(res, token) {
  const signed = signCookie(token);
  res.setHeader(
    "Set-Cookie",
    `session_token=${signed}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "session_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  );
}

// ── Middleware ───────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next();

  const cookies = parseCookies(req.headers.cookie);
  const token = unsignCookie(cookies.session_token);
  if (!token) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login");
  }

  validateSession(token).then((session) => {
    if (session) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login");
  });
}

// ── Handlers ────────────────────────────────────────────────────────────────
async function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const userOk =
    username.length === AUTH_USER.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(AUTH_USER));
  const passOk =
    password.length === AUTH_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(AUTH_PASS));

  if (!userOk || !passOk) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = await createSession(username);
  setSessionCookie(res, token);
  res.json({ ok: true });
}

async function logoutHandler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = unsignCookie(cookies.session_token);
  if (token) {
    const db = await getDb();
    db.run("DELETE FROM sessions WHERE token = ?", [token]);
    persist();
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}

async function authCheckHandler(req, res) {
  if (!isAuthEnabled()) return res.json({ authenticated: true, authEnabled: false });
  const cookies = parseCookies(req.headers.cookie);
  const token = unsignCookie(cookies.session_token);
  const session = token ? await validateSession(token) : null;
  res.json({ authenticated: !!session, authEnabled: true });
}

// ── Login page (inline HTML) ────────────────────────────────────────────────
function loginPageHandler(req, res) {
  if (!isAuthEnabled()) return res.redirect("/");
  res.type("html").send(LOGIN_HTML);
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — ClaudeWatch</title>
  <style>
    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --surface2: #242736;
      --border: #2e3142;
      --text: #e1e4ed;
      --text-dim: #8b8fa3;
      --accent: #6366f1;
      --accent2: #818cf8;
      --red: #ef4444;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 36px 32px;
      width: 100%;
      max-width: 380px;
    }
    .login-card h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .login-card .subtitle {
      font-size: 13px;
      color: var(--text-dim);
      margin-bottom: 28px;
    }
    label {
      display: block;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    input {
      display: block;
      width: 100%;
      background: var(--surface2);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 16px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: var(--accent); }
    button {
      width: 100%;
      background: var(--accent);
      color: white;
      border: none;
      padding: 10px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.15s;
    }
    button:hover { background: var(--accent2); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .error {
      background: #ef444422;
      color: var(--red);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;
      display: none;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
      ClaudeWatch
    </h1>
    <div class="subtitle">Sign in to access the dashboard</div>
    <div class="error" id="error"></div>
    <form id="loginForm">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit" id="btn">Sign in</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const err = document.getElementById('error');
      btn.disabled = true;
      err.classList.remove('show');
      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        if (res.ok) {
          window.location.href = '/';
        } else {
          const data = await res.json();
          err.textContent = data.error || 'Login failed';
          err.classList.add('show');
        }
      } catch (_) {
        err.textContent = 'Connection error';
        err.classList.add('show');
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

module.exports = {
  isAuthEnabled,
  authMiddleware,
  loginHandler,
  logoutHandler,
  authCheckHandler,
  loginPageHandler,
};
