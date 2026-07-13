/*
 * server.mjs — production-hardened static host + Claude-backed activity parser.
 *
 *   GET  /*                  → static files (index.html, calc.js, app.js, styles.css, /sources)
 *   POST /api/parse-activity → { text, weightKg } → structured activity JSON
 *
 * Hardening (all native node:http, no Express):
 *   • Cheapest available model (claude-haiku-4-5), max_tokens capped at 300.
 *   • In-memory per-IP rate limit: 5 requests / minute → 429.
 *   • POST body capped at 5 KB → 413 (prevents memory-exhaustion).
 *   • API key read only from process.env.ANTHROPIC_API_KEY (never sent to the client).
 *   • Any provider failure (billing, timeout, 429, 5xx, bad JSON) → clean
 *     { ok:false, error:"provider_unavailable" }; the browser then uses its offline parser.
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... node server.mjs    (PORT defaults to 4174)
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, parseActivityLLM } from "./lib/activity-parser.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4174;

// ---------------------------------------------------------------------------
// Model + client.  IMPORTANT: the once-cheapest "claude-3-haiku-20240307"
// RETIRED on 2026-04-19 — it now returns 404 and does not support the structured
// outputs this server relies on, so it would force 100% fallback. We default to the
// cheapest *currently available* model, claude-haiku-4-5 ($1 / $5 per 1M tokens).
// Override with ANTHROPIC_MODEL if you have a reason to.
// ---------------------------------------------------------------------------
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

const API_KEY = process.env.ANTHROPIC_API_KEY; // secure: env only, never shipped to the browser
const client = API_KEY
  ? new Anthropic({ apiKey: API_KEY, maxRetries: 1, timeout: 10_000 }) // fail fast → quick fallback
  : null;

// ---------------------------------------------------------------------------
// In-memory per-IP rate limiter — 5 requests / minute (sliding window).
// ---------------------------------------------------------------------------
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 5 * 1024; // 5 KB POST cap
const hits = new Map(); // ip -> number[] (timestamps of allowed requests)

function clientIp(req) {
  // Behind a host/reverse-proxy the real client IP is the first X-Forwarded-For entry.
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { hits.set(ip, recent); return true; } // blocked req doesn't extend window
  recent.push(now);
  hits.set(ip, recent);
  return false;
}
// Periodic sweep so the Map can't grow unbounded under churn.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const keep = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (keep.length) hits.set(ip, keep); else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
  // Both of these were missing, and both were being served as application/octet-stream:
  // .xml would make Google reject sitemap.xml, and .png breaks og-image.png in link previews.
  ".xml": "application/xml; charset=utf-8", ".png": "image/png",
};

// Allow-all fallback, served only if robots.txt is somehow absent from the deploy.
// A 404 here is already permissive (crawlers treat it as "crawl everything"), but a
// 5xx is NOT: Google reads a persistent 5xx on robots.txt as "disallow everything" and
// will drop the site from the index. Answering from memory means that can never happen.
const ROBOTS_FALLBACK = `User-agent: *
Allow: /

Sitemap: https://www.thetdee.com/sitemap.xml
`;
function send(res, code, body, { type = "application/json", headers = {} } = {}) {
  res.writeHead(code, {
    "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers,
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const sendJson = (res, code, obj, headers) => send(res, code, JSON.stringify(obj), { headers });

// Read the POST body, stopping at MAX_BODY_BYTES. On overflow we pause the stream
// (TCP backpressure — the client can't flood us) and reject; we never buffer past the
// cap, so memory stays bounded, and the connection survives long enough to return 413.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        reject(Object.assign(new Error("payload_too_large"), { httpCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);

  // ---- API ----
  if (path === "/api/parse-activity") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });

    if (isRateLimited(clientIp(req)))
      return sendJson(res, 429, { ok: false, error: "rate_limited" }, { "retry-after": "60" });

    // Read + cap the body BEFORE anything else touches it — memory protection must hold
    // regardless of provider state.
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return err.httpCode === 413
        ? sendJson(res, 413, { ok: false, error: "payload_too_large" })
        : sendJson(res, 400, { ok: false, error: "bad_request" });
    }

    let text, weightKg;
    try { ({ text, weightKg } = JSON.parse(raw || "{}")); }
    catch { return sendJson(res, 400, { ok: false, error: "bad_json" }); }
    if (!text || !String(text).trim()) return sendJson(res, 400, { ok: false, error: "empty_text" });

    // No key configured → behave like any provider outage so the client falls back.
    if (!client) return sendJson(res, 503, { ok: false, error: "provider_unavailable" });

    try {
      const result = await parseActivityLLM(client, MODEL, String(text).slice(0, 4000), Number(weightKg) || 75);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      // Billing limit, timeout, 429, 5xx, or unparseable output — all collapse to one clean error.
      console.error("[parse-activity] provider error:", err?.status ?? "", err?.message ?? err);
      return sendJson(res, 503, { ok: false, error: "provider_unavailable" });
    }
  }

  // ---- static (GET/HEAD, traversal-guarded, with conditional revalidation) ----
  if (req.method !== "GET" && req.method !== "HEAD")
    return send(res, 405, "Method Not Allowed", { type: "text/plain" });
  const rel = path === "/" ? "/index.html" : path;
  const filePath = normalize(join(__dirname, rel));
  if (!filePath.startsWith(__dirname)) return send(res, 403, "Forbidden", { type: "text/plain" }); // no traversal

  let info;
  try { info = await stat(filePath); } catch {
    if (path === "/robots.txt")
      return send(res, 200, ROBOTS_FALLBACK, { type: "text/plain; charset=utf-8" });
    return send(res, 404, "Not Found", { type: "text/plain" });
  }
  if (!info.isFile()) return send(res, 404, "Not Found", { type: "text/plain" });

  // These assets are NOT content-hashed and are tightly coupled (index.html ⇄ app.js ⇄
  // calc.js), so we revalidate every load instead of using max-age: an ETag lets unchanged
  // files return 304 (no body re-download), while a deploy is picked up on the very next
  // request — no stale-asset window, no version skew.
  const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  const cacheHeaders = { "cache-control": "public, no-cache", etag, "last-modified": info.mtime.toUTCString() };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ...cacheHeaders, "x-content-type-options": "nosniff" });
    return res.end();
  }
  const type = MIME[extname(filePath)] || "application/octet-stream";
  if (req.method === "HEAD") {
    res.writeHead(200, { "content-type": type, ...cacheHeaders, "x-content-type-options": "nosniff" });
    return res.end();
  }
  try { send(res, 200, await readFile(filePath), { type, headers: cacheHeaders }); }
  catch { send(res, 404, "Not Found", { type: "text/plain" }); }
});

server.listen(PORT, () => {
  console.log(`TDEE server on http://localhost:${PORT}`);
  console.log(`Model: ${MODEL} · max_tokens ${MAX_TOKENS} · rate limit ${RATE_LIMIT}/min/IP · body cap ${MAX_BODY_BYTES} B`);
  console.log(client
    ? "LLM activity parsing: ENABLED (ANTHROPIC_API_KEY found)"
    : "LLM activity parsing: DISABLED (no ANTHROPIC_API_KEY) — clients use the offline parser");
});
