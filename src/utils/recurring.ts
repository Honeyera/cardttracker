import { FinanceTransaction } from '@/hooks/useFinanceData';

// Client-side recurring-charge detection over the transaction history we already
// sync — no extra Plaid product needed. A "recurring charge" is a merchant that
// bills on a regular cadence (weekly…yearly) with a reasonably consistent amount
// (so variable spend like ad platforms or inventory doesn't masquerade as a
// subscription). Think: SaaS, software, memberships, recurring services.

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringCharge {
  key: string;
  label: string;
  cadence: Cadence;
  typicalAmount: number; // median
  count: number;
  firstDate: string; // YYYY-MM-DD
  lastDate: string; // YYYY-MM-DD
  nextExpectedDate: string; // YYYY-MM-DD
  monthlyEquivalent: number; // normalized to a monthly cost
  accountId: string | null;
  creditCardId: string | null;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Stable grouping key: prefer the merchant name; else strip the volatile tail of
// the raw description (order ids, "*codes", long digit runs) to a brand stub.
function normalizeKey(t: FinanceTransaction): string {
  if (t.merchantName && t.merchantName.trim()) return t.merchantName.trim().toLowerCase();
  return (t.description || '')
    .toLowerCase()
    .replace(/\*.*/, ' ')
    .replace(/#?\d{2,}/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cadenceFor(gapDays: number): Cadence | null {
  if (gapDays >= 5 && gapDays <= 9) return 'weekly';
  if (gapDays >= 10 && gapDays <= 18) return 'biweekly';
  if (gapDays >= 19 && gapDays <= 45) return 'monthly';
  if (gapDays >= 46 && gapDays <= 135) return 'quarterly';
  if (gapDays >= 300 && gapDays <= 430) return 'yearly';
  return null;
}

const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91.3, yearly: 365,
};

const titleCase = (s: string) =>
  s.replace(/\b\w/g, (c) => c.toUpperCase());

export function detectRecurring(transactions: FinanceTransaction[]): RecurringCharge[] {
  // Only real outflows can be subscriptions.
  const charges = transactions.filter((t) => t.type === 'expense' || t.type === 'fee');

  // Group by merchant + the card/account it hits (same merchant on two cards =
  // two series).
  const groups = new Map<string, FinanceTransaction[]>();
  for (const t of charges) {
    const key = normalizeKey(t);
    if (!key || key.length < 3) continue;
    const src = t.creditCardId ?? t.accountId ?? 'none';
    const gkey = `${key}::${src}`;
    (groups.get(gkey) ?? groups.set(gkey, []).get(gkey)!).push(t);
  }

  const out: RecurringCharge[] = [];
  for (const [gkey, txns] of groups) {
    if (txns.length < 3) continue;
    const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

    // Collapse same-day duplicates to one point so a cadence can be read.
    const byDate: FinanceTransaction[] = [];
    for (const t of sorted) {
      if (!byDate.length || byDate[byDate.length - 1].date !== t.date) byDate.push(t);
    }
    if (byDate.length < 3) continue;

    const gaps: number[] = [];
    for (let i = 1; i < byDate.length; i++) gaps.push(daysBetween(byDate[i - 1].date, byDate[i].date));
    const medGap = median(gaps);
    const cadence = cadenceFor(medGap);
    if (!cadence) continue;

    // Cadence must be consistent: most gaps near the median.
    const consistent = gaps.filter((g) => Math.abs(g - medGap) <= Math.max(4, medGap * 0.4)).length;
    if (consistent / gaps.length < 0.6) continue;

    // Amount must be consistent (subscriptions are; variable spend isn't).
    const amounts = txns.map((t) => t.amount);
    const medAmt = median(amounts);
    if (medAmt <= 0) continue;
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
    const cv = Math.sqrt(variance) / mean; // coefficient of variation
    if (cv > 0.35) continue;

    const first = byDate[0];
    const last = byDate[byDate.length - 1];
    out.push({
      key: gkey,
      label: titleCase((last.merchantName || last.description || 'Charge').toLowerCase()).slice(0, 48),
      cadence,
      typicalAmount: medAmt,
      count: txns.length,
      firstDate: first.date,
      lastDate: last.date,
      nextExpectedDate: addDays(last.date, Math.round(medGap)),
      monthlyEquivalent: medAmt * (30.44 / CADENCE_DAYS[cadence]),
      accountId: last.accountId,
      creditCardId: last.creditCardId,
    });
  }

  return out.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}
