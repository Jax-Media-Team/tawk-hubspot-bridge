// Vercel serverless function: AUTHENTICATED MANUAL TRIGGER for DOWNSTREAM OpenAI Ads
// conversion events. Additive + isolated — it does NOT import from, modify, or share code
// with api/openai-conversions.js (the working lead_created handler) or api/webhook.js.
//
// Supported events (one per HubSpot contact per funnel stage):
//   appointment_scheduled  (STANDARD event)  data.type: customer_action
//   qualified_lead         (CUSTOM event)    data.type: custom
//   proposal_sent          (CUSTOM event)    data.type: custom  + amount/currency
//   client_won             (CUSTOM event)    data.type: custom  + amount/currency
//
// Attribution: oppref is parsed from the HubSpot contact's `landing_page_url` property and
// passed to OpenAI UNCHANGED. The event is refused if paid-OpenAI attribution can't be verified.
//
// Idempotency + durable audit: HubSpot NOTES (engagements) associated to the contact — chosen
// over custom properties because the free plan is at 9/10 custom properties (1 slot left) and
// notes do not consume that quota. Each send writes a machine-parseable audit note; a pre-send
// check refuses a duplicate. The OpenAI event id is deterministic (`hs_<contactId>_<event>`),
// so even a retry can never create a second conversion (OpenAI dedupes by id), and a retry
// reuses the original event timestamp recorded in the prior note.
//
// Env vars (Vercel — Production and Preview):
//   OPENAI_ADS_API_KEY         (secret)  REUSED: Bearer for the OpenAI Ads Conversions API
//   OPENAI_VALIDATE_ONLY       REUSED: when 'true', forces validate_only for ALL sends (safety)
//   DOWNSTREAM_SECRET          (secret)  NEW: caller must send header `x-downstream-secret`
//   HUBSPOT_PRIVATE_APP_TOKEN  (secret)  NEW: HubSpot private-app token
//                                        scopes: crm.objects.contacts.read,
//                                                crm.objects.notes.read, crm.objects.notes.write
//
// Auth model: server-to-server only. The secret lives only in a Vercel env var, travels in a
// request header over HTTPS, and is checked before any contact data is read or event is sent.
// There is NO browser-exposed secret. Do not call this from client-side JavaScript.

import crypto from 'crypto';

// ---- Constants ------------------------------------------------------------
const PIXEL_ID = 'EHzs668NexotXGL3V8rNhm'; // OpenAI data source (Jax Media Team, Web) — same as lead_created
const OPENAI_EVENTS_URL = `https://bzr.openai.com/v1/events?pid=${PIXEL_ID}`;
const HUBSPOT_BASE = 'https://api.hubapi.com';

const STANDARD_EVENTS = new Set(['appointment_scheduled']);
const CUSTOM_EVENTS = new Set(['qualified_lead', 'proposal_sent', 'client_won']);
const AMOUNT_EVENTS = new Set(['proposal_sent', 'client_won']); // require amount + currency
const ALL_EVENTS = new Set([...STANDARD_EVENTS, ...CUSTOM_EVENTS]);
const VALID_ACTION_SOURCES = new Set(['web', 'offline', 'phone_call', 'email', 'other', 'physical_store']);

// OpenAI accepts timestamps within the last 7 days and up to 10 minutes in the future.
const WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 10 * 60 * 1000;

const AUDIT_TAG = '[OAI-DOWNSTREAM]'; // marker prefixed on every audit note for idempotency scanning

// ---- Small helpers --------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();

