/**
 * Bharat AI — /api/server (Vercel Edge Function)
 * ─────────────────────────────────────────────────
 * TRIPLE-ENGINE COMPARE MODE
 *
 * Fans a single chat request out to THREE providers
 * in parallel (Groq, OpenRouter, Google Gemini) using
 * Promise.all, and returns all three answers in one
 * combined JSON payload:
 *
 *   { groqResponse, openrouterResponse, geminiResponse }
 *
 * Each provider call is individually wrapped in
 * try/catch so a failure on ANY one engine (rate limit,
 * outage, bad key, etc.) never crashes the others — it
 * simply returns a "⚠️ ..." failure string in its own
 * slot of the response.
 *
 * MODELS (corrected, verified working as of June 2026):
 *   - Groq:       openai/gpt-oss-120b
 *     (llama-3.3-70b-versatile was announced deprecated by
 *      Groq on 2026-06-17, shutdown 2026-08-16 — switched
 *      to their recommended replacement to avoid breakage)
 *   - OpenRouter: openrouter/free
 *     (this is a real, documented model slug — OpenRouter's
 *      "Free Models Router" that auto-picks a free model)
 *   - Gemini:     gemini-2.5-flash
 *     (gemini-1.5-flash is FULLY SHUT DOWN — Google returns
 *      404 for all 1.5 and 1.0 models — this was the actual
 *      bug breaking the Gemini column before this fix)
 *
 * Set these in Vercel → Project → Settings → Environment
 * Variables, then redeploy:
 *   GROQ_API_KEY       = gsk_xxxxxxxxxxxx
 *   OPENROUTER_API_KEY = sk-or-v1-xxxxxxxxx
 *   GEMINI_API_KEY     = AIzaSyxxxxxxxxxxxx
 */

export const config = { runtime: 'edge' };

const GROQ_URL       = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const GROQ_MODEL       = 'openai/gpt-oss-120b';
const OPENROUTER_MODEL = 'openrouter/free';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* Vercel Edge functions have a hard wall-clock limit (and the free Hobby
   plan's is short). Promise.all below waits for the SLOWEST of the three
   providers, so a single stuck/slow provider can stall the entire reply.
   This wraps fetch with a timeout so a hung provider fails fast instead
   of eating the whole request budget — keeping responses fast and within
   free-plan limits. */
const PROVIDER_TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* Groq's "openai/gpt-oss-120b" model is TEXT-ONLY: it rejects any message
   whose `content` isn't a plain string with HTTP 400
   "messages[N].content must be a string". The front-end sends image
   messages in OpenAI vision array-format ([{type:"image_url"},{type:"text"}])
   which Gemini/OpenRouter can read but Groq can't — and because the FULL
   chat history is resent every turn, one image anywhere in a conversation
   would break Groq on every later message too. This flattens that array
   format down to plain text before it ever reaches Groq. */
function flattenContentForGroq(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = [];
    let hadImage = false;
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'text' && part.text) textParts.push(part.text);
      else if (part.type === 'image_url') hadImage = true;
    }
    if (hadImage) {
      textParts.push('[An image was attached here — this engine is text-only and cannot see it.]');
    }
    return textParts.join('\n\n');
  }
  return content == null ? '' : String(content);
}
function sanitizeMessagesForGroq(messages) {
  return (messages || []).map(m => ({ ...m, content: flattenContentForGroq(m?.content) }));
}

/* ════════════════════════════════════════════════════
   GROQ — OpenAI-compatible Chat Completions
════════════════════════════════════════════════════ */
async function callGroq(messages, temperature, max_tokens) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return '⚠️ GROQ_API_KEY is not set on the server. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.';
    }

    const res = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: sanitizeMessagesForGroq(messages),
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 4096,
        stream: false,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 250); } catch {}
      return `⚠️ Groq error (HTTP ${res.status}): ${detail || 'request failed'}`;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return (content && content.trim()) || '⚠️ Groq returned an empty response.';
  } catch (err) {
    if (err?.name === 'AbortError') return `⚠️ Groq timed out after ${PROVIDER_TIMEOUT_MS/1000}s.`;
    return `⚠️ Groq request failed: ${err?.message || 'unknown error'}`;
  }
}

