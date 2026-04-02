import https from "https";

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// Fields we allow the frontend to set; everything else is fixed server-side.
const ALLOWED_FIELDS = new Set(["model", "max_tokens", "system", "tools", "messages"]);

export default function handler(req, res) {
  // CORS — Vercel serves frontend and API from the same origin so no header
  // is needed in production. Allow localhost only for local dev.
  const origin = req.headers.origin || "";
  if (origin === "http://localhost:5173") {
    res.setHeader("Access-Control-Allow-Origin",  origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options",        "DENY");
  res.setHeader("Cache-Control",          "no-store");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST")   { res.status(405).end("Method not allowed"); return; }

  const API_KEY = process.env.VITE_ANTHROPIC_API_KEY || "";
  if (!API_KEY) {
    res.status(500).json({ error: { message: "Server misconfigured: missing API key" } });
    return;
  }

  const chunks    = [];
  let   bodyBytes = 0;

  req.on("error", () => { req.destroy(); });

  req.on("data", chunk => {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      req.destroy();
      res.status(413).end("Payload too large");
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.status(400).end("Bad JSON"); return; }

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
      res.status(apiRes.statusCode).setHeader("Content-Type", "application/json");
      apiRes.on("error", () => { if (!res.writableEnded) res.end(); });
      apiRes.pipe(res);
    });

    // Abort upstream if client disconnects mid-stream
    res.on("close", () => { if (!res.writableEnded) proxy.destroy(); });

    proxy.setTimeout(55_000, () => {
      proxy.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: { message: "Upstream request timed out" } });
      }
    });

    proxy.on("error", (err) => {
      console.error("Proxy error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: "Upstream request failed" } });
      }
    });

    proxy.write(payload);
    proxy.end();
  });
}
