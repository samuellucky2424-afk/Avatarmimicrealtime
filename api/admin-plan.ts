// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

function getBearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function getAuthorizedAdmin(req) {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, statusCode: 401, message: 'Missing authorization token' };
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !authData?.user?.id) {
    return { ok: false, statusCode: 401, message: authError?.message || 'Invalid authorization token' };
  }

  const user = authData.user;
  const { data: adminRow, error: adminError } = await supabaseAdmin
    .from('admins')
    .select('user_id,email')
    .eq('user_id', user.id)
    .maybeSingle();

  if (adminError) {
    return { ok: false, statusCode: 500, message: adminError.message || 'Admin lookup failed' };
  }

  if (adminRow?.user_id) {
    return { ok: true, user };
  }

  if (user.email) {
    const { data: adminEmailRow, error: adminEmailError } = await supabaseAdmin
      .from('admins')
      .select('user_id,email')
      .ilike('email', user.email)
      .maybeSingle();

    if (adminEmailError) {
      return { ok: false, statusCode: 500, message: adminEmailError.message || 'Admin email lookup failed' };
    }

    if (adminEmailRow?.user_id) {
      return { ok: true, user };
    }
  }

  return { ok: false, statusCode: 403, message: 'Not authorized' };
}

async function writeAudit(actorId, action, planId, payload) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      actor_id: actorId,
      action,
      target_table: 'kplans',
      target_id: planId,
      payload,
    });

    if (error) {
      console.error('[api/admin-plan] audit insert failed:', error);
    }
  } catch (error) {
    console.error('[api/admin-plan] audit insert unexpected error:', error);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'failed', message: 'Method not allowed' });

  if (!supabaseAdmin) {
    return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError || 'Supabase admin is not configured' });
  }

  try {
    const auth = await getAuthorizedAdmin(req);
    if (!auth.ok) {
      return res.status(auth.statusCode).json({ status: 'failed', message: auth.message });
    }

    const id = typeof req.body?.id === 'string' && req.body.id.trim() ? req.body.id.trim() : null;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const credits = Math.max(0, Math.floor(Number(req.body?.credits) || 0));
    const priceNGN = Math.max(0, Number(req.body?.priceNGN ?? req.body?.usd_price) || 0);

    if (!name) {
      return res.status(400).json({ status: 'failed', message: 'Plan name is required' });
    }
    if (!(credits > 0)) {
      return res.status(400).json({ status: 'failed', message: 'Credits must be greater than zero' });
    }
    if (!(priceNGN > 0)) {
      return res.status(400).json({ status: 'failed', message: 'Price must be greater than zero' });
    }

    const payload = { name, credits, usd_price: priceNGN };
    const result = id
      ? await supabaseAdmin
        .from('plans')
        .update(payload)
        .eq('id', id)
        .select('id,name,credits,usd_price,created_at')
        .maybeSingle()
      : await supabaseAdmin
        .from('plans')
        .upsert(payload, { onConflict: 'name' })
        .select('id,name,credits,usd_price,created_at')
        .maybeSingle();

    if (result.error) {
      console.error('[api/admin-plan] plan write failed:', result.error);
      return res.status(500).json({ status: 'failed', message: result.error.message || 'Plan update failed' });
    }

    if (!result.data?.id) {
      return res.status(404).json({ status: 'failed', message: 'Plan was not found' });
    }

    await writeAudit(auth.user.id, id ? 'update_plan' : 'upsert_plan', result.data.id, payload);

    return res.json({ status: 'success', plan: result.data });
  } catch (error) {
    console.error('[api/admin-plan] unexpected error:', error);
    return res.status(500).json({ status: 'failed', message: error?.message || 'Internal server error' });
  }
}
