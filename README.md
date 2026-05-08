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
