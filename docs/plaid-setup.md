# Plaid integration (direct bank sync)

Replaces the ChatGPT→Plaid→Supabase path with a direct Plaid connection: the user
links each bank once through Plaid Link, and a daily `pg_cron` job pulls balances
and transactions into the same tables the dashboard reads (`accounts`,
`credit_cards`, `transactions`, `balance_snapshots`). No ChatGPT in the loop.

## Pieces
- `supabase/migrations/20260924000000_plaid_items.sql` — stores each linked bank's
  access token + sync cursor (RLS-locked; service-role only).
- `supabase/functions/plaid-link-token` — creates a Link token (new or update/re-auth mode).
- `supabase/functions/plaid-exchange` — exchanges the public_token, saves the item.
- `supabase/functions/plaid-sync` — pulls balances + transactions for every item.
  Auth: `x-cron-secret` (scheduled) OR a logged-in JWT (manual "Sync now").
- `src/components/ConnectBank.tsx` — "Connect bank" + "Sync now" buttons (Dashboard header).

## One-time setup

### 1. Plaid account
1. Sign up at https://dashboard.plaid.com/signup.
2. Team Settings → Keys: copy `client_id` and the `production` secret
   (use the `sandbox` secret first to test with fake banks).
3. Request Production access (use case: personal financial management).

### 2. Supabase secrets (Edge Functions → Secrets)
- `PLAID_CLIENT_ID` = your client_id
- `PLAID_SECRET` = your sandbox or production secret
- `PLAID_ENV` = `sandbox` | `production`
- `CRON_SECRET` = (already set for other cron functions — reused here)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are already available.

### 3. Apply the migration
Run `supabase/migrations/20260924000000_plaid_items.sql` in the SQL editor (or `supabase db push`).

### 4. Deploy the functions (Verify JWT = OFF for all three)
```
supabase functions deploy plaid-link-token
supabase functions deploy plaid-exchange
supabase functions deploy plaid-sync
```

### 5. Plaid dashboard → allowed redirect/domains
Add your app origin (https://cardtracker.honeyera.com) under Plaid → API →
Allowed redirect URIs is only needed for OAuth banks; Plaid Link in a normal
popup works without it. For OAuth institutions (Chase, BofA), add the origin.

### 6. Link banks
Open the dashboard → **Connect bank** → complete Plaid Link for each institution.
After linking, an initial sync runs automatically. Use **Sync now** any time.

### 7. Schedule the daily sync
Run `docs/setup-plaid-cron.sql` (replace `<CRON_SECRET>` first).

## Notes
- Depository accounts → `accounts` table; credit accounts → `credit_cards` table.
- Transactions use `/transactions/sync` with a per-item cursor (incremental).
- If a bank needs re-auth, its `plaid_items.status` becomes `needs_reauth`; call
  `plaid-link-token` with `{ item_id }` to get an update-mode Link token.
