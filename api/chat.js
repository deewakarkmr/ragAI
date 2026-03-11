import * as dotenv from 'dotenv';
import { askQuestion, GuardrailError } from '../lib/rag.js';

dotenv.config();

const RATE_LIMIT_WINDOW_MS = toInt(process.env.API_RATE_WINDOW_MS, 60000, 1000, 3600000);
const RATE_LIMIT_MAX_REQUESTS = toInt(process.env.API_RATE_MAX_REQUESTS, 12, 1, 500);
const MAX_API_MESSAGE_CHARS = toInt(process.env.MAX_INPUT_CHARS, 1200, 200, 10000);
const rateLimitBuckets = globalThis.__ragRateLimitBuckets || new Map();
globalThis.__ragRateLimitBuckets = rateLimitBuckets;

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, safe));
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function consumeRateLimit(ip) {
  const now = Date.now();
  const existing = rateLimitBuckets.get(ip);

  if (!existing || existing.resetAt <= now) {
    const next = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitBuckets.set(ip, next);
    return { blocked: false, remaining: RATE_LIMIT_MAX_REQUESTS - 1, resetAt: next.resetAt };
  }

  existing.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - existing.count);

  if (existing.count > RATE_LIMIT_MAX_REQUESTS) {
    return { blocked: true, remaining: 0, resetAt: existing.resetAt };
  }

  return { blocked: false, remaining, resetAt: existing.resetAt };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'method_not_allowed' });
  }

  const ip = getClientIp(req);
  const rateState = consumeRateLimit(ip);
  const retryAfterSec = Math.max(1, Math.ceil((rateState.resetAt - Date.now()) / 1000));

  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', rateState.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateState.resetAt / 1000));

  if (rateState.blocked) {
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({
      error: `Too many requests. Try again in ${retryAfterSec}s.`,
      code: 'api_rate_limited',
    });
  }

  try {
    const { message, history } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required', code: 'missing_input' });
    }

    if (message.length > MAX_API_MESSAGE_CHARS) {
      return res.status(400).json({
        error: `message is too long. Max ${MAX_API_MESSAGE_CHARS} characters.`,
        code: 'input_too_long',
      });
    }

    const result = await askQuestion({
      question: message,
      history: Array.isArray(history) ? history : [],
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof GuardrailError) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code || 'guardrail_violation',
      });
    }

    const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
    if (status === 429) {
      return res
        .status(429)
        .json({ error: 'Model rate limit exceeded. Wait and retry.', code: 'model_rate_limited' });
    }

    return res
      .status(500)
      .json({ error: error?.message || 'Unexpected server error', code: 'server_error' });
  }
}
