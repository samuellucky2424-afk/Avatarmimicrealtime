// @ts-nocheck
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_USD_PRICE_LIMIT = 1000;
const LEGACY_USD_TO_NGN_RATE = 1150;

function normalizeString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (value === null || value === undefined) {
    return null;
  }

  const coerced = String(value).trim();
  return coerced.length > 0 ? coerced : null;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toKobo(amountNGN) {
  return Math.max(0, Math.round(Number(amountNGN || 0) * 100));
}

function fromKobo(amountKobo) {
  return Math.max(0, Number(amountKobo || 0) / 100);
}

function resolveStoredPlanPriceNGN(value) {
  const storedPrice = Math.max(0, Number(value) || 0);

  if (storedPrice > 0 && storedPrice < LEGACY_USD_PRICE_LIMIT) {
    return Math.round(storedPrice * LEGACY_USD_TO_NGN_RATE);
  }

  return Math.round(storedPrice);
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function createPaystackReference(prefix = 'tlm') {
  const random = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

export function getPaystackSecretKey(env = process.env) {
  return normalizeString(env.PAYSTACK_SECRET_KEY || env.PAYSTACK_SECRET);
}

export function getBearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function requireSupabaseUser(supabaseAdmin, req) {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, statusCode: 401, message: 'Missing authorization token' };
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    return { ok: false, statusCode: 401, message: 'Invalid authorization token' };
  }

  return { ok: true, user: data.user };
}

export async function resolvePaystackPlan(supabaseAdmin, { planId, credits }) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is unavailable');
  }

  let query = supabaseAdmin
    .from('plans')
    .select('id,name,credits,usd_price')
    .gt('credits', 0)
    .gt('usd_price', 0)
    .limit(1);

  const normalizedPlanId = normalizeString(planId);
  if (normalizedPlanId) {
    query = query.eq('id', normalizedPlanId);
  } else {
    const normalizedCredits = Math.round(toFiniteNumber(credits) || 0);
    if (!(normalizedCredits > 0)) {
      throw new Error('Missing payment plan');
    }

    query = query.eq('credits', normalizedCredits);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }

  const planCredits = Math.round(Number(data?.credits || 0));
  const amountNGN = resolveStoredPlanPriceNGN(data?.usd_price);

  if (!data?.id || !(planCredits > 0) || !(amountNGN > 0)) {
    throw new Error('Selected payment plan was not found');
  }

  return {
    id: data.id,
    name: normalizeString(data.name) || `${planCredits} Credits`,
    credits: planCredits,
    amountNGN,
  };
}

export async function initializePaystackTransaction({
  secretKey,
  email,
  amountNGN,
  reference,
  metadata = {},
  callbackUrl = null,
}) {
  const normalizedEmail = normalizeString(email);
  const amount = toKobo(amountNGN);

  if (!normalizeString(secretKey)) {
    throw new Error('Missing PAYSTACK_SECRET_KEY');
  }

  if (!normalizedEmail || amount <= 0) {
    throw new Error('Missing email or payment amount');
  }

  const body = {
    email: normalizedEmail,
    amount,
    currency: 'NGN',
    reference: normalizeString(reference) || createPaystackReference(),
    metadata,
  };

  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }

  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await parseResponse(response);
  if (!response.ok || payload?.status !== true || !payload?.data?.authorization_url) {
    throw new Error(payload?.message || payload?.raw || `Paystack returned HTTP ${response.status}`);
  }

  return {
    status: 'success',
    reference: payload.data.reference || body.reference,
    authorizationUrl: payload.data.authorization_url,
    accessCode: payload.data.access_code,
  };
}

