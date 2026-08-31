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
// notes do not consume that quota. Every note carries the rigid marker OPENAI_DOWNSTREAM_EVENT_V1
// plus a JSON record. The deterministic OpenAI event id (`hs_<contactId>_<event>`) is the
// idempotency key. Lifecycle: a `pending` note is written BEFORE the OpenAI request and updated
// in place to `succeeded`/`failed` after. A `succeeded` record blocks duplicates; a recent
// `pending` blocks concurrent execution; a `failed`/stale-`pending` record is retried reusing the
// SAME event id and the SAME original event timestamp (so a retry can never create a second
// conversion — OpenAI also dedupes by id). Successful notes are never deleted.
//
// Env vars (Vercel — Sensitive):
//   OPENAI_ADS_API_KEY         REUSED: Bearer for the OpenAI Ads Conversions API
//   OPENAI_VALIDATE_ONLY       REUSED: 'true' forces validate_only for ALL sends (Preview=true kill-switch)
//   DOWNSTREAM_SECRET          NEW: caller sends header `x-downstream-secret` (different value per env)
//   HUBSPOT_PRIVATE_APP_TOKEN  NEW: HubSpot private app; scopes crm.objects.contacts.read + .write
//                                   (HubSpot Notes API is governed by contact scopes)
//
// Auth model: server-to-server only. Secret lives only in a Vercel env var, travels in a request
// header over HTTPS, and is checked before any contact data is read or event is sent. No browser
// secret. Do not call this from client-side JavaScript.

import crypto from 'crypto';

// ---- Constants ------------------------------------------------------------
const PIXEL_ID = 'EHzs668NexotXGL3V8rNhm';
const OPENAI_EVENTS_URL = `https://bzr.openai.com/v1/events?pid=${PIXEL_ID}`;
const HUBSPOT_BASE = 'https://api.hubapi.com';

const STANDARD_EVENTS = new Set(['appointment_scheduled']);
const CUSTOM_EVENTS = new Set(['qualified_lead', 'proposal_sent', 'client_won']);
const AMOUNT_EVENTS = new Set(['proposal_sent', 'client_won']);
const ALL_EVENTS = new Set([...STANDARD_EVENTS, ...CUSTOM_EVENTS]);
const VALID_ACTION_SOURCES = new Set(['web', 'offline', 'phone_call', 'email', 'other', 'physical_store']);

// OpenAI accepts timestamps within the last 7 days and up to 10 minutes in the future.
const WINDOW_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS = 10 * 60 * 1000;
// A `pending` note younger than this is treated as an in-flight concurrent attempt; older = stale/retryable.
const PENDING_TTL_MS = 10 * 60 * 1000;

const MARKER = 'OPENAI_DOWNSTREAM_EVENT_V1';
const NOTE_TO_CONTACT_ASSOC = 202; // HubSpot default note->contact association type id

// ---- Small helpers --------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();

function getUrlParam(url, key) {
  const m = String(url || '').match(new RegExp('[?&]' + key + '=([^&]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function eventId(contactId, event) { return `hs_${contactId}_${event}`; }

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
  return { ok: res.ok, status: res.status, json, text: text ? text.slice(0, 600) : '' };
}

async function getContact(contactId) {
  const props = ['email', 'landing_page_url', 'hs_lead_status', 'utm_source', 'firstname', 'lastname'];
  return hubspot(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${props.join(',')}`, { method: 'GET' });
}

// Build the note body: rigid marker header line + JSON record.
function noteBody(record) {
  return `${MARKER} status=${record.status} event=${record.event} id=${record.event_id}\n${JSON.stringify(record)}`;
}
function parseNote(body) {
  if (!body || !body.includes(MARKER)) return null;
  const m = body.match(/\{[\s\S]*\}\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Find the existing downstream note for this exact deterministic event id (idempotency key).
// Returns { ok, note: { noteId, record } | null }. ok:false means idempotency could not be
// verified (HubSpot error) — the caller MUST NOT send in that case.
async function findEventNote(contactId, id) {
  const assoc = await hubspot(`/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/notes?limit=100`, { method: 'GET' });
  if (!assoc.ok) return { ok: false, status: assoc.status, body: assoc.text };
  const ids = (assoc.json && assoc.json.results ? assoc.json.results : [])
    .map((r) => r.toObjectId || (r.to && r.to.id)).filter(Boolean);
  if (!ids.length) return { ok: true, note: null };
  const batch = await hubspot(`/crm/v3/objects/notes/batch/read`, {
    method: 'POST',
    body: JSON.stringify({ properties: ['hs_note_body'], inputs: ids.map((x) => ({ id: String(x) })) }),
  });
  if (!batch.ok) return { ok: false, status: batch.status, body: batch.text };
  let best = null;
  for (const n of (batch.json && batch.json.results ? batch.json.results : [])) {
    const rec = parseNote((n.properties && n.properties.hs_note_body) || '');
    if (rec && rec.event_id === id) {
      if (!best || (rec.created_ts || 0) > (best.record.created_ts || 0)) best = { noteId: n.id, record: rec };
    }
  }
  return { ok: true, note: best };
}

async function createNote(contactId, record) {
  return hubspot(`/crm/v3/objects/notes`, {
    method: 'POST',
    body: JSON.stringify({
      properties: { hs_note_body: noteBody(record), hs_timestamp: Date.now() },
      associations: [{ to: { id: String(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT_ASSOC }] }],
    }),
  });
}
async function updateNote(noteId, record) {
  return hubspot(`/crm/v3/objects/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { hs_note_body: noteBody(record) } }),
  });
}