function getUrlParam(url, key) {
  const m = String(url || '').match(new RegExp('[?&]' + key + '=([^&]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function eventId(contactId, event) {
  return `hs_${contactId}_${event}`; // deterministic — one id per contact per funnel stage
}

// Timing-safe secret comparison.
function secretMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- HubSpot helpers ------------------------------------------------------
async function hubspot(path, init = {}) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function getContact(contactId) {
  const props = ['email', 'landing_page_url', 'hs_lead_status', 'utm_source', 'firstname', 'lastname'];
  const r = await hubspot(
    `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${props.join(',')}`,
    { method: 'GET' }
  );
  return r;
}

// Fetch audit notes already associated with this contact, newest-first, and return the parsed
// marker objects so we can (a) block duplicates and (b) reuse the original timestamp on retry.
async function getAuditNotes(contactId) {
  // Get associated note ids, then batch-read their bodies.
  const assoc = await hubspot(
    `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/notes?limit=100`,
    { method: 'GET' }
  );
  const ids = (assoc.json && assoc.json.results ? assoc.json.results : [])
    .map((r) => r.toObjectId || (r.to && r.to.id))
    .filter(Boolean);
  if (!ids.length) return [];
  const batch = await hubspot(`/crm/v3/objects/notes/batch/read`, {
    method: 'POST',
    body: JSON.stringify({ properties: ['hs_note_body'], inputs: ids.map((id) => ({ id })) }),
  });
  const notes = (batch.json && batch.json.results ? batch.json.results : [])
    .map((n) => (n.properties && n.properties.hs_note_body) || '')
    .filter((body) => body.includes(AUDIT_TAG));
  // Parse the embedded JSON payload from each of our audit notes.
  const parsed = [];
  for (const body of notes) {
    const m = body.match(/\{[\s\S]*\}\s*$/);
    if (!m) continue;
    try { parsed.push(JSON.parse(m[0])); } catch { /* skip unparseable */ }
  }
  return parsed;
}

async function writeAuditNote(contactId, record) {
  const human =
    `${AUDIT_TAG} event=${record.event}` +
    (record.custom_event_name ? ` (${record.custom_event_name})` : '') +
    ` result=${record.result} id=${record.event_id}` +
    ` sent_ts=${record.sent_ts}\n` +
    JSON.stringify(record);
  const body = {
    properties: { hs_note_body: human, hs_timestamp: Date.now() },
    associations: [
      {
        to: { id: String(contactId) },
        // 202 = HubSpot's default Note→Contact association type id.
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      },
    ],
  };
  return hubspot(`/crm/v3/objects/notes`, { method: 'POST', body: JSON.stringify(body) });
}

// ---- OpenAI payload builder ----------------------------------------------
function buildEvent({ event, id, timestampMs, oppref, sourceUrl, actionSource, emailSha256, amountCents, currency }) {
  const isCustom = CUSTOM_EVENTS.has(event);
  const data = { type: isCustom ? 'custom' : 'customer_action' };
  if (AMOUNT_EVENTS.has(event)) {
    data.amount = amountCents;      // integer minor units (cents)
    data.currency = currency;       // ISO 4217, e.g. USD
  }
  const ev = {
    id,
    type: isCustom ? 'custom' : event,
    timestamp_ms: timestampMs,
    action_source: actionSource,
    oppref,                         // passed through unchanged
    data,
  };
  if (isCustom) ev.custom_event_name = event;
  if (actionSource === 'web' && sourceUrl) ev.source_url = sourceUrl; // required for web
  if (emailSha256) ev.user = { email_sha256: emailSha256 }; // mirrors the lead_created handler
  return ev;
}

async function sendToOpenAI(event, validateOnly) {
  const res = await fetch(OPENAI_EVENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_ADS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ validate_only: validateOnly, integration_source: 'jmt-downstream', events: [event] }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 800) };
}

