/**
 * TruEdge Intelligence Agent — Local Proxy Server
 *
 * Why this exists:
 *   Browsers block direct calls to api.anthropic.com from localhost (CORS).
 *   This tiny Node.js server runs on :3001 and forwards requests to Anthropic,
 *   adding your API key from the .env file so it never touches the browser.
 *
 * Start: node server.cjs   (or just run: npm run dev — it starts both)
 */

const http       = require("http");
const https      = require("https");
const fs         = require("fs");
const path       = require("path");

// ── Load .env manually (no extra packages needed) ──────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] = process.env[key] ?? val;
  }
}
loadEnv();

const PORT    = 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";

if (!API_KEY || API_KEY.includes("paste-your-key")) {
  console.error("\n❌  No API key found.");
  console.error("    1. Copy .env.example → .env");
  console.error("    2. Replace the placeholder with your real key: sk-ant-...");
  console.error("    3. Restart with: npm run dev\n");
}

const server = http.createServer((req, res) => {
  // CORS — allow the Vite dev server (any localhost origin)
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method !== "POST" || req.url !== "/api/anthropic") {
    res.writeHead(404); res.end("Not found"); return;
  }

  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.writeHead(400); res.end("Bad JSON"); return; }

    const payload = JSON.stringify(parsed);

    const options = {
      hostname: "api.anthropic.com",
      port:     443,
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "Content-Length":    Buffer.byteLength(payload),
        "x-api-key":         API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "web-search-2025-03-05",
      },
    };

    const proxy = https.request(options, (apiRes) => {
      res.writeHead(apiRes.statusCode, { "Content-Type": "application/json" });
      apiRes.pipe(res);
    });

    proxy.on("error", (err) => {
      console.error("Proxy error:", err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: { message: "Proxy error: " + err.message } }));
    });

    proxy.write(payload);
    proxy.end();
  });
});

server.listen(PORT, () => {
  console.log(`\n✅  TruEdge proxy running on http://localhost:${PORT}`);
  console.log(`    Forwarding → https://api.anthropic.com/v1/messages`);
  console.log(`    API key   : ${API_KEY ? API_KEY.slice(0, 16) + "…" : "⚠ NOT SET"}\n`);
});
