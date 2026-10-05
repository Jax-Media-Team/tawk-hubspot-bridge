// Vercel serverless function: Tawk.to "New Chat Transcript" webhook -> HubSpot Forms API bridge.
// Parses the lead-capture form embedded in the chat transcript and forwards it to HubSpot.
//
// Reliability (added 2026-10-05):
//   - Bounded retries on TRANSIENT HubSpot failures (429 / 5xx / network), with backoff.
//   - 4xx (bad data) is treated as permanent and NOT retried.
//   - Duplicate protection: HubSpot Forms "create or update" dedupes the CONTACT by email,
//     so retries (or a Tawk re-delivery) never create a duplicate contact. A duplicate form-
//     submission ROW is only possible on an ambiguous network timeout and is harmless.
//   - On UNRESOLVED delivery failure, emails an alert (incl. the lead's details for manual
//     recovery) via an existing notification service.
//   - Chats with NO email are an expected skip and stay SILENT (no alert).

const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const HUBSPOT_FORM_GUID = process.env.HUBSPOT_FORM_GUID;
const TAWK_WEBHOOK_SECRET = process.env.TAWK_WEBHOOK_SECRET;

// Give the function headroom for bounded retries + Retry-After waits.
export const maxDuration = 30;

// Retry tuning.
const MAX_ATTEMPTS = 3; // total HubSpot submit attempts (1 try + 2 retries)
const RETRY_BASE_MS = 500; // exponential backoff base: 500ms, 1000ms
const RETRY_AFTER_CAP_MS = 10000; // never wait longer than this on a Retry-After header

// Where to submit. Defaults to the real HubSpot Forms endpoint; overridable only so the
// failure/retry path can be exercised in a test (e.g. point at a 503 mock), then reverted.
const HUBSPOT_SUBMIT_URL =
  process.env.HUBSPOT_SUBMIT_URL ||
  `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_GUID}`;

// Alerting (configure ONE of these in Vercel; alert fires only on UNRESOLVED failure).
//   RESEND_API_KEY  -> email via Resend to ALERT_EMAIL_TO
//   ALERT_WEBHOOK_URL -> POST the alert JSON to an existing notification endpoint
// If neither is set, the alert is written to the function log (console.error) as a fallback.
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || 'pcruz@jaxmediateam.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM = process.env.ALERT_FROM || 'alerts@jaxmediateam.com';
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL; // e.g. a Google Apps Script web app
const ALERT_WEBHOOK_SECRET = process.env.ALERT_WEBHOOK_SECRET; // shared secret the receiver verifies

function parseFormText(text) {
  const formOnly = String(text || '').split(/,(?!\s)/)[0];
  const lines = formOnly.split(/\r?\n/);
  const out = { name: '', email: '', phone: '', services: '', website: '', comments: '' };
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'name') out.name = val;
    else if (key === 'email') out.email = val;
    else if (key === 'phone') out.phone = val;
    else if (key.indexOf('service') >= 0) out.services = val;
    else if (key.indexOf('website') === 0) out.website = val;
    else if (key.indexOf('comments') === 0) out.comments = val;
  }
  return out;
}

function splitName(full) {
  const trimmed = String(full || '').trim();
  if (!trimmed) return { firstname: '', lastname: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (status) => status === 429 || (status >= 500 && status <= 599);

// Parse a Retry-After header (delta-seconds or an HTTP-date) into milliseconds, or null.
function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

// Submit to HubSpot with bounded retries. Retries only on transient signals (429 / 5xx /
// network); never after a success and never on 4xx (permanent). On 429 (or any transient that
// provides Retry-After) it honors that header, capped. Returns { ok, status, body, attempts,
// permanent }.
async function submitToHubSpot(hsBody) {
  let lastStatus = 0;
  let lastText = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let retryAfterMs = null;
    try {
      const hsRes = await fetch(HUBSPOT_SUBMIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hsBody),
      });
      lastStatus = hsRes.status;
      retryAfterMs = parseRetryAfterMs(hsRes.headers.get('retry-after'));
      lastText = await hsRes.text();
      if (hsRes.ok) return { ok: true, status: hsRes.status, attempts: attempt };
      if (!isTransient(hsRes.status)) {
        return { ok: false, status: hsRes.status, body: lastText, attempts: attempt, permanent: true };
      }
      console.log(
        `[bridge] HubSpot transient ${hsRes.status} on attempt ${attempt}/${MAX_ATTEMPTS}` +
          (retryAfterMs != null ? ` (Retry-After ${Math.round(retryAfterMs / 1000)}s)` : '')
      );
    } catch (e) {
      lastStatus = 0; // network/timeout -> transient (ambiguous)
      lastText = String(e).slice(0, 200);
      console.log(`[bridge] HubSpot network error on attempt ${attempt}/${MAX_ATTEMPTS}: ${lastText}`);
    }
    if (attempt < MAX_ATTEMPTS) {
      // Honor Retry-After when HubSpot sent one (capped); otherwise exponential backoff.
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const wait = retryAfterMs != null ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS) : backoff;
      await sleep(wait);
    }
  }
  return { ok: false, status: lastStatus, body: lastText, attempts: MAX_ATTEMPTS, permanent: false };
}