/* ════════════════════════════════════════════════════
   OPENROUTER — OpenAI-compatible Chat Completions
   Model slug "openrouter/free" auto-routes across the
   free-tier model pool for maximum uptime/stability.
════════════════════════════════════════════════════ */
async function callOpenRouter(messages, temperature, max_tokens) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return '⚠️ OPENROUTER_API_KEY is not set on the server. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.';
    }

    const res = await fetchWithTimeout(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://bharatai.vercel.app',
        'X-Title': 'Bharat AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 4096,
        stream: false,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 250); } catch {}
      return `⚠️ OpenRouter error (HTTP ${res.status}): ${detail || 'request failed'}`;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return (content && content.trim()) || '⚠️ OpenRouter returned an empty response.';
  } catch (err) {
    if (err?.name === 'AbortError') return `⚠️ OpenRouter timed out after ${PROVIDER_TIMEOUT_MS/1000}s.`;
    return `⚠️ OpenRouter request failed: ${err?.message || 'unknown error'}`;
  }
}

/* ════════════════════════════════════════════════════
   GOOGLE GEMINI — native REST generateContent API
   Converts OpenAI-style {role, content} messages into
   Gemini's {role, parts} contents[] format. System
   messages are pulled out into systemInstruction.
   Supports text + base64 image_url parts (vision).
════════════════════════════════════════════════════ */
function toGeminiContents(messages) {
  let systemText = '';
  const contents = [];

  for (const m of messages || []) {
    if (!m) continue;

    if (m.role === 'system') {
      if (typeof m.content === 'string') systemText += m.content + '\n';
      continue;
    }

    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text' && part.text) {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
    }

    if (parts.length) contents.push({ role, parts });
  }

  return { systemText: systemText.trim(), contents };
}

async function callGemini(messages, temperature, max_tokens) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return '⚠️ GEMINI_API_KEY is not set on the server. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.';
    }

    const { systemText, contents } = toGeminiContents(messages);

    if (!contents.length) {
      return '⚠️ Gemini received no readable message content.';
    }

    const body = {
      contents,
      generationConfig: {
        temperature: temperature !== undefined ? temperature : 0.7,
        maxOutputTokens: max_tokens || 2048,
      },
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    };

    const res = await fetchWithTimeout(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 250); } catch {}
      return `⚠️ Gemini error (HTTP ${res.status}): ${detail || 'request failed'}`;
    }

    const data = await res.json();

    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) {
      return `⚠️ Gemini blocked the response (reason: ${blockReason}).`;
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('').trim();
    return text || '⚠️ Gemini returned an empty response.';
  } catch (err) {
    if (err?.name === 'AbortError') return `⚠️ Gemini timed out after ${PROVIDER_TIMEOUT_MS/1000}s.`;
    return `⚠️ Gemini request failed: ${err?.message || 'unknown error'}`;
  }
}

/* ════════════════════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════════════════════ */
export default async function handler(req) {
  /* ── CORS preflight ─────────────────────────────── */
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Method not allowed' } }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  /* ── Parse incoming body ────────────────────────── */
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON body' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const { messages, temperature, max_tokens } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: messages (array)' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  /* ── Fire all three providers concurrently ──────── */
  /* Each call function ALWAYS resolves (never rejects)
     — failures are caught internally and returned as a
     "⚠️ ..." string — so Promise.all can never reject
     and one dead provider can never crash the others. */
  const [groqResponse, openrouterResponse, geminiResponse] = await Promise.all([
    callGroq(messages, temperature, max_tokens),
    callOpenRouter(messages, temperature, max_tokens),
    callGemini(messages, temperature, max_tokens),
  ]);

  return new Response(
    JSON.stringify({ groqResponse, openrouterResponse, geminiResponse }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...CORS_HEADERS,
      },
    }
  );
}
