// TEMPORARY Preview-only server-side validation runner for the downstream endpoint.
// NOT for production: returns 404 unless VERCEL_ENV === 'preview'. It reads
// process.env.DOWNSTREAM_SECRET INSIDE the Preview runtime to exercise the real
// downstream handler's auth/validation/attribution/idempotency logic in-process, and
// NEVER returns, serializes, logs, or echoes any secret value. Remove before/at the
// production merge (see cleanup step). Protected by Vercel Preview Deployment Protection.
//
// Usage (GET): /api/_preview-test?contact=<hubspotTestContactId>
//   Without ?contact=, runs only the tests that need no HubSpot contact.

import downstream from './downstream.js';

// The runner makes many sequential HubSpot + OpenAI(validate_only) calls; allow more time.
export const maxDuration = 60;

const HUBSPOT_BASE = 'https://api.hubapi.com';

function mockRes() {
  const r = { _status: 200, _json: null };
  r.status = (c) => { r._status = c; return r; };
  r.json = (o) => { r._json = o; return r; };
  return r;
}
async function invoke(body, secret) {
  const headers = {};
  if (secret !== undefined) headers['x-downstream-secret'] = secret;
  const res = mockRes();
  await downstream({ method: 'POST', headers, body }, res);
  return { status: res._status, json: res._json };
}
async function hs(path, init = {}) {
  const r = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { ok: r.ok, status: r.status, json: j };
}
const setProps = (id, props) => hs(`/crm/v3/objects/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
const getProps = (id, names) => hs(`/crm/v3/objects/contacts/${id}?properties=${names.join(',')}`, { method: 'GET' });

const TEST_LANDING = 'https://jaxmediateam.com/jacksonville-digital-marketing-agency?utm_source=openai&utm_medium=cpc&utm_campaign=downstream_test&oppref=TEST_ONLY_OPPREF_DOWNSTREAM';

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return res.status(404).json({ error: 'not_found' });

  const results = [];
  const rec = (name, pass, detail) => results.push({ name, pass, detail: detail || {} });
  try {
  const contactId = (() => { try { return new URL(req.url, 'http://x').searchParams.get('contact'); } catch { return null; } })();
  const secret = process.env.DOWNSTREAM_SECRET;
  const nowIso = new Date().toISOString();

  // ---------- Authentication ----------
  let r = await invoke({ event: 'qualified_lead', validateOnly: true }, undefined);
  rec('auth_missing_secret_rejected', r.status === 401, { status: r.status });
  r = await invoke({ event: 'qualified_lead', validateOnly: true }, 'DELIBERATELY_WRONG_TEST_VALUE');
  rec('auth_wrong_secret_rejected', r.status === 401, { status: r.status });
  r = await invoke({ event: 'appointment_scheduled', validateOnly: true }, secret);
  rec('auth_correct_secret_accepted', r.status === 200, { status: r.status });

  // ---------- validateOnly payload shape (local build) + OpenAI validate_only ----------
  const payloadTests = [
    ['appointment_scheduled', { event: 'appointment_scheduled', validateOnly: true, actionSource: 'web' },
      ev => ev.type === 'appointment_scheduled' && ev.data.type === 'customer_action' && ev.action_source === 'web' && !!ev.source_url && !!ev.oppref && typeof ev.timestamp_ms === 'number' && /^hs_/.test(ev.id)],
    ['qualified_lead', { event: 'qualified_lead', validateOnly: true },
      ev => ev.type === 'custom' && ev.custom_event_name === 'qualified_lead' && ev.data.type === 'custom' && !!ev.oppref],
    ['proposal_sent', { event: 'proposal_sent', validateOnly: true, amountCents: 480000, currency: 'USD' },
      ev => ev.type === 'custom' && ev.custom_event_name === 'proposal_sent' && ev.data.type === 'custom' && ev.data.amount === 480000 && ev.data.currency === 'USD'],
    ['client_won', { event: 'client_won', validateOnly: true, amountCents: 600000, currency: 'USD' },
      ev => ev.type === 'custom' && ev.custom_event_name === 'client_won' && ev.data.type === 'custom' && ev.data.amount === 600000 && ev.data.currency === 'USD'],
  ];
  for (const [nm, body, assert] of payloadTests) {
    const rr = await invoke(body, secret);
    const ev = rr.json && rr.json.sent_payload;
    const shapeOk = !!(ev && assert(ev));
    rec(`payload_shape_${nm}`, shapeOk, { status: rr.status, mode: rr.json && rr.json.mode, openai_status: rr.json && rr.json.openai_status, type: ev && ev.type, custom_event_name: ev && ev.custom_event_name, data_type: ev && ev.data && ev.data.type, amount: ev && ev.data && ev.data.amount, currency: ev && ev.data && ev.data.currency, has_oppref: !!(ev && ev.oppref), source_url_when_web: nm === 'appointment_scheduled' ? !!(ev && ev.source_url) : 'n/a' });
    rec(`openai_validate_${nm}`, (rr.json && (rr.json.openai_status === 200 || rr.json.openai_status === 202)) || false, { openai_status: rr.json && rr.json.openai_status, note: 'validate_only=true; a non-2xx here typically means OpenAI wants a genuine oppref' });
  }

  // ---------- Input / timestamp validation (no contact) ----------
  r = await invoke({ event: 'qualified_lead', contactId: 'x', eventTimeIso: nowIso }, secret);
  rec('missing_human_confirmation_rejected', r.status === 400 && r.json.error === 'human_confirmation_required', { status: r.status, error: r.json && r.json.error });
  r = await invoke({ event: 'appointment_scheduled', contactId: '000000000000', eventTimeIso: nowIso, humanConfirmed: true }, secret);
  rec('nonexistent_contact_rejected', r.status === 404 && r.json.error === 'contact_not_found', { status: r.status, error: r.json && r.json.error });
  r = await invoke({ event: 'appointment_scheduled', contactId: '000000000000', eventTimeIso: '2020-01-01T00:00:00Z', humanConfirmed: true }, secret);
  rec('timestamp_past_out_of_window_rejected', r.status === 422 && r.json.error === 'timestamp_out_of_window', { status: r.status, error: r.json && r.json.error });
  r = await invoke({ event: 'appointment_scheduled', contactId: '000000000000', eventTimeIso: new Date(Date.now() + 3600000).toISOString(), humanConfirmed: true }, secret);
  rec('timestamp_future_out_of_window_rejected', r.status === 422 && r.json.error === 'timestamp_out_of_window', { status: r.status, error: r.json && r.json.error });
  r = await invoke({ event: 'appointment_scheduled', contactId: '000000000000', eventTimeIso: 'not-a-date', humanConfirmed: true }, secret);
  rec('malformed_timestamp_rejected', r.status === 400 && r.json.error === 'bad_event_time', { status: r.status, error: r.json && r.json.error });

  // ---------- Secret never present in results ----------
  rec('secret_absent_from_all_results', secret ? !JSON.stringify(results).includes(secret) : true, {});
  rec('preview_validate_only_mode', String(process.env.OPENAI_VALIDATE_ONLY) === 'true', { value_hidden: true });

  // ---------- Contact-dependent (labeled internal test contact) ----------
  if (contactId) {
    const NAMES = ['email', 'landing_page_url', 'hs_lead_status', 'utm_source'];
    const before = await getProps(contactId, NAMES);
    const bp = (before.json && before.json.properties) || {};

    // ensure a valid test landing url with oppref + openai
    await setProps(contactId, { landing_page_url: TEST_LANDING, utm_source: 'openai' });

    // missing oppref rejected
    await setProps(contactId, { landing_page_url: 'https://jaxmediateam.com/jacksonville-digital-marketing-agency?utm_source=openai&utm_medium=cpc' });
    r = await invoke({ event: 'appointment_scheduled', contactId, eventTimeIso: nowIso, humanConfirmed: true }, secret);
    rec('missing_oppref_rejected', r.status === 422 && r.json.error === 'no_oppref', { status: r.status, error: r.json && r.json.error });

    // non-openai attribution rejected
    await setProps(contactId, { landing_page_url: 'https://jaxmediateam.com/x?utm_source=facebook&utm_medium=cpc&oppref=TEST_ONLY_OPPREF_DOWNSTREAM', utm_source: 'facebook' });
    r = await invoke({ event: 'appointment_scheduled', contactId, eventTimeIso: nowIso, humanConfirmed: true }, secret);
    rec('non_openai_attribution_rejected', r.status === 422 && r.json.error === 'not_openai_attributed', { status: r.status, error: r.json && r.json.error });

    // restore valid attribution
    await setProps(contactId, { landing_page_url: TEST_LANDING, utm_source: 'openai' });

    // qualified_lead gating
    const setStatus = await setProps(contactId, { hs_lead_status: 'CONNECTED' });
    r = await invoke({ event: 'qualified_lead', contactId, eventTimeIso: nowIso, humanConfirmed: true }, secret);
    rec('qualified_lead_gated_when_not_qualified', r.status === 422 && r.json.error === 'lead_not_qualified', { status: r.status, error: r.json && r.json.error, set_status_ok: setStatus.ok });
    const setQ = await setProps(contactId, { hs_lead_status: 'QUALIFIED' });
    r = await invoke({ event: 'qualified_lead', contactId, eventTimeIso: nowIso, humanConfirmed: true }, secret);
    rec('qualified_lead_accepted_when_qualified', r.status === 200 && r.json.ok === true, { status: r.status, set_qualified_ok: setQ.ok, already_sent: r.json && r.json.already_sent, event_id: r.json && r.json.event_id });
    await setProps(contactId, { hs_lead_status: 'CONNECTED' }); // restore labeled test status

    // idempotency (appointment_scheduled full flow; OpenAI send is validate-only via env)
    const first = await invoke({ event: 'appointment_scheduled', contactId, eventTimeIso: nowIso, humanConfirmed: true, authorizedUser: 'preview-runner' }, secret);
    rec('idempotency_first_send_ok', first.status === 200 && first.json.ok === true, { status: first.status, already_sent: first.json && first.json.already_sent, event_id: first.json && first.json.event_id, note_id: first.json && first.json.note_id, note_updated: first.json && first.json.note_updated });
    const second = await invoke({ event: 'appointment_scheduled', contactId, eventTimeIso: nowIso, humanConfirmed: true }, secret);
    rec('idempotency_duplicate_suppressed', second.status === 200 && second.json.already_sent === true && second.json.event_id === first.json.event_id, { status: second.status, already_sent: second.json && second.json.already_sent, same_event_id: second.json && first.json && second.json.event_id === first.json.event_id });

    rec('test_contact_used', true, { contact_id: contactId, original_status_restored_to: 'CONNECTED (labeled test)', had_status_before: bp.hs_lead_status || null });
  }

  const summary = {
    total: results.length,
    passed: results.filter((x) => x.pass).length,
    failed: results.filter((x) => !x.pass).map((x) => x.name),
    vercel_env: process.env.VERCEL_ENV,
    openai_validate_only: String(process.env.OPENAI_VALIDATE_ONLY) === 'true',
    contact_tested: !!contactId,
  };
  return res.status(200).json({ summary, results });
  } catch (e) {
    return res.status(200).json({ crashed: true, error: String((e && e.message) || e).slice(0, 400), stack: String((e && e.stack) || '').slice(0, 1200), results_so_far: results });
  }
}