// ---- OpenAI ---------------------------------------------------------------
function buildEvent({ event, id, timestampMs, oppref, sourceUrl, actionSource, emailSha256, amountCents, currency }) {
  const isCustom = CUSTOM_EVENTS.has(event);
  const data = { type: isCustom ? 'custom' : 'customer_action' };
  if (AMOUNT_EVENTS.has(event)) { data.amount = amountCents; data.currency = currency; }
  const ev = { id, type: isCustom ? 'custom' : event, timestamp_ms: timestampMs, action_source: actionSource, oppref, data };
  if (isCustom) ev.custom_event_name = event;
  if (actionSource === 'web' && sourceUrl) ev.source_url = sourceUrl;
  if (emailSha256) ev.user = { email_sha256: emailSha256 };
  return ev;
}
async function sendToOpenAI(event, validateOnly) {
  const res = await fetch(OPENAI_EVENTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_ADS_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ validate_only: validateOnly, integration_source: 'jmt-downstream', events: [event] }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 800) };
}

// ---- Handler --------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'downstream-events', marker: MARKER, events: [...ALL_EVENTS] });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // (1) Auth gate — fails closed when the secret is unset.
  if (!secretMatches(req.headers['x-downstream-secret'], process.env.DOWNSTREAM_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  if (!b || typeof b !== 'object') b = {};
  const { contactId, event, eventTimeIso, humanConfirmed, amountCents, currency, actionSource, authorizedUser, note, validateOnly, testOppref } = b;

  const forceValidate = String(process.env.OPENAI_VALIDATE_ONLY) === 'true';
  const isValidate = validateOnly === true || forceValidate;

  // (2) Input validation (applies to both live and validate calls).
  if (!ALL_EVENTS.has(event)) return res.status(400).json({ error: 'invalid_event', allowed: [...ALL_EVENTS] });
  const chosenActionSource = actionSource || (event === 'appointment_scheduled' ? 'web' : 'offline');
  if (!VALID_ACTION_SOURCES.has(chosenActionSource)) return res.status(400).json({ error: 'invalid_action_source', allowed: [...VALID_ACTION_SOURCES] });
  if (AMOUNT_EVENTS.has(event)) {
    if (!Number.isInteger(amountCents) || amountCents < 0) return res.status(400).json({ error: 'amount_required', detail: 'amountCents must be a non-negative integer (minor units / cents)' });
    if (!currency || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'currency_required', detail: 'currency must be a 3-letter ISO 4217 code, e.g. USD' });
  }

  // ---- VALIDATE-ONLY schema path (NO HubSpot side effects; no notes) -------
  if (validateOnly === true) {
    const ev = buildEvent({
      event, id: eventId(contactId || 'TESTCONTACT', event), timestampMs: Date.now(),
      oppref: testOppref || 'VALIDATE_ONLY_SAMPLE_OPPREF',
      sourceUrl: 'https://jaxmediateam.com/jacksonville-digital-marketing-agency',
      actionSource: chosenActionSource, emailSha256: undefined, amountCents, currency,
    });
    const out = await sendToOpenAI(ev, true);
    return res.status(out.ok ? 200 : 502).json({ mode: 'validate_only', event, sent_payload: ev, openai_status: out.status, openai_body: out.body });
  }

  // ---- LIVE path ----------------------------------------------------------
  if (humanConfirmed !== true) return res.status(400).json({ error: 'human_confirmation_required' });
  if (!contactId) return res.status(400).json({ error: 'contact_id_required' });
  if (!eventTimeIso) return res.status(400).json({ error: 'event_time_required' });

  // (3) Real funnel-event time; enforce OpenAI's window; never fabricate/backfill.
  const tsMs = Date.parse(eventTimeIso);
  if (Number.isNaN(tsMs)) return res.status(400).json({ error: 'bad_event_time', detail: 'eventTimeIso must be a valid ISO-8601 datetime' });
  const now = Date.now();
  if (tsMs < now - WINDOW_PAST_MS || tsMs > now + WINDOW_FUTURE_MS) {
    return res.status(422).json({ error: 'timestamp_out_of_window', detail: 'OpenAI accepts events within the last 7 days (and <=10 min future). No backfill.', event_time: eventTimeIso });
  }

  // (4) HubSpot contact + attribution verification.
  if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) return res.status(500).json({ error: 'hubspot_token_unset' });
  const c = await getContact(contactId);
  if (c.status === 404) return res.status(404).json({ error: 'contact_not_found', contactId });
  if (!c.ok) return res.status(502).json({ error: 'hubspot_read_failed', status: c.status, body: c.text });
  const props = (c.json && c.json.properties) || {};
  const landingUrl = props.landing_page_url || '';
  const oppref = getUrlParam(landingUrl, 'oppref');
  const utmSource = (props.utm_source || getUrlParam(landingUrl, 'utm_source') || '').toLowerCase();
  if (!oppref) return res.status(422).json({ error: 'no_oppref', detail: 'Contact has no oppref in landing_page_url — cannot verify paid OpenAI attribution.' });
  if (utmSource && utmSource !== 'openai') return res.status(422).json({ error: 'not_openai_attributed', detail: `utm_source=${utmSource}` });
  if (event === 'qualified_lead' && String(props.hs_lead_status || '').toUpperCase() !== 'QUALIFIED') {
    return res.status(422).json({ error: 'lead_not_qualified', detail: 'qualified_lead may only be sent when HubSpot Lead Status = Qualified (human-set).', current_status: props.hs_lead_status || null });
  }

  const id = eventId(contactId, event);

  // (5) Idempotency by deterministic event id, via HubSpot notes. Fail closed if unverifiable.
  const look = await findEventNote(contactId, id);
  if (!look.ok) return res.status(502).json({ error: 'idempotency_check_failed', hubspot_status: look.status, hubspot_body: look.body });
  const existing = look.note;
  if (existing && existing.record.status === 'succeeded') {
    return res.status(200).json({ ok: true, already_sent: true, event, event_id: id, first_sent_ts: existing.record.sent_ts, note: 'duplicate suppressed; no second conversion sent' });
  }
  if (existing && existing.record.status === 'pending' && (now - (existing.record.created_ts || 0)) < PENDING_TTL_MS) {
    return res.status(409).json({ error: 'concurrent_execution', detail: 'A recent pending attempt for this event is in flight.', event_id: id });
  }

  // Retry (failed / stale pending) reuses the ORIGINAL event id + timestamp.
  const retryCount = existing ? ((existing.record.retry_count || 0) + 1) : 0;
  const timestampMs = existing && existing.record.event_timestamp_ms ? existing.record.event_timestamp_ms : tsMs;
  const rawEmail = normEmail(props.email);

  // (6) Write the `pending` note BEFORE the OpenAI request. If we cannot durably record intent,
  // we do NOT send (this also surfaces any missing HubSpot scope in the error body).
  const baseRecord = {
    marker: MARKER, contact_id: String(contactId), event,
    custom_event_name: CUSTOM_EVENTS.has(event) ? event : null,
    event_id: id, action_source: chosenActionSource,
    event_timestamp_ms: timestampMs, event_time_iso: eventTimeIso,
    amount_cents: AMOUNT_EVENTS.has(event) ? amountCents : null,
    currency: AMOUNT_EVENTS.has(event) ? currency : null,
    validate_only: isValidate, retry_count: retryCount,
    authorized_user: authorizedUser || null, operator_note: note || null,
    created_ts: now, sent_ts: null, openai_status: null, status: 'pending', error: null,
  };
  let noteId = existing ? existing.noteId : null;
  const pendingWrite = noteId ? await updateNote(noteId, baseRecord) : await createNote(contactId, baseRecord);
  if (!pendingWrite.ok) return res.status(500).json({ error: 'note_write_failed', hubspot_status: pendingWrite.status, hubspot_body: pendingWrite.text, hint: 'private app likely needs crm.objects.contacts.read + crm.objects.contacts.write' });
  if (!noteId) noteId = pendingWrite.json && pendingWrite.json.id;

  // (7) Send to OpenAI.
  const ev = buildEvent({ event, id, timestampMs, oppref, sourceUrl: landingUrl, actionSource: chosenActionSource, emailSha256: rawEmail ? sha256(rawEmail) : undefined, amountCents, currency });
  const out = await sendToOpenAI(ev, isValidate);

  // (8) Update the SAME note to succeeded/failed.
  const finalRecord = { ...baseRecord, status: out.ok ? 'succeeded' : 'failed', openai_status: out.status, sent_ts: Date.now(), error: out.ok ? null : out.body };
  let finalWrite = { ok: false };
  try { finalWrite = await updateNote(noteId, finalRecord); } catch (e) { finalWrite = { ok: false, error: String(e).slice(0, 120) }; }

  if (!out.ok) return res.status(502).json({ error: 'openai_rejected', event_id: id, openai_status: out.status, openai_body: out.body, note_updated: finalWrite.ok });
  return res.status(200).json({ ok: true, event, event_id: id, validate_only: isValidate, openai_status: out.status, retry_count: retryCount, note_id: noteId, note_updated: finalWrite.ok });
}
