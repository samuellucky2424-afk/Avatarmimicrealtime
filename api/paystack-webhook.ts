// @ts-nocheck
import crypto from 'crypto';
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import {
  applyVerifiedPaystackPayment,
  getPaystackSecretKey,
  verifyPaystackTransaction,
} from './paystack.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()] || req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function timingSafeEqualHex(left, right) {
  if (!left || !right) return false;

  const leftBuffer = Buffer.from(String(left), 'hex');
  const rightBuffer = Buffer.from(String(right), 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'failed', message: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const secretKey = getPaystackSecretKey(process.env);
  if (!secretKey) {
    return res.status(503).json({ status: 'failed', message: 'Missing PAYSTACK_SECRET_KEY' });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = getHeader(req, 'x-paystack-signature');
    const expectedSignature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

    if (!timingSafeEqualHex(signature, expectedSignature)) {
      return res.status(401).json({ status: 'failed', message: 'Invalid Paystack signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8') || '{}');
    if (payload?.event !== 'charge.success') {
      return res.json({ status: 'success', ignored: true });
    }

    const reference = String(payload?.data?.reference || '').trim();
    if (!reference) {
      return res.status(400).json({ status: 'failed', message: 'Missing Paystack webhook reference' });
    }

    const transaction = await verifyPaystackTransaction(secretKey, reference);
    const result = await applyVerifiedPaystackPayment(supabaseAdmin, transaction, { reference });

    return res.json({ status: 'success', result });
  } catch (error) {
    console.error('[api/paystack-webhook] webhook failed:', error);
    return res.status(500).json({
      status: 'failed',
      message: error?.message || 'Unable to process Paystack webhook',
    });
  }
}
