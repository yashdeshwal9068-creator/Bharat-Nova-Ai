/**
 * Bharat AI — /api/chat proxy (Vercel Edge Function)
 *
 * Reads GROQ_API_KEY and OPENROUTER_API_KEY from Vercel
 * Environment Variables and proxies requests to the right
 * provider, including full SSE streaming passthrough.
 *
 * Set these in Vercel Dashboard → Project → Settings → Environment Variables:
 *   GROQ_API_KEY       = gsk_xxxxxxxxxxxx
 *   OPENROUTER_API_KEY = sk-or-v1-xxxxxxxxx
 */

export const config = { runtime: 'edge' };

const ENDPOINTS = {
  groq:        'https://api.groq.com/openai/v1/chat/completions',
  openrouter:  'https://openrouter.ai/api/v1/chat/completions',
};

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { provider = 'groq', ...payload } = body;

  // Pick the right API key from Vercel environment variables
  const apiKey =
    provider === 'openrouter'
      ? process.env.OPENROUTER_API_KEY
      : process.env.GROQ_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Missing server-side key for provider "${provider}". ` +
            `Add ${provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GROQ_API_KEY'} ` +
            `in Vercel → Project → Settings → Environment Variables.`,
        },
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const endpoint = ENDPOINTS[provider] || ENDPOINTS.groq;

  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  // OpenRouter needs these extra headers
  if (provider === 'openrouter') {
    upstreamHeaders['HTTP-Referer'] = 'https://bharatai.vercel.app';
    upstreamHeaders['X-Title'] = 'Bharat AI';
  }

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(payload),
    });

    // Stream (or non-stream) response passthrough
    const contentType = upstream.headers.get('Content-Type') || 'application/json';
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
