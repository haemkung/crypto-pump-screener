/**
 * Realtime AI review for early-tier Telegram candidates.
 * Called ONLY after code filters (hidden evidence ≥3) pick a sendable alert.
 * Soft-fail always: timeout/error/no-key → action 'send' so the pipeline never blocks forever.
 *
 * Learns from past mistakes via data/learning-insights.json + data/early-learned-bias.json
 * (few-shot lessons + soft vetoBias / caution patterns). Files optional — missing = one-shot.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");
const INSIGHTS_FILE = resolve(DATA_DIR, "learning-insights.json");
const BIAS_FILE = resolve(DATA_DIR, "early-learned-bias.json");

const CACHE_TTL_MS = 20 * 60e3;
const SOFT_TIMEOUT_MS = 8_000;
const LEARN_CACHE_TTL_MS = 60e3;
const cache = new Map(); // key → { at, result }
let learnCache = { at: 0, insights: null, bias: null };

function resolveProvider() {
  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  if (groqKey) {
    return {
      key: groqKey,
      base: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
      model: process.env.GROQ_MODEL || process.env.OPENAI_MODEL || "qwen/qwen3.8-27b",
      jsonMode: true,
      name: "groq",
    };
  }
  const openaiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (openaiKey) {
    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const isGroq = /groq\.com/i.test(base);
    return {
      key: openaiKey,
      base,
      model: process.env.OPENAI_MODEL || (isGroq ? "qwen/qwen3.8-27b" : "gpt-4o-mini"),
      jsonMode: true,
      name: isGroq ? "groq" : "openai",
    };
  }
  const xaiKey = (process.env.XAI_API_KEY || "").trim();
  if (xaiKey) {
    return {
      key: xaiKey,
      base: (process.env.XAI_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, ""),
      model: process.env.XAI_MODEL || process.env.OPENAI_MODEL || "grok-2-latest",
      jsonMode: true,
      name: "xai",
    };
  }
  return null;
}

function readJsonSafe(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadLearning() {
  const now = Date.now();
  if (learnCache.at && now - learnCache.at < LEARN_CACHE_TTL_MS) return learnCache;
  const insights = readJsonSafe(INSIGHTS_FILE, null);
  const bias = readJsonSafe(BIAS_FILE, null);
  learnCache = { at: now, insights, bias };
  return learnCache;
}

function cacheKey(payload) {
  const tier = payload?.tier || "?";
  const side = payload?.side || "?";
  const symbol = String(payload?.symbol || "?").toUpperCase();
  return `${tier}:${side}:${symbol}`;
}

function pruneCache(now = Date.now()) {
  for (const [k, v] of cache) if (!v || now - v.at > CACHE_TTL_MS) cache.delete(k);
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 50;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function normalizeAction(a) {
  const s = String(a || "").toLowerCase().trim();
  if (s === "veto" || s === "boost" || s === "send") return s;
  return "send";
}

function truncateTh(s, max = 80) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function buildUserPayload(payload) {
  const factors = Array.isArray(payload?.factors)
    ? payload.factors.map((f) => ({
        key: f.key,
        labelTh: f.labelTh || f.key,
        detailTh: f.detailTh,
      }))
    : [];
  return {
    symbol: payload?.symbol,
    side: payload?.side,
    tier: payload?.tier,
    factors,
    price: payload?.price ?? null,
    fundingPct: payload?.fundingPct ?? null,
    oiNoteTh: payload?.oiNoteTh ?? null,
    slPct: payload?.slPct ?? null,
    tp1: payload?.tp1 ?? null,
    tp2: payload?.tp2 ?? null,
    entry: payload?.entry ?? null,
    regime: payload?.regime ?? null,
    pct24h: payload?.pct24h ?? null,
    trigger: payload?.trigger ?? null,
  };
}

function factorKeyList(payload) {
  return Array.isArray(payload?.factors)
    ? [...new Set(payload.factors.map((f) => f?.key).filter(Boolean))].sort()
    : [];
}

function keysMatch(patternKeys, liveKeys) {
  if (!Array.isArray(patternKeys) || !patternKeys.length) return false;
  const set = new Set(liveKeys);
  return patternKeys.every((k) => set.has(k));
}

function buildLessonsBlock(insights, bias, payload) {
  const lines = [];
  const wr = bias?.earlyWinRate;
  const graded = bias?.earlyGraded ?? 0;
  if (graded > 0 && wr != null) {
    lines.push(
      `Live early WR≈${(wr * 100).toFixed(0)}% over ${graded} graded (vetoBias=${Number(bias?.vetoBias || 0).toFixed(2)}).`
    );
  }
  const few = Array.isArray(insights?.aiFewShot) ? insights.aiFewShot.slice(0, 6) : [];
  for (const f of few) {
    if (f?.lessonTh) lines.push(`- ${f.lessonTh}`);
  }
  const liveKeys = factorKeyList(payload);
  const cautions = Array.isArray(bias?.cautionFactorKeys) ? bias.cautionFactorKeys : [];
  const matched = cautions.filter((p) => keysMatch(p, liveKeys));
  if (matched.length) {
    lines.push(
      `CAUTION: current factors overlap losing pattern(s): ${matched
        .map((p) => p.join("+"))
        .join(" | ")} — prefer veto unless evidence is unusually strong.`
    );
  }
  const prefers = Array.isArray(bias?.preferBoostKeys) ? bias.preferBoostKeys : [];
  const boostHit = prefers.filter((p) => keysMatch(p, liveKeys));
  if (boostHit.length) {
    lines.push(
      `STRONG past win pattern overlap: ${boostHit.map((p) => p.join("+")).join(" | ")} — boost only if coherent.`
    );
  }
  if (!lines.length) return "";
  return `\n\nLessons from recent graded early alerts (avoid repeating fail modes):\n${lines.join("\n")}`;
}

const SYSTEM_PROMPT_BASE = `You are a concise crypto early-signal reviewer for Binance USDT-M.
Code filters already required ≥3 independent "hidden" evidence factors. You only review candidates about to Telegram.
Reply with JSON ONLY (no markdown): {"action":"send"|"boost"|"veto","score":0-100,"reasonTh":"..."}
Rules:
- veto ONLY if clear trap / chase / contradiction (e.g. crowded same-side, funding already extreme with move, factors conflict) OR if lessons show the same factor combo lost recently.
- boost ONLY if confluence is unusually strong and coherent AND not a known losing pattern.
- otherwise action "send".
- reasonTh: Thai preferred (English OK), ≤80 Thai characters, concise.
- score: confidence 0-100 that this alert is worth acting on.
- Never loosen the ≥3 hidden-factor rule. Respect tight SL (≈2–3%); wider stops are already skipped by code.`;

function softPostProcess(result, payload, bias) {
  const out = { ...result };
  const liveKeys = factorKeyList(payload);
  const vetoBias = Number(bias?.vetoBias || 0);
  const cautions = Array.isArray(bias?.cautionFactorKeys) ? bias.cautionFactorKeys : [];
  const matchedCaution = cautions.some((p) => keysMatch(p, liveKeys));

  // Soft: never upgrade to boost on caution patterns; downgrade boost→send
  if (matchedCaution && out.action === "boost") {
    out.action = "send";
    out.reasonTh = truncateTh(
      (out.reasonTh ? out.reasonTh + " · " : "") + "ลดบูสต์ (แพทเทิร์นเคยพลาด)"
    );
    out.score = Math.min(out.score, 55);
    out.learnedAdjust = "boost_to_send_caution";
  }

  // Soft: with elevated vetoBias + caution match + mediocre score → veto
  if (
    matchedCaution &&
    vetoBias >= 0.15 &&
    out.action === "send" &&
    out.score < 55 + vetoBias * 40
  ) {
    out.action = "veto";
    out.reasonTh = truncateTh(
      (out.reasonTh ? out.reasonTh + " · " : "") + "วีโต้จากแพทเทิร์นเสียซ้ำ"
    );
    out.learnedAdjust = "send_to_veto_caution";
  }

  // Soft: high vetoBias alone — cap boost
  if (vetoBias >= 0.2 && out.action === "boost" && out.score < 80) {
    out.action = "send";
    out.reasonTh = truncateTh(
      (out.reasonTh ? out.reasonTh + " · " : "") + "ชะลอบูสต์ (WR ต่ำ)"
    );
    out.learnedAdjust = "boost_to_send_low_wr";
  }

  return out;
}

async function callChat(provider, payload, signal, lessonsBlock) {
  const system = SYSTEM_PROMPT_BASE + (lessonsBlock || "");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(buildUserPayload(payload)) },
  ];
  async function once(useJsonMode) {
    const body = {
      model: provider.model,
      temperature: 0.2,
      max_tokens: 180,
      messages,
    };
    if (useJsonMode) body.response_format = { type: "json_object" };
    const r = await fetch(`${provider.base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const errText = r.ok ? "" : await r.text().catch(() => "");
    return { r, errText };
  }
  let { r, errText } = await once(provider.jsonMode !== false);
  if (!r.ok && /json|response_format|validate/i.test(errText)) {
    ({ r, errText } = await once(false));
  }
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${errText.slice(0, 120)}`);
  }
  const j = await r.json();
  const raw = j?.choices?.[0]?.message?.content;
  if (!raw || typeof raw !== "string") throw new Error("empty model content");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("non-json model content");
    parsed = JSON.parse(m[0]);
  }
  return {
    action: normalizeAction(parsed.action),
    score: clampScore(parsed.score),
    reasonTh: truncateTh(parsed.reasonTh || parsed.reason || ""),
    model: provider.model,
  };
}

/**
 * @param {object} payload
 * @returns {Promise<{ok:boolean, action:'send'|'boost'|'veto', score:number, reasonTh:string, model?:string, latencyMs:number, skipped?:boolean, cached?:boolean, learnedAdjust?:string}>}
 */