// Fire ONLY on unresolved failure. Never throws (alerting must not break the handler).
async function sendFailureAlert(subject, text) {
  try {
    if (RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_EMAIL_TO], subject, text }),
      });
      console.log('[bridge] alert via Resend status=', r.status);
      return;
    }
    if (ALERT_WEBHOOK_URL) {
      // The receiver (Google Apps Script) verifies `secret` and ignores any recipient we send;
      // it always mails the fixed address configured on its side.
      const r = await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: ALERT_WEBHOOK_SECRET, to: ALERT_EMAIL_TO, subject, text }),
      });
      console.log('[bridge] alert via webhook status=', r.status);
      return;
    }
    console.error('[bridge][ALERT - no channel configured]', subject, '::', text);
  } catch (e) {
    console.error('[bridge][ALERT send failed]', String(e).slice(0, 200));
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'tawk-hubspot-bridge' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (TAWK_WEBHOOK_SECRET) {
    const provided = req.headers['x-tawk-signature'] || req.headers['x-webhook-secret'];
    if (provided !== TAWK_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'invalid json' });
  }

  const event = payload.event || payload.eventName || payload.type || '';
  console.log('[bridge] event=', event, 'keys=', Object.keys(payload).join(','));

  const chat = payload.chat || {};
  const visitor = payload.visitor || chat.visitor || payload.property?.visitor || {};
  const messages = chat.messages || payload.messages || payload.transcript || [];

  console.log(
    '[bridge] chat keys=',
    Object.keys(chat).join(','),
    ' visitor keys=',
    Object.keys(visitor).join(','),
    ' messages count=',
    Array.isArray(messages) ? messages.length : 'not-array'
  );

  if (Array.isArray(messages)) {
    messages.slice(0, 3).forEach((m, i) => {
      console.log(
        `[bridge] msg[${i}] keys=`,
        Object.keys(m).join(','),
        ' sample=',
        JSON.stringify(m).slice(0, 300)
      );
    });
  }

  // Find the form-dump message. Prefer one with "Name :" line.
  let firstMsgText = '';
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const text = m.msg || m.text || m.message || m.body || '';
      if (typeof text === 'string' && /\bName\s*:/.test(text) && /\bEmail\s*:/.test(text)) {
        firstMsgText = text;
        break;
      }
    }
    if (!firstMsgText) {
      firstMsgText = messages
        .map((m) => m.msg || m.text || m.message || m.body || '')
        .filter((s) => typeof s === 'string')
        .join('\n');
    }
  }

  const parsed = parseFormText(firstMsgText);

  const email = parsed.email || visitor.email || visitor.e || payload.email || '';
  if (!email) {
    // Expected skip (visitor never provided an email). Stay silent - no alert.
    console.log('[bridge] no email found, skipping. firstMsg sample=', firstMsgText.slice(0, 200));
    return res.status(200).json({ skipped: true, reason: 'no email', event });
  }

  const fullName = parsed.name || visitor.name || visitor.n || '';
  const { firstname, lastname } = splitName(fullName);

  // HubSpot 'message' is a standard property; combine services + comments here so
  // sales reps see both without us needing a custom property.
  const messageParts = [];
  if (parsed.services) messageParts.push(`Services interested in: ${parsed.services}`);
  if (parsed.comments) messageParts.push(`Comments: ${parsed.comments}`);
  const message = messageParts.join('\n\n');

  const fields = [
    { name: 'email', value: email },
    { name: 'firstname', value: firstname },
    { name: 'lastname', value: lastname },
    { name: 'phone', value: parsed.phone },
    { name: 'website', value: parsed.website },
    { name: 'message', value: message },
  ].filter((f) => f.value);

  const hsBody = {
    fields,
    context: {
      pageUri: 'https://jaxmediateam.com/',
      pageName: 'Tawk.to live chat',
    },
  };

  const result = await submitToHubSpot(hsBody);
  if (result.ok) {
    return res.status(200).json({ ok: true, fields: fields.map((f) => f.name), attempts: result.attempts });
  }

  // Unresolved delivery failure after retries -> alert with the lead's details for manual recovery.
  const kind = result.permanent ? 'permanent (HubSpot rejected)' : 'transient (exhausted retries)';
  const alertText =
    `A Tawk->HubSpot lead failed to deliver (${kind}) after ${result.attempts} attempt(s).\n\n` +
    `HubSpot status: ${result.status}\n` +
    `Response: ${String(result.body || '').slice(0, 300)}\n\n` +
    `--- Lead (add manually if needed) ---\n` +
    `Name: ${fullName || '(none)'}\n` +
    `Email: ${email}\n` +
    `Phone: ${parsed.phone || '(none)'}\n` +
    `Website: ${parsed.website || '(none)'}\n` +
    `Services: ${parsed.services || '(none)'}\n` +
    `Comments: ${parsed.comments || '(none)'}\n`;
  await sendFailureAlert('Tawk->HubSpot lead delivery FAILED', alertText);

  return res.status(502).json({ error: 'hubspot delivery failed', status: result.status, attempts: result.attempts });
}
