// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const MORPHLY_SESSIONS_URL = 'https://api.morphly.fun/v1/realtime/sessions';
const DEFAULT_MODEL = 'morphly-realtime';
const DEFAULT_MAX_SESSION_SECONDS = 300;
const MAX_SESSION_SECONDS = 7200;
const DEFAULT_MORPHLY_ORIGIN = 'https://avatarmimicrealtime.vercel.app';
const MORPHLY_UPSTREAM_TIMEOUT_MS = 20000;
const TOKEN_ROUTE_RATE_LIMIT = 10;
const TOKEN_ROUTE_RATE_WINDOW_MS = 60000;

// Self-contained (no ../shared imports) so Vercel's CommonJS bundler can build
// this function — shared/ modules are ESM and would trigger ERR_REQUIRE_ESM.
async function requireSupabaseUser(client, req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const token = String(header).match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return { ok: false, statusCode: 401, message: 'Missing authorization token' };
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) return { ok: false, statusCode: 401, message: 'Invalid authorization token' };
  return { ok: true, user: data.user };
}

// Minimal in-memory per-user sliding-window rate limiter. On serverless, each
// instance keeps its own map, so this is best-effort protection against bursts.
const rateLimitBuckets = new Map();

function checkUserRateLimit(key, limit = TOKEN_ROUTE_RATE_LIMIT, windowMs = TOKEN_ROUTE_RATE_WINDOW_MS) {
  const now = Date.now();
  const bucketKey = String(key || 'anonymous');
  const windowStart = now - windowMs;

  const timestamps = (rateLimitBuckets.get(bucketKey) || []).filter((t) => t > windowStart);
  if (timestamps.length >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000)) };
  }

  timestamps.push(now);
  rateLimitBuckets.set(bucketKey, timestamps);
  return { ok: true };
}

function getMorphlyApiKey() {
  return process.env.MORPHLY_API_KEY?.trim() || null;
}

function getMorphlyOrigin(value) {
  const configuredOrigin = process.env.APP_ORIGIN?.trim()
    || process.env.MORPHLY_ORIGIN?.trim()
    || DEFAULT_MORPHLY_ORIGIN;
  if (typeof value !== 'string' || !value.trim()) return configuredOrigin;

  try {
    const requestedOrigin = new URL(value).origin;
    const isProductionOrigin = requestedOrigin === configuredOrigin || requestedOrigin === DEFAULT_MORPHLY_ORIGIN;
    const isLocalDevelopmentOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(requestedOrigin);

    // Packaged Electron windows run from file://. Morphly creates browser sessions
    // only for HTTPS or localhost origins, so use the deployed HTTPS app origin.
    return isProductionOrigin || isLocalDevelopmentOrigin ? requestedOrigin : configuredOrigin;
  } catch {
    return configuredOrigin;
  }
}

function getMaxSessionSeconds(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_MAX_SESSION_SECONDS;

  return Math.min(Math.max(Math.floor(requested), 1), MAX_SESSION_SECONDS);
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.()
    || `morphly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getMeteredSessionId(req) {
  const value = req?.headers?.['x-morphly-session-id'] || req?.headers?.['X-Morphly-Session-Id'];
  return typeof value === 'string' ? value.trim() : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Morphly-Session-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!supabaseAdmin) {
    return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });
  }

  const auth = await requireSupabaseUser(supabaseAdmin, req);
  if (!auth.ok) {
    return res.status(auth.statusCode).json({ error: auth.message });
  }

  const rateLimit = checkUserRateLimit(`morphly-token:${auth.user.id}`);
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    }
    return res.status(429).json({ error: 'Too many session requests. Please wait before trying again.' });
  }

  const meteredSessionId = getMeteredSessionId(req);
  if (!meteredSessionId) {
    return res.status(400).json({ error: 'Missing active metered session' });
  }

  const { data: meteredSession, error: meteredSessionError } = await supabaseAdmin
    .from('sessions')
    .select('id')
    .eq('id', meteredSessionId)
    .eq('user_id', auth.user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (meteredSessionError) {
    console.error('[morphly-token] metered session lookup failed:', meteredSessionError);
    return res.status(500).json({ error: 'Unable to verify the active streaming session' });
  }

  if (!meteredSession) {
    return res.status(403).json({ error: 'An active streaming session is required' });
  }

  const morphlyApiKey = getMorphlyApiKey();
  if (!morphlyApiKey) {
    return res.status(503).json({ error: 'Morphly is not configured on the server' });
  }

  const requested = req.body || {};

  try {
    const upstream = await fetch(MORPHLY_SESSIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${morphlyApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': createIdempotencyKey(),
      },
      body: JSON.stringify({
        model: typeof requested.model === 'string' && requested.model.trim()
          ? requested.model.trim()
          : DEFAULT_MODEL,
        origin: getMorphlyOrigin(requested.origin),
        max_session_seconds: getMaxSessionSeconds(requested.maxSessionSeconds),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(MORPHLY_UPSTREAM_TIMEOUT_MS),
    });

    // Forward the complete upstream JSON and HTTP status. Credentials
    // (session_id/session_token/client_token) are opaque — never decoded or logged.
    const result = await upstream.json().catch(() => ({}));
    // Vercel responses support setHeader(), but not Express's set() helper.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(upstream.status).json(result);
  } catch (error) {
    const name = error?.name || 'Error';
    const code = error?.cause?.code || error?.code || '';
    const message = error?.cause?.message || error?.message || 'unknown';
    console.error('[morphly-token] upstream request failed:', name, code, message);
    return res.status(502).json({
      error: 'Session service unavailable',
      code: 'MORPHLY_UPSTREAM_UNREACHABLE',
      detail: `${name}${code ? ` (${code})` : ''}: ${message}`,
    });
  }
}
