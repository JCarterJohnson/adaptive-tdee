/*
 * api/parse-activity.js — Vercel serverless port of the POST /api/parse-activity route.
 *
 * Same contract as the Render server (server.mjs): { text, weightKg } in, structured
 * activity JSON out, and every failure collapses to { ok:false, error:"provider_unavailable" }
 * so the browser silently drops to its offline keyword parser. The prompt and schema are
 * imported from lib/activity-parser.mjs, so there is only one copy of them.
 *
 * Requires ANTHROPIC_API_KEY in the Vercel project's environment variables. Without it
 * this returns 503 and the app still works, just without the "Understand with AI" path.
 *
 * RATE LIMITING CAVEAT, read before deploying:
 * server.mjs holds a per-IP sliding window in process memory, which works because it is
 * one long-lived process. Serverless invocations do not reliably share memory, so the
 * limiter below only throttles requests that land on the same warm instance. It raises the
 * cost of hammering the endpoint but it is not a hard cap. The real spend guards are the
 * ones that do survive: the cheapest model, max_tokens 300, a 5 KB body cap, and a 4,000
 * character input truncation. If this endpoint ever gets abused, put a durable counter
 * (Vercel KV / Upstash) behind it rather than trusting the map below.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, parseActivityLLM } from "../lib/activity-parser.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const client = API_KEY
  ? new Anthropic({ apiKey: API_KEY, maxRetries: 1, timeout: 10_000 })
  : null;

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 5 * 1024;
const hits = new Map(); // best-effort only; see the caveat above

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // instance is being churned; do not leak memory
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "method_not_allowed" });

  if (isRateLimited(clientIp(req)))
    return res.setHeader("retry-after", "60").status(429).json({ ok: false, error: "rate_limited" });

  // Vercel parses JSON bodies for us, but it will happily hand over a large one, so the
  // size cap has to be re-applied here rather than inherited from server.mjs.
  let body = req.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
      return res.status(413).json({ ok: false, error: "payload_too_large" });
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: "bad_json" }); }
  }
  if (!body || typeof body !== "object")
    return res.status(400).json({ ok: false, error: "bad_request" });
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES)
    return res.status(413).json({ ok: false, error: "payload_too_large" });

  const { text, weightKg } = body;
  if (!text || !String(text).trim())
    return res.status(400).json({ ok: false, error: "empty_text" });

  if (!client) return res.status(503).json({ ok: false, error: "provider_unavailable" });

  try {
    const result = await parseActivityLLM(client, MODEL, String(text).slice(0, 4000), Number(weightKg) || 75);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("[parse-activity] provider error:", err?.status ?? "", err?.message ?? err);
    return res.status(503).json({ ok: false, error: "provider_unavailable" });
  }
}

export const config = { maxDuration: 15 }; // the Anthropic client already times out at 10s
