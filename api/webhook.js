// Tawk.to chat:end webhook -> HubSpot Forms API bridge
// Parses the pre-chat form embedded in the visitor's first message and forwards to HubSpot.

const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const HUBSPOT_FORM_GUID = process.env.HUBSPOT_FORM_GUID;
const TAWK_WEBHOOK_SECRET = process.env.TAWK_WEBHOOK_SECRET;

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

export default async function handler(req, res) {
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

  const event = payload.event || payload.eventName;
  if (event && event !== 'chat:end' && event !== 'chat:transcript_created') {
    return res.status(200).json({ skipped: true, event });
  }

  const visitor = payload.visitor || {};
  const messages = (payload.chat && payload.chat.messages) || payload.messages || [];
  const firstVisitorMsg = messages.find((m) => (m.sender && (m.sender.t === 'v' || m.sender.type === 'visitor')) || m.type === 'msg');
  const firstMsgText = firstVisitorMsg ? (firstVisitorMsg.msg || firstVisitorMsg.text || '') : '';

  const parsed = parseFormText(firstMsgText);

  const email = parsed.email || visitor.email || visitor.e || '';
  if (!email) {
    return res.status(200).json({ skipped: true, reason: 'no email' });
  }

  const fullName = parsed.name || visitor.name || visitor.n || '';
  const { firstname, lastname } = splitName(fullName);

  const fields = [
    { name: 'email', value: email },
    { name: 'firstname', value: firstname },
    { name: 'lastname', value: lastname },
    { name: 'phone', value: parsed.phone },
    { name: 'website', value: parsed.website },
    { name: 'services_interested_in', value: parsed.services },
    { name: 'message', value: parsed.comments },
  ].filter((f) => f.value);

  const hsUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_GUID}`;

  const hsBody = {
    fields,
    context: {
      pageUri: 'https://jaxmediateam.com/',
      pageName: 'Tawk.to live chat',
    },
  };

  try {
    const hsRes = await fetch(hsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hsBody),
    });
    const hsText = await hsRes.text();
    if (!hsRes.ok) {
      return res.status(502).json({ error: 'hubspot rejected', status: hsRes.status, body: hsText.slice(0, 500) });
    }
    return res.status(200).json({ ok: true, fields: fields.map((f) => f.name) });
  } catch (e) {
    return res.status(500).json({ error: 'hubspot post failed', message: String(e).slice(0, 200) });
  }
}
