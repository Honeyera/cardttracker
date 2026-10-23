# Personal cardtracker (this folder)

This is the **personal** instance of cardtracker — separate from the work app.

- **Live site:** https://cards.vowideas.com (served by nginx on this VPS, 51.81.84.11,
  from this folder's `dist/`).
- **Branch:** `personal` (a git worktree of the shared repo Honeyera/cardttracker).
- **Backend:** the owner's **personal** Supabase project `cihandjyoojthqjfqarf`
  (set in the local, gitignored `.env`). NEVER point this at the business project
  `zndyokpudijoidropdou`.
- **Plaid:** the owner's personal Plaid account (secrets live in the personal
  Supabase edge-function secrets, not here).

## Deploy
Edit files here, then run:

    ./deploy.sh

It builds the site live (nginx serves `dist/` directly) and backs the code up to
GitHub (`personal` branch). Edge-function or DB-schema changes must additionally be
deployed to the personal Supabase (`supabase functions deploy …` / SQL editor).

## Do NOT confuse with the work app
`/home/ubuntu/cardtracker` (branch `main`) is the WORK build that ships to the work
production server (135.148.47.180 → cardtracker.honeyera.com). Keep personal edits
in THIS folder only.
