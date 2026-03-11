import * as dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { askQuestion, GuardrailError } from './lib/rag.js';

const app = express();
const port = process.env.PORT || 4000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.join(__dirname, 'client', 'dist');

const RATE_LIMIT_WINDOW_MS = toInt(process.env.API_RATE_WINDOW_MS, 60000, 1000, 3600000);
const RATE_LIMIT_MAX_REQUESTS = toInt(process.env.API_RATE_MAX_REQUESTS, 12, 1, 500);
const MAX_API_MESSAGE_CHARS = toInt(process.env.MAX_INPUT_CHARS, 1200, 200, 10000);
const rateLimitBuckets = new Map();

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
  return req.ip || req.socket?.remoteAddress || 'unknown';
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

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
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
      return res.status(429).json({ error: 'Model rate limit exceeded. Wait and retry.', code: 'model_rate_limited' });
    }

    return res.status(500).json({ error: error?.message || 'Unexpected server error', code: 'server_error' });
  }
});

app.use(express.static(clientDist));

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
