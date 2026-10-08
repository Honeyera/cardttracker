# ChatGPT ingestion endpoint (Custom GPT Action)

ChatGPT's safety layer blocks its Supabase-connector writes. This endpoint gives
it a normal HTTPS API to POST financial data to instead. The endpoint writes
server-side via the existing RPCs (`finance_upsert` / `remap_card` /
`finance_prune_pending`) using the service role, so all transaction rules apply.

## Setup

1. **Deploy the function.** Supabase → Edge Functions → Create function → name
   `ingest` → paste `supabase/functions/ingest/index.ts` → Verify JWT = **off** → Deploy.
2. **Set the secret** (Edge Functions → Secrets):
   - `INGEST_KEY` = a long random string (this is ChatGPT's password to the endpoint).
   - `SUPABASE_SERVICE_ROLE_KEY` is already available to functions.
3. **Add a Custom GPT Action** in ChatGPT → Configure → Actions:
   - Authentication: **API Key**, type **Custom**, header name `x-ingest-key`, value = your `INGEST_KEY`.
   - Paste the OpenAPI schema below.

## Endpoint

`POST https://zndyokpudijoidropdou.supabase.co/functions/v1/ingest`
Header: `x-ingest-key: <INGEST_KEY>`, `Content-Type: application/json`

One action per request:

```json
{"action":"upsert","table":"transactions","rows":[{"external_id":"...","user_id":"65b9afb1-c868-4848-a49f-68cd2529ef81","account_id":"...","transaction_date":"2026-10-08","description":"...","amount":12.34,"transaction_type":"expense"}],"conflict":"external_id"}
```
```json
{"action":"remap_card","external_account_id":"<plaid_account_id>","new_last_four":"2001"}
```
```json
{"action":"prune_pending","external_account_id":"<plaid_account_id>","keep_external_ids":["ext_a","ext_b"]}
```

Conflict keys per table (same as finance_upsert): transactions/accounts → `external_id`,
credit_cards → `finance_external_account_id`, balance_snapshots → `account_id, snapshot_date`,
cashflow_forecast → `user_id, forecast_date`, cashflow_daily → `user_id, cashflow_date`.
Every row must include `user_id` = `65b9afb1-c868-4848-a49f-68cd2529ef81` and all NOT-NULL columns.

## OpenAPI schema for the GPT Action

```yaml
openapi: 3.1.0
info:
  title: Cardtracker Ingest
  version: "1.0"
servers:
  - url: https://zndyokpudijoidropdou.supabase.co/functions/v1
paths:
  /ingest:
    post:
      operationId: ingestFinanceData
      summary: Write finance data (upsert rows, remap a card, or prune pending)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [action]
              properties:
                action:
                  type: string
                  enum: [upsert, remap_card, prune_pending]
                table:
                  type: string
                  description: "for upsert: accounts|transactions|balance_snapshots|cashflow_forecast|cashflow_daily|alerts|credit_cards"
                rows:
                  type: array
                  items: { type: object, additionalProperties: true }
                  description: "for upsert: the rows to upsert (include user_id + all NOT-NULL columns)"
                conflict:
                  type: string
                  description: "for upsert: conflict key, e.g. external_id"
                external_account_id:
                  type: string
                  description: "for remap_card / prune_pending: the Plaid account id"
                new_last_four:
                  type: string
                  description: "for remap_card: the new last-4/5 digits"
                keep_external_ids:
                  type: array
                  items: { type: string }
                  description: "for prune_pending: external_ids that are still pending"
      responses:
        "200": { description: Result }
```

## Test (without ChatGPT)

```sh
curl -X POST https://zndyokpudijoidropdou.supabase.co/functions/v1/ingest \
  -H "x-ingest-key: $INGEST_KEY" -H "Content-Type: application/json" \
  -d '{"action":"upsert","table":"transactions","rows":[],"conflict":"external_id"}'
```
Expected: `{"ok":true,"result":{"table":"transactions","upserted":0}}`.
