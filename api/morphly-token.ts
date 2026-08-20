// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

const MORPHLY_SESSIONS_URL = 'https://api.morphly.fun/v1/realtime/sessions';
const DEFAULT_MODEL = 'lucy-2.5';
const DEFAULT_MAX_SESSION_SECONDS = 300;
const MAX_SESSION_SECONDS = 7200;

async function requireSupabaseUser(client, req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const token = String(header).match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!token) return { ok: false, statusCode: 401, message: 'Missing authorization token' };

  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) return { ok: false, statusCode: 401, message: 'Invalid authorization token' };

  return { ok: true, user: data.user };
}

function getMorphlyApiKey() {
  return process.env.MORPHLY_API_KEY?.trim() || null;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!supabaseAdmin) {
    return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });
  }

  const auth = await requireSupabaseUser(supabaseAdmin, req);
  if (!auth.ok) {
    return res.status(auth.statusCode).json({ error: auth.message });
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
        origin: typeof requested.origin === 'string' ? requested.origin : undefined,
        max_session_seconds: getMaxSessionSeconds(requested.maxSessionSeconds),
      }),
    });

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[morphly-token] session creation failed:', upstream.status, result);
      return res.status(upstream.status).json({
        error: result?.error?.message || result?.message || 'Unable to create a Morphly realtime session',
        code: result?.error?.code || result?.code,
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('[morphly-token] request failed:', error);
    return res.status(502).json({ error: 'Unable to reach Morphly' });
  }
}
