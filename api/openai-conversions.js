// Vercel serverless function: JotForm submission webhook -> OpenAI Ads Conversions API.
// Sends a server-side `lead_created` event so OpenAI can attribute leads back to the ad
// click via the `oppref` token captured on the landing page. Separate from api/webhook.js.
//
// Env vars (set in Vercel):
//   OPENAI_ADS_API_KEY      (secret)  Bearer token for the OpenAI Ads Conversions API
//   OPENAI_VALIDATE_ONLY    'true' (default) => validate_only:true. Set to 'false' to send live.
//   JOTFORM_WEBHOOK_SECRET  shared secret; JotForm webhook URL must include ?secret=<value>
//
// JotForm webhook URL to register:
//   https://<project>.vercel.app/api/openai-conversions?secret=<JOTFORM_WEBHOOK_SECRET>

import crypto from 'crypto';

const PIXEL_ID = 'EHzs668NexotXGL3V8rNhm'; // OpenAI data source (Jax Media Team, Web)
const OPENAI_EVENTS_URL = `https://bzr.openai.com/v1/events?pid=${PIXEL_ID}`;

// (1) Validation vs live is controlled by env, not code. Defaults to validate-only.
const VALIDATE_ONLY = process.env.OPENAI_VALIDATE_ONLY !== 'false';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

function getUrlParam(url, key) {
  const m = String(url || '').match(new RegExp('[?&]' + key + '=([^&]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// Exact key, or JotForm's "q{ID}_{uniqueName}" suffix form.
function pick(obj, name) {
  if (!obj) return '';
  if (obj[name] != null && obj[name] !== '') return obj[name];
  for (const k of Object.keys(obj)) {
    if (k === name || k.endsWith('_' + name)) {
      const v = obj[k];
      if (v != null && v !== '') return typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  return '';
}

// full_url is critical (we parse oppref from it). Find by key, else by value shape.
function pickFullUrl(obj) {
  const byKey = pick(obj, 'full_url');
  if (byKey) return byKey;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v) && (v.includes('oppref=') || v.includes('utm_source='))) {
      return v;
    }
  }
  return '';
}

// Email field key names vary in JotForm (e.g. q3_email3). Find by key hint, else by value shape.
function pickEmail(obj) {
  for (const k of Object.keys(obj)) {
    if (/email/i.test(k) && typeof obj[k] === 'string' && obj[k].includes('@')) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return v;
  }
  return '';
}

// Read + parse body. Handles JSON, urlencoded, and multipart/form-data (JotForm posts multipart).
async function readFields(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  if (ct.includes('multipart/form-data')) return parseMultipart(raw, ct);
  const out = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    out[decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '))] =
      decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
  }
  return out;
}

// Minimal multipart parser for simple text fields (JotForm sends no file uploads here).
function parseMultipart(raw, contentType) {
  const out = {};
  const m = contentType.match(/boundary=(.+)$/);
  if (!m) return out;
  const boundary = '--' + m[1].trim().replace(/^"|"$/g, '');
  for (const part of raw.split(boundary)) {
    const nameMatch = part.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    out[nameMatch[1]] = part.slice(idx + 4).replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'openai-conversions-bridge', validate_only: VALIDATE_ONLY });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // (2) Shared-secret gate. Fails closed if the secret is unset.
  if (!process.env.JOTFORM_WEBHOOK_SECRET || req.query.secret !== process.env.JOTFORM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let fields;
  try { fields = await readFields(req); } catch { return res.status(400).json({ error: 'bad body' }); }

  // JotForm nests answers in rawRequest (JSON string). Merge so pick() sees everything.
  let answers = fields;
  if (fields.rawRequest) {
    try { answers = { ...fields, ...JSON.parse(fields.rawRequest) }; } catch { /* keep fields */ }
  }

  const submissionId = pick(fields, 'submissionID') || pick(answers, 'submissionID') || pick(answers, 'submission_id');

  // (3) Never fabricate an event id. No submission id => skip.
  if (!submissionId) {
    console.log('[oai] no submissionID; skipping. keys=', Object.keys(answers).join(','));
    return res.status(200).json({ skipped: 'no_submission_id' });
  }

  const fullUrl = pickFullUrl(answers);
  const oppref = pick(answers, 'oppref') || getUrlParam(fullUrl, 'oppref');
  const olref = pick(answers, 'olref') || getUrlParam(fullUrl, 'olref'); // captured for diagnostics only
  const rawEmail = normalizeEmail(pickEmail(answers));

  // (4) Use the real submission time when present; Date.now() is an accurate fallback for
  // live webhooks (fired in real time). For any future replay, pass the stored time instead.
  const tsRaw = pick(answers, 'created_at') || pick(fields, 'created_at') || pick(answers, 'submission_date');
  const tsParsed = tsRaw ? Date.parse(tsRaw) : NaN;
  const timestampMs = !Number.isNaN(tsParsed) ? tsParsed : Date.now();

  // Spec: oppref is the only attribution field. Do not mis-map olref. No oppref => skip.
  if (!oppref) {
    console.log('[oai] no oppref; skipping', JSON.stringify({ submissionId, hasOlref: !!olref, hasFullUrl: !!fullUrl }));
    return res.status(200).json({ skipped: 'no_oppref' });
  }

  const payload = {
    validate_only: VALIDATE_ONLY,
    events: [{
      id: `jf_${submissionId}`,
      type: 'lead_created',
      timestamp_ms: timestampMs,
      oppref,
      source_url: fullUrl,
      action_source: 'web',
      user: rawEmail ? { email_sha256: sha256(rawEmail) } : {},
      data: { type: 'customer_action' },
    }],
  };

  // (5) Validation-mode diagnostics: received keys + redacted payload.
  // Never log the raw email or the API key.
  if (VALIDATE_ONLY) {
    const redacted = JSON.parse(JSON.stringify(payload));
    if (redacted.events[0].user.email_sha256) {
      redacted.events[0].user.email_sha256 = redacted.events[0].user.email_sha256.slice(0, 8) + '…';
    }
    console.log('[oai] received keys=', Object.keys(answers).join(','));
    console.log('[oai] payload(redacted)=', JSON.stringify(redacted));
  }

  try {
    const r = await fetch(OPENAI_EVENTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_ADS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    console.log('[oai] response', r.status, text.slice(0, 500));
    if (!r.ok) return res.status(502).json({ error: 'openai rejected', status: r.status, body: text.slice(0, 500) });
    return res.status(200).json({ ok: true, validate_only: VALIDATE_ONLY, id: `jf_${submissionId}` });
  } catch (e) {
    return res.status(500).json({ error: 'openai post failed', message: String(e).slice(0, 200) });
  }
}
