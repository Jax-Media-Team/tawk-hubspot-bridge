# tawk-hubspot-bridge

Cloudflare Worker that receives a Tawk.to `chat:end` webhook, parses the pre-chat form embedded in the visitor's first message, and submits it to HubSpot via the Forms API.

## Why

The native Tawk Zapier integration only exposes Name, Email, City, Country on the visitor object. Phone, Website, Services, and Comments live in the visitor's first chat message as a key:value text dump. This bridge parses that dump and forwards every field to HubSpot.

## Endpoint

`POST /` on the deployed Worker URL.

## Deploy

```bash
npm install
npx wrangler login        # one-time, opens browser
npx wrangler deploy
```

After the first deploy, set the secrets:

```bash
npx wrangler secret put HUBSPOT_PORTAL_ID
npx wrangler secret put HUBSPOT_FORM_GUID
npx wrangler secret put TAWK_WEBHOOK_SECRET   # optional
```

## Environment variables (set as Cloudflare secrets)

| Name | Required | Notes |
| --- | --- | --- |
| `HUBSPOT_PORTAL_ID` | yes | HubSpot account ID, e.g. `243782209` |
| `HUBSPOT_FORM_GUID` | yes | The HubSpot form GUID this submission targets |
| `TAWK_WEBHOOK_SECRET` | optional | If set, requests must include header `X-Tawk-Signature` matching this value |

## HubSpot form fields used

The bridge submits these field names to the HubSpot form. Either name your form fields to match, or rename here:

- `email`
- `firstname`
- `lastname`
- `phone`
- `website`
- `services_interested_in`
- `message`

## Tawk webhook config

In Tawk: Administration → Settings → Webhooks → Add. Set the URL to the deployed Vercel endpoint. Enable the `chat:end` event.

## Local notes

- Vercel auto-detects `api/*.js` as serverless functions; no build step needed.
- Free tier is more than enough for chat volume.
