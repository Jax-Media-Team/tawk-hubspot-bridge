# tawk-hubspot-bridge

Vercel serverless endpoint that receives a Tawk.to `chat:end` webhook, parses the pre-chat form embedded in the visitor's first message, and submits it to HubSpot via the Forms API.

## Why

Tawk's native Zapier integration only exposes Name, Email, City, Country on the visitor object. Phone, Website, Services, and Comments live in the visitor's first chat message as a `key : value` text dump. This bridge parses that dump and forwards every field to HubSpot.

## Endpoint

`POST /api/webhook`

## Environment variables

Set in Vercel (Project Settings → Environment Variables):

| Name | Required | Notes |
| --- | --- | --- |
| `HUBSPOT_PORTAL_ID` | yes | HubSpot account ID, e.g. `243782209` |
| `HUBSPOT_FORM_GUID` | yes | The HubSpot form GUID this submission targets |
| `TAWK_WEBHOOK_SECRET` | optional | If set, requests must include header `X-Tawk-Signature` matching this value |

## HubSpot form fields used

- `email`
- `firstname`
- `lastname`
- `phone`
- `website`
- `services_interested_in`
- `message`

## Tawk webhook config

In Tawk: Administration → Settings → Webhooks → Add. URL: deployed Vercel endpoint. Enable the `chat:end` event.

---

# OpenAI Ads Conversions bridge

Separate endpoint that receives a JotForm submission webhook and sends a server-side
`lead_created` event to the OpenAI Ads Conversions API, so OpenAI can attribute leads
back to the ad click via the `oppref` token captured on the landing page.

## Endpoint

`POST /api/openai-conversions?secret=<JOTFORM_WEBHOOK_SECRET>`

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `OPENAI_ADS_API_KEY` | yes | Bearer token for the OpenAI Ads Conversions API (secret) |
| `OPENAI_VALIDATE_ONLY` | optional | Defaults to `true` (sends `validate_only:true`). Set to `false` to send live events |
| `JOTFORM_WEBHOOK_SECRET` | yes | Shared secret; the JotForm webhook URL must include `?secret=<value>`. Endpoint returns 401 if unset or mismatched |

Pixel ID (`EHzs668NexotXGL3V8rNhm`) and the endpoint host are constants in the function.

## Payload sent (Spec v2)

```
POST https://bzr.openai.com/v1/events?pid=EHzs668NexotXGL3V8rNhm
{ "validate_only": <env>, "events": [ {
  "id": "jf_<submissionID>", "type": "lead_created", "timestamp_ms": <ms>,
  "oppref": "<from full_url>", "source_url": "<full_url>", "action_source": "web",
  "user": { "email_sha256": "<sha256(trim+lowercase email)>" },
  "data": { "type": "customer_action" } } ] }
```

- `oppref` is sourced from the `full_url` field (parsed), which reliably carries the token.
- `olref` is captured for diagnostics only; it is never mapped into `oppref`.
- Skips (no event sent, HTTP 200) when there is no `submissionID` or no `oppref`.

## JotForm webhook config

In JotForm: form **210317504801039** → Settings → Integrations → Webhooks → add
`https://<project>.vercel.app/api/openai-conversions?secret=<JOTFORM_WEBHOOK_SECRET>`.

## Go-live sequence

1. Deploy with `OPENAI_VALIDATE_ONLY=true`.
2. Submit one test lead with an `oppref`; check logs for `payload(redacted)` and a `200` from OpenAI.
3. Set `OPENAI_VALIDATE_ONLY=false`; submit one real test; confirm it appears in OpenAI's Event Stream and identifier coverage rises.
4. Monitor real leads before changing any browser-side pixel behavior. The base OpenAI pixel stays in place regardless.