export async function reviewEarlySignal(payload) {
  const t0 = Date.now();
  const provider = resolveProvider();
  if (!provider) {
    return {
      ok: false,
      action: "send",
      score: 0,
      reasonTh: "AI ปิด (ไม่มี API key)",
      latencyMs: Date.now() - t0,
      skipped: true,
    };
  }

  pruneCache();
  const key = cacheKey(payload);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
    return { ...hit.result, latencyMs: Date.now() - t0, cached: true };
  }

  const { insights, bias } = loadLearning();
  const lessonsBlock = buildLessonsBlock(insights, bias, payload);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SOFT_TIMEOUT_MS);
  try {
    const reviewed = await callChat(provider, payload, ac.signal, lessonsBlock);
    let result = {
      ok: true,
      action: reviewed.action,
      score: reviewed.score,
      reasonTh:
        reviewed.reasonTh ||
        (reviewed.action === "veto"
          ? "AI วีโต้"
          : reviewed.action === "boost"
            ? "AI บูสต์"
            : "AI ผ่าน"),
      model: reviewed.model,
      latencyMs: Date.now() - t0,
    };
    result = softPostProcess(result, payload, bias);
    result.latencyMs = Date.now() - t0;
    cache.set(key, { at: Date.now(), result: { ...result } });
    return result;
  } catch (e) {
    const msg = String(e?.name === "AbortError" ? "timeout" : e?.message || e).slice(0, 80);
    return {
      ok: false,
      action: "send",
      score: 0,
      reasonTh: "AI ข้าม (timeout/error)",
      model: provider.model,
      latencyMs: Date.now() - t0,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** test helper — clear in-memory cache */
export function _clearAiReviewCache() {
  cache.clear();
  learnCache = { at: 0, insights: null, bias: null };
}
