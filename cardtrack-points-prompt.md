## Task: Add Credit Card Points Tracking to CardTrack App

### Context
This is a React + TypeScript + Supabase + TanStack Query + shadcn/ui + Tailwind credit card tracking app called "CardTrack". The app currently tracks credit cards with balances, payment dates, companies, and upcoming dates. Reference `@src/pages/Index.tsx` for code patterns and styling.

The app uses:
- React with TypeScript
- Supabase for backend (auth, database)
- TanStack Query via custom hooks (see `useCreditCards` pattern)
- shadcn/ui components
- Tailwind CSS
- React Router (BrowserRouter with Routes)
- AuthContext for authentication
- dnd-kit for drag and drop

---

### Part 1: Supabase Migration

Create a new table `credit_card_points`:

```sql
CREATE TABLE IF NOT EXISTS public.credit_card_points (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  card_name TEXT NOT NULL,
  points_redeemed INTEGER NOT NULL DEFAULT 0,
  redemption_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.credit_card_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own points"
  ON public.credit_card_points FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own points"
  ON public.credit_card_points FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own points"
  ON public.credit_card_points FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own points"
  ON public.credit_card_points FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_credit_card_points_user_id ON public.credit_card_points(user_id);
CREATE INDEX idx_credit_card_points_person ON public.credit_card_points(person);
```

After creating the migration, regenerate Supabase TypeScript types.

---

### Part 2: Custom Hook

Create a `useCreditCardPoints` hook (in `@/hooks/useCreditCardPoints.ts`) following the same pattern as the existing `useCreditCards` hook. It should handle:
- Fetching all points entries for the authenticated user
- Adding a new entry
- Updating an entry
- Deleting an entry
- Use the `useAuth` context for the user ID
- Return `{ points, loading, addPoint, updatePoint, deletePoint }`

---

### Part 3: New Route & Navigation

1. Add a new page at `@/pages/Points.tsx`
2. Add the route in `App.tsx`: `<Route path="/points" element={<Points />} />` (above the catch-all)
3. Add a navigation link in the header of `Index.tsx` — a button/link next to the existing buttons that says "Points" with a `Trophy` or `Gift` icon from lucide-react, linking to `/points`
4. On the Points page, add a back/home link in the header to return to the main dashboard

---

### Part 4: Points Tracking Page (`Points.tsx`)

Match the styling of Index.tsx — same header pattern (sticky header with bg-card, border-b, max-w-6xl container), same card/section spacing.

#### Header
Same style as Index.tsx header:
- Left: Trophy/Gift icon + "CardTrack Points" title + "Track reward points redeemed" subtitle
- Right: "Add Entry" button (primary) + UserMenu component (same sign out pattern)

#### Person Filter

Pill/chip buttons below the header (styled like segmented buttons or badge-style pills):
- "All" — shows entries from both people
- "Tomer" — filter to Tomer only
- "Leo" — filter to Leo only

Default to "All". Active pill gets primary background color.

Define the person names as a constant: `const PEOPLE = ["Tomer", "Leo"] as const;`

#### Summary Cards Row (4 cards)

Use the same card gradient style if the app uses gradient cards in DashboardStats, or use simple cards matching the existing design.

| Card | Calculation |
|------|------------|
| Total Points Redeemed | Sum of all points_redeemed (respects person filter) |
| Tomer's Total | Sum where person = "Tomer" (always shows regardless of filter) |
| Leo's Total | Sum where person = "Leo" (always shows regardless of filter) |
| Total Entries | Count of entries (respects person filter) |

Format points with commas (e.g. 150,000).

#### Search Bar
Same search input style as Index.tsx. Search by card name, person, or notes.

#### Main Table

Use the same table pattern that exists in `CreditCardTable` component. Sortable columns.

| Column | Notes |
|--------|-------|
| Person | "Tomer" or "Leo" — colored badge (Tomer = blue, Leo = green/teal) |
| Card Name | Bold text |
| Points Redeemed | Right-aligned, mono/tabular-nums, formatted with commas |
| Redemption Date | Formatted as "Mon DD, YYYY" |
| Notes | Muted text, truncate if long |
| Actions | Edit (Pencil icon button) + Delete (Trash2 icon button) |

Default sort: Redemption date descending (most recent first).

#### Add/Edit Dialog

Create an `AddPointDialog` component (in `@/components/AddPointDialog.tsx`) following the same pattern as `AddCardDialog`:

Fields:
1. **Person** — Select dropdown with "Tomer" and "Leo". Required. Default to "Tomer".
2. **Card Name** — Combobox/autocomplete that suggests previously used card names from existing entries. Also allow typing a new name. Can also pull card names from the existing credit_cards table if available (cards the user already tracks).
3. **Points Redeemed** — Number input. Required.
4. **Redemption Date** — Date input. Default to today when adding new.
5. **Notes** — Textarea, 2 rows. Optional.

The dialog handles both add and edit (pass `editEntry` prop, same pattern as `editCard` in AddCardDialog).

#### Delete Confirmation

Use an AlertDialog for delete confirmation, same pattern as how the existing app handles card deletion.

#### Summary by Card Section

Below the main table, add a collapsible section (use shadcn Collapsible or just a toggle button) titled "Summary by Card":

A mini summary table grouped by card_name:

| Card Name | Total Points | Tomer | Leo | Entries |
|-----------|-------------|-------|-----|---------|

Sort by total points descending. This is always based on ALL entries (ignores person filter) so you can see the full picture.

#### Empty State

Same style as Index.tsx empty state — centered card with dashed border, Trophy icon, "No points tracked yet" heading, "Add your first entry" button.

---

### Important Implementation Notes

- Use the `useAuth` context for authentication (same as Index.tsx)
- Redirect to `/auth` if not logged in (same useEffect pattern as Index.tsx)
- The Points page should be a standalone page at `/points`, NOT a tab on the main page — it's a separate section
- All toast notifications using the existing Toaster/Sonner setup
- Keep the same max-w-6xl container width
- Follow the existing component file structure (components in `@/components/`, hooks in `@/hooks/`, pages in `@/pages/`)
- The card name autocomplete should combine: distinct card_name values from credit_card_points entries + optionally card names from the existing credit cards table (so users can pick from cards they already track)
