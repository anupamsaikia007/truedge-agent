import https from "https";

const MAX_BODY_BYTES = 1_048_576; // 1 MB

export default function handler(req, res) {
  // CORS — only needed for localhost dev (on Vercel, frontend and API are same-origin)
  const origin = req.headers.origin || "";
  if (origin.startsWith("http://localhost")) {
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

  let body      = "";
  let bodyBytes = 0;

  req.on("data", chunk => {
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      req.destroy();
      res.status(413).end("Payload too large");
      return;
    }
    body += chunk;
  });

  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.status(400).end("Bad JSON"); return; }

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
      res.status(apiRes.statusCode).setHeader("Content-Type", "application/json");
      apiRes.pipe(res);
    });

    proxy.setTimeout(30_000, () => {
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
