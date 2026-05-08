// Cloudflare Worker: Tawk.to chat:end webhook -> HubSpot Forms API bridge.
// Parses the pre-chat form embedded in the visitor's first message and forwards to HubSpot.

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

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return json(200, { ok: true, service: 'tawk-hubspot-bridge' });
    }
    if (request.method !== 'POST') {
      return json(405, { error: 'method not allowed' });
    }

    if (env.TAWK_WEBHOOK_SECRET) {
      const provided =
        request.headers.get('x-tawk-signature') || request.headers.get('x-webhook-secret');
      if (provided !== env.TAWK_WEBHOOK_SECRET) {
        return json(401, { error: 'unauthorized' });
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, { error: 'invalid json' });
    }

    const event = payload.event || payload.eventName;
    if (event && event !== 'chat:end' && event !== 'chat:transcript_created') {
      return json(200, { skipped: true, event });
    }

    const visitor = payload.visitor || {};
    const messages = (payload.chat && payload.chat.messages) || payload.messages || [];
    const firstVisitorMsg = messages.find(
      (m) =>
        (m.sender && (m.sender.t === 'v' || m.sender.type === 'visitor')) || m.type === 'msg'
    );
    const firstMsgText = firstVisitorMsg ? firstVisitorMsg.msg || firstVisitorMsg.text || '' : '';

    const parsed = parseFormText(firstMsgText);

    const email = parsed.email || visitor.email || visitor.e || '';
    if (!email) {
      return json(200, { skipped: true, reason: 'no email' });
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

    const hsUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${env.HUBSPOT_PORTAL_ID}/${env.HUBSPOT_FORM_GUID}`;
    const hsBody = {
      fields,
      context: {
        pageUri: 'https://jaxmediateam.com/',
        pageName: 'Tawk.to live chat',
      },
    };

    const hsRes = await fetch(hsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hsBody),
    });
    const hsText = await hsRes.text();
    if (!hsRes.ok) {
      return json(502, {
        error: 'hubspot rejected',
        status: hsRes.status,
        body: hsText.slice(0, 500),
      });
    }
    return json(200, { ok: true, fields: fields.map((f) => f.name) });
  },
};
