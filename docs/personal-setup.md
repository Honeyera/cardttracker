# Personal instance setup (local PC + your own Supabase + your own Plaid)

This branch (`personal`) is the shared app with the business-specific card/account
name overrides removed. Everything else is identical. Follow these steps once.

## 1. Prerequisites on your PC
- Node.js 18+ (https://nodejs.org)
- Git, with an SSH key added to your GitHub account (the repo is private)
- Supabase CLI (https://supabase.com/docs/guides/cli) — `npm i -g supabase` works

## 2. Clone and install
```bash
git clone git@github.com:Honeyera/cardttracker.git cardtracker-personal
cd cardtracker-personal
git checkout personal
npm install
```

## 3. Create your Supabase project
1. supabase.com → New project (your own account/org). Free tier is fine.
2. Authentication → Users → Add user: create your login (email + password).
   Copy the user's UUID — you need it in step 5.
3. Project Settings → API: copy the Project URL and the anon/publishable key.

## 4. Apply the database schema
```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push          # applies everything in supabase/migrations/
```
Then open the SQL editor in the Supabase dashboard and run
`docs/personal-schema-fixups.sql` (hand-applied production changes the
migrations don't cover).

## 5. Edge Function secrets
Dashboard → Edge Functions → Secrets (or `supabase secrets set K=V`):

| Secret | Value |
|---|---|
| `PLAID_CLIENT_ID` | from your Plaid dashboard (Team Settings → Keys) |
| `PLAID_SECRET` | the **sandbox** secret first; switch to production later |
| `PLAID_ENV` | `sandbox` first, then `production` |
| `OWNER_USER_ID` | the UUID of the user you created in step 3 |
| `CRON_SECRET` | any long random string (e.g. `openssl rand -hex 32`) |

## 6. Deploy the edge functions
```bash
supabase functions deploy plaid-link-token --no-verify-jwt
supabase functions deploy plaid-exchange --no-verify-jwt
supabase functions deploy plaid-sync --no-verify-jwt
supabase functions deploy plaid-webhook --no-verify-jwt
supabase functions deploy plaid-manage --no-verify-jwt
```

## 7. Point the app at your project
Edit `.env` in the repo root:
```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your anon key>
```

## 8. Run it
```bash
npm run dev     # open http://localhost:5173 and log in
```
With `PLAID_ENV=sandbox`, click **Connect bank** and link Plaid's fake bank
(user `user_good`, password `pass_good`) to verify link → sync → dashboard
end to end.

## 9. Go live with real banks
1. In the Plaid dashboard: request Production access (use case: personal
   financial management), configure Data Transparency Messaging
   (dashboard.plaid.com/link/data-transparency-v5), and request the
   **Liabilities** product if you want statement balances / due dates / APR
   (without it enabled, linking still works — it's requested as optional).
2. Set `PLAID_SECRET` to the production secret and `PLAID_ENV=production`.
3. Re-link your real banks via **Connect bank**.

## 10. Schedule the daily sync
In the SQL editor run `docs/setup-plaid-cron.sql` after replacing
`<CRON_SECRET>` with the real value from step 5 (don't leave the placeholder —
the job silently gets 401s). Note: pg_cron runs in UTC and ignores DST.

## Keeping up with shared-app improvements
```bash
git fetch origin
git rebase origin/main
```
If an update includes a new file in `supabase/migrations/` or changes a
function in `supabase/functions/`, apply/deploy it to your project too.
