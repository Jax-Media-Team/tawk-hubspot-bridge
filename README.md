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

---

# Downstream funnel events (manual, authenticated)

Additive endpoint that records DOWNSTREAM OpenAI Ads conversions for a known lead:
`appointment_scheduled` (standard), `qualified_lead`, `proposal_sent`, `client_won` (custom).
Isolated from the `lead_created` handler — shares no code with `api/openai-conversions.js`.

## Endpoint

`POST /api/downstream`  — server-to-server only. Header: `x-downstream-secret: <DOWNSTREAM_SECRET>`

Body (JSON):
```
{ "contactId": "<HubSpot contact id>", "event": "qualified_lead",
  "eventTimeIso": "2026-08-27T18:00:00-04:00", "humanConfirmed": true,
  "amountCents": 480000, "currency": "USD",          // proposal_sent / client_won only
  "actionSource": "offline", "authorizedUser": "pcruz", "note": "optional" }
```
Schema-validation only (no HubSpot calls, no live conversion): add `"validateOnly": true` (and optional `"testOppref"`).

## Environment variables (in addition to the lead_created vars)

| Name | Required | Notes |
| --- | --- | --- |
| `DOWNSTREAM_SECRET` | yes | Caller secret; sent in `x-downstream-secret` header. Server-side only. |
| `HUBSPOT_PRIVATE_APP_TOKEN` | yes | HubSpot private app; scopes `crm.objects.contacts.read`, `crm.objects.notes.read`, `crm.objects.notes.write` |
| `OPENAI_ADS_API_KEY` | reused | Bearer for the Conversions API |
| `OPENAI_VALIDATE_ONLY` | reused | `'true'` forces validate_only for ALL sends (safety kill-switch) |

## Guarantees

- oppref parsed from the contact's `landing_page_url` and passed unchanged; refuses if no oppref / not `utm_source=openai`.
- `qualified_lead` refused unless HubSpot Lead Status = Qualified (human-set).
- Timestamp must be within OpenAI's window (last 7 days, <=10 min future); older events refused (no backfill).
- Deterministic event id `hs_<contactId>_<event>` → at most one conversion per contact per stage; retries reuse id+timestamp.
- Idempotency + audit via HubSpot Notes (no custom-property quota used); duplicate sends suppressed.