export async function verifyPaystackTransaction(secretKey, reference) {
  const normalizedReference = normalizeString(reference);

  if (!normalizeString(secretKey)) {
    throw new Error('Missing PAYSTACK_SECRET_KEY');
  }

  if (!normalizedReference) {
    throw new Error('Missing Paystack reference');
  }

  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(normalizedReference)}`, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  });

  const payload = await parseResponse(response);
  if (!response.ok || payload?.status !== true) {
    throw new Error(payload?.message || payload?.raw || `Paystack returned HTTP ${response.status}`);
  }

  return payload.data;
}

async function getWalletCredits(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('credits')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return Number(data?.credits || 0);
}

async function upsertWalletCredits(supabaseAdmin, userId, credits) {
  const { error } = await supabaseAdmin
    .from('wallets')
    .upsert({ user_id: userId, credits }, { onConflict: 'user_id' });

  if (error) throw error;
  return credits;
}

async function insertTransaction(supabaseAdmin, payload) {
  const { error } = await supabaseAdmin.from('transactions').insert(payload);
  if (error) throw error;
}

async function findTransactionByReference(supabaseAdmin, reference) {
  const normalizedReference = normalizeString(reference);
  if (!normalizedReference) return null;

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id,user_id,type,amount_naira,amount,credits,reference,description,status,metadata,created_at')
    .eq('reference', normalizedReference)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function updateTransaction(supabaseAdmin, id, payload) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .update(payload)
    .eq('id', id);

  if (error) throw error;
}

async function insertSubscription(supabaseAdmin, payload) {
  const { error } = await supabaseAdmin.from('subscriptions').insert(payload);
  if (error) throw error;
}

export async function recordPaystackAudit(supabaseAdmin, action, payload = {}) {
  if (!supabaseAdmin) return;

  const reference = normalizeString(payload.reference);
  const targetId = reference || normalizeString(payload.userId) || null;

  const { error } = await supabaseAdmin.from('audit_log').insert({
    actor_id: null,
    action,
    target_table: 'ktransactions',
    target_id: targetId,
    payload: {
      provider: 'paystack',
      ...payload,
    },
  });

  if (error) {
    console.warn('[paystack] audit insert failed:', error);
  }
}

export async function recordPendingPaystackPayment(supabaseAdmin, {
  userId,
  reference,
  credits,
  amountNGN,
  planName,
}) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is unavailable');
  }

  const normalizedReference = normalizeString(reference);
  const normalizedUserId = normalizeString(userId);
  const normalizedCredits = Math.round(toFiniteNumber(credits) || 0);
  const normalizedAmount = toFiniteNumber(amountNGN) || 0;
  const normalizedPlanName = normalizeString(planName) || `${normalizedCredits} Credits`;

  if (!normalizedReference || !normalizedUserId || !(normalizedCredits > 0) || !(normalizedAmount > 0)) {
    throw new Error('Missing pending Paystack payment data');
  }

  const existingTransaction = await findTransactionByReference(supabaseAdmin, normalizedReference);
  if (existingTransaction) {
    return existingTransaction;
  }

  const timestamp = new Date().toISOString();
  const payload = {
    user_id: normalizedUserId,
    type: 'credit_purchase',
    amount_naira: normalizedAmount,
    amount: normalizedAmount,
    credits: normalizedCredits,
    reference: normalizedReference,
    description: `Paystack ${normalizedPlanName} checkout pending`,
    status: 'pending',
    metadata: {
      provider: 'paystack',
      plan_name: normalizedPlanName,
      payment_provider_status: 'initialized',
    },
    created_at: timestamp,
  };

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .insert(payload)
    .select('id,user_id,type,amount_naira,amount,credits,reference,description,status,metadata,created_at')
    .maybeSingle();

  if (error) throw error;
  return data;
}

export function getPaystackPaymentContext(transaction, fallback = {}) {
  const metadata = transaction?.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {};

  return {
    reference: normalizeString(transaction?.reference || fallback.reference),
    userId: normalizeString(metadata.userId || metadata.user_id || fallback.userId),
    credits: Math.round(toFiniteNumber(metadata.credits ?? fallback.credits) || 0),
    amountPaidNGN: fromKobo(transaction?.amount ?? fallback.amountKobo),
    expectedAmountNGN: toFiniteNumber(metadata.amountNGN ?? metadata.amount_ngn ?? fallback.amountNGN),
    planName: normalizeString(metadata.planName || metadata.plan_name || fallback.planName),
    status: normalizeString(transaction?.status)?.toLowerCase(),
    currency: normalizeString(transaction?.currency || 'NGN')?.toUpperCase(),
    paidAt: normalizeString(transaction?.paid_at || transaction?.paidAt),
  };
}

export function validatePaystackPayment(transaction, fallback = {}) {
  const context = getPaystackPaymentContext(transaction, fallback);

  if (context.status !== 'success') {
    return { ok: false, pending: true, message: 'Paystack payment is not successful yet', context };
  }

  if (context.currency !== 'NGN') {
    return { ok: false, message: 'Unexpected Paystack payment currency', context };
  }

  if (!context.reference) {
    return { ok: false, message: 'Missing Paystack payment reference', context };
  }

  if (!context.userId || !UUID_PATTERN.test(context.userId)) {
    return { ok: false, message: 'Missing payment user metadata', context };
  }

  if (!(context.credits > 0)) {
    return { ok: false, message: 'Missing payment credits metadata', context };
  }

  if (context.expectedAmountNGN && context.amountPaidNGN + 0.01 < context.expectedAmountNGN) {
    return { ok: false, message: 'Paystack amount paid is less than expected', context };
  }

  return { ok: true, context };
}

export async function applyVerifiedPaystackPayment(supabaseAdmin, transaction, fallback = {}) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is unavailable');
  }

  const reference = normalizeString(transaction?.reference || fallback.reference);
  const existingTransaction = await findTransactionByReference(supabaseAdmin, reference);
  const existingMetadata = existingTransaction?.metadata && typeof existingTransaction.metadata === 'object'
    ? existingTransaction.metadata
    : {};

  const validation = validatePaystackPayment(transaction, {
    ...fallback,
    reference,
    userId: fallback.userId || existingTransaction?.user_id,
    credits: fallback.credits ?? existingTransaction?.credits,
    amountNGN: fallback.amountNGN ?? existingTransaction?.amount_naira ?? existingTransaction?.amount,
    planName: fallback.planName || existingMetadata.plan_name,
  });

  if (!validation.ok) {
    return {
      status: validation.pending ? 'pending' : 'failed',
      message: validation.message,
      reference: validation.context.reference,
    };
  }

  const { context } = validation;
  if (existingTransaction?.status === 'success') {
    return {
      status: 'success',
      message: 'Paystack payment already processed',
      creditsAdded: 0,
      newCredits: await getWalletCredits(supabaseAdmin, context.userId),
      reference: context.reference,
    };
  }

  const currentCredits = await getWalletCredits(supabaseAdmin, context.userId);
  const newCredits = currentCredits + context.credits;
  await upsertWalletCredits(supabaseAdmin, context.userId, newCredits);

  const timestamp = new Date().toISOString();
  const amountPaid = context.amountPaidNGN;
  const planName = context.planName || `${context.credits} Credits`;
  const description = `Paystack ${planName} purchase`;

  const successTransactionPayload = {
    user_id: context.userId,
    type: 'credit_purchase',
    amount_naira: amountPaid,
    amount: amountPaid,
    credits: context.credits,
    reference: context.reference,
    description,
    status: 'success',
    metadata: {
      provider: 'paystack',
      paid_at: context.paidAt,
      paystack_id: transaction?.id,
    },
    created_at: timestamp,
  };

  if (existingTransaction) {
    await updateTransaction(supabaseAdmin, existingTransaction.id, successTransactionPayload);
  } else {
    await insertTransaction(supabaseAdmin, successTransactionPayload);
  }

  await insertSubscription(supabaseAdmin, {
    user_id: context.userId,
    plan_name: planName,
    amount_paid: amountPaid,
    credits: context.credits,
    status: 'active',
    created_at: timestamp,
  });

  return {
    status: 'success',
    message: 'Paystack payment processed successfully',
    creditsAdded: context.credits,
    newCredits,
    reference: context.reference,
  };
}