// ---- Handler --------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'downstream-events', events: [...ALL_EVENTS] });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // (1) Auth gate — fails closed when the secret is unset.
  if (!secretMatches(req.headers['x-downstream-secret'], process.env.DOWNSTREAM_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Parse JSON body.
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  if (!b || typeof b !== 'object') b = {};

  const {
    contactId, event, eventTimeIso, humanConfirmed,
    amountCents, currency, actionSource, authorizedUser, note, validateOnly, testOppref,
  } = b;

  // Global validate-only safety: request flag OR the env kill-switch.
  const forceValidate = String(process.env.OPENAI_VALIDATE_ONLY) === 'true';
  const isValidate = validateOnly === true || forceValidate;

  // (2) Input validation (applies to both live and validate calls).
  if (!ALL_EVENTS.has(event)) {
    return res.status(400).json({ error: 'invalid_event', allowed: [...ALL_EVENTS] });
  }
  const chosenActionSource = actionSource || (event === 'appointment_scheduled' ? 'web' : 'offline');
  if (!VALID_ACTION_SOURCES.has(chosenActionSource)) {
    return res.status(400).json({ error: 'invalid_action_source', allowed: [...VALID_ACTION_SOURCES] });
  }
  if (AMOUNT_EVENTS.has(event)) {
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      return res.status(400).json({ error: 'amount_required', detail: 'amountCents must be a non-negative integer (minor units / cents)' });
    }
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ error: 'currency_required', detail: 'currency must be a 3-letter ISO 4217 code, e.g. USD' });
    }
  }

  // ---- VALIDATE-ONLY schema path -----------------------------------------
  // Exercises the OpenAI event schema with validate_only:true and NO HubSpot side effects.
  // Uses a representative oppref (testOppref or a placeholder) purely for shape validation.
  if (validateOnly === true) {
    const ev = buildEvent({
      event,
      id: eventId(contactId || 'TESTCONTACT', event),
      timestampMs: Date.now(),
      oppref: testOppref || 'VALIDATE_ONLY_SAMPLE_OPPREF',
      sourceUrl: 'https://jaxmediateam.com/jacksonville-digital-marketing-agency',
      actionSource: chosenActionSource,
      emailSha256: undefined,
      amountCents, currency,
    });
    const out = await sendToOpenAI(ev, true);
    return res.status(out.ok ? 200 : 502).json({
      mode: 'validate_only', event, sent_payload: ev, openai_status: out.status, openai_body: out.body,
    });
  }

  // ---- LIVE path ----------------------------------------------------------
  // (3) Human confirmation is mandatory for a real send.
  if (humanConfirmed !== true) {
    return res.status(400).json({ error: 'human_confirmation_required' });
  }
  if (!contactId) return res.status(400).json({ error: 'contact_id_required' });
  if (!eventTimeIso) return res.status(400).json({ error: 'event_time_required' });

  // (4) Timestamp: use the REAL funnel-event time. Enforce OpenAI's window; never fabricate.
  const tsMs = Date.parse(eventTimeIso);
  if (Number.isNaN(tsMs)) return res.status(400).json({ error: 'bad_event_time', detail: 'eventTimeIso must be a valid ISO-8601 datetime' });
  const now = Date.now();
  if (tsMs < now - WINDOW_PAST_MS || tsMs > now + WINDOW_FUTURE_MS) {
    return res.status(422).json({
      error: 'timestamp_out_of_window',
      detail: 'OpenAI only accepts events within the last 7 days (and <=10 min in the future). Do not backfill older events.',
      event_time: eventTimeIso,
    });
  }

  // (5) Retrieve the HubSpot contact.
  if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) return res.status(500).json({ error: 'hubspot_token_unset' });
  const c = await getContact(contactId);
  if (c.status === 404) return res.status(404).json({ error: 'contact_not_found', contactId });
  if (!c.ok) return res.status(502).json({ error: 'hubspot_read_failed', status: c.status });
  const props = (c.json && c.json.properties) || {};

  // (6) Confirm paid-OpenAI attribution. oppref from landing_page_url is the source of truth.
  const landingUrl = props.landing_page_url || '';
  const oppref = getUrlParam(landingUrl, 'oppref');
  const utmSource = (props.utm_source || getUrlParam(landingUrl, 'utm_source') || '').toLowerCase();
  if (!oppref) {
    return res.status(422).json({ error: 'no_oppref', detail: 'Contact has no oppref in landing_page_url — cannot verify paid OpenAI attribution.' });
  }
  if (utmSource && utmSource !== 'openai') {
    return res.status(422).json({ error: 'not_openai_attributed', detail: `utm_source=${utmSource}`, });
  }

  // (6b) qualified_lead is gated on the human-set HubSpot Lead Status = Qualified.
  if (event === 'qualified_lead' && String(props.hs_lead_status || '').toUpperCase() !== 'QUALIFIED') {
    return res.status(422).json({
      error: 'lead_not_qualified',
      detail: 'qualified_lead may only be sent when a human has set HubSpot Lead Status to Qualified.',
      current_status: props.hs_lead_status || null,
    });
  }

  const id = eventId(contactId, event);

  // (7) Idempotency: look for a prior SUCCESS audit note for this event on this contact.
  let priorNotes = [];
  try { priorNotes = await getAuditNotes(contactId); } catch { priorNotes = []; }
  const priorSuccess = priorNotes.find((n) => n.event === event && n.result === 'success');
  const priorAny = priorNotes.find((n) => n.event === event);
  if (priorSuccess) {
    return res.status(200).json({
      ok: true, already_sent: true, event, event_id: priorSuccess.event_id,
      first_sent_ts: priorSuccess.sent_ts, note: 'duplicate suppressed; no second conversion sent',
    });
  }
  // On a retry after a prior FAILURE, reuse the original event timestamp so the id+timestamp
  // stay stable (OpenAI dedupes by id regardless).
  const retryCount = priorAny ? ((priorAny.retry_count || 0) + 1) : 0;
  const timestampMs = priorAny && priorAny.timestamp_ms ? priorAny.timestamp_ms : tsMs;

  // (8) Build + send the event.
  const rawEmail = normEmail(props.email);
  const ev = buildEvent({
    event, id, timestampMs, oppref,
    sourceUrl: landingUrl,
    actionSource: chosenActionSource,
    emailSha256: rawEmail ? sha256(rawEmail) : undefined,
    amountCents, currency,
  });

  const out = await sendToOpenAI(ev, isValidate);
  const sentTsIso = new Date().toISOString();
  const result = out.ok ? 'success' : 'failure';

  // (9) Durable audit note (redacted — never store the API key; email is hashed).
  const record = {
    tag: 'oai-downstream', event,
    custom_event_name: CUSTOM_EVENTS.has(event) ? event : null,
    event_id: id, action_source: chosenActionSource,
    timestamp_ms: timestampMs, event_time_iso: eventTimeIso, sent_ts: sentTsIso,
    amount_cents: AMOUNT_EVENTS.has(event) ? amountCents : null,
    currency: AMOUNT_EVENTS.has(event) ? currency : null,
    validate_only: isValidate, openai_status: out.status, result,
    retry_count: retryCount, authorized_user: authorizedUser || null,
    operator_note: note || null,
    error: out.ok ? null : out.body,
  };
  let noteWrite = { ok: false, status: 0 };
  try { noteWrite = await writeAuditNote(contactId, record); } catch (e) { noteWrite = { ok: false, status: 0, error: String(e).slice(0, 120) }; }

  if (!out.ok) {
    return res.status(502).json({ error: 'openai_rejected', openai_status: out.status, openai_body: out.body, audit_note_written: noteWrite.ok });
  }
  return res.status(200).json({
    ok: true, event, event_id: id, validate_only: isValidate,
    openai_status: out.status, audit_note_written: noteWrite.ok, retry_count: retryCount,
  });
}
