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

const http  = require("http");
const https = require("https");

// ── Load .env via dotenv ──────────────────────────────────────────────────────
require("dotenv").config();

const PORT    = parseInt(process.env.PORT || "3001", 10);
const API_KEY = process.env.VITE_ANTHROPIC_API_KEY || "";

if (!API_KEY || API_KEY.includes("paste-your-key")) {
  console.error("\n❌  No API key found.");
  console.error("    1. Copy .env.example → .env");
  console.error("    2. Replace the placeholder with your real key: sk-ant-...");
  console.error("    3. Restart with: npm run dev\n");
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// Fields we allow the frontend to set; everything else is fixed server-side.
const ALLOWED_FIELDS = new Set(["model", "max_tokens", "system", "tools", "messages"]);

const server = http.createServer((req, res) => {
  // CORS — allow only the Vite dev server
  res.setHeader("Access-Control-Allow-Origin",  "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Security headers
  res.setHeader("X-Content-Type-Options",    "nosniff");
  res.setHeader("X-Frame-Options",           "DENY");
  res.setHeader("Cache-Control",             "no-store");
  res.setHeader("Strict-Transport-Security", "max-age=63072000");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method !== "POST" || req.url !== "/api/anthropic") {
    res.writeHead(404); res.end("Not found"); return;
  }

  const chunks    = [];
  let   bodyBytes = 0;

  req.on("error", () => { req.destroy(); });

  req.on("data", chunk => {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      req.destroy();
      res.writeHead(413); res.end("Payload too large"); return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400); res.end("Bad JSON"); return; }

    // Strip any keys the frontend shouldn't be able to set
    const safe = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in parsed) safe[key] = parsed[key];
    }

    const payload = JSON.stringify(safe);

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
      apiRes.on("error", () => { if (!res.writableEnded) res.end(); });
      apiRes.pipe(res);
    });

    // Abort upstream if client disconnects mid-stream
    res.on("close", () => { if (!res.writableEnded) proxy.destroy(); });

    // Abort upstream request if it hangs for more than 120 seconds
    proxy.setTimeout(120_000, () => {
      proxy.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end(JSON.stringify({ error: { message: "Upstream request timed out" } }));
      }
    });

    proxy.on("error", (err) => {
      console.error("Proxy error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: { message: "Upstream request failed" } }));
      }
    });

    proxy.write(payload);
    proxy.end();
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ── Bind to localhost only ────────────────────────────────────────────────────
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n✅  TruEdge proxy running on http://localhost:${PORT}`);
  console.log(`    Forwarding → https://api.anthropic.com/v1/messages`);
  console.log(`    API key   : ${API_KEY ? API_KEY.slice(0, 16) + "…" : "⚠ NOT SET"}\n`);
});
