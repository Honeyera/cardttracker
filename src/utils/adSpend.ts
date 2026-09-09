import { FinanceCard, FinanceTransaction } from '@/hooks/useFinanceData';

// ── Ad-spend tracking config ──────────────────────────────────────────
//
// Cards with an annual ad-spend cap. `cardMatch` is tested against the
// card's name and company name. Edit here to change limits or add cards.
//
// NOTE: the email alert edge function keeps its own copy of these
// patterns (supabase/functions/ad-spend-alert) — keep the two in sync.
export const AD_SPEND_LIMITS: { cardMatch: RegExp; annualLimit: number }[] = [
  { cardMatch: /amex|american express/i, annualLimit: 150_000 },
];

// Alert thresholds as fractions of the annual limit.
export const AD_SPEND_THRESHOLDS = [0.8, 0.9, 1.0] as const;

// Merchant/description/category patterns that identify ad-platform spend.
// Matching is intentionally broad-but-specific: "linkedin ads" not "linkedin",
// so subscriptions and job posts don't count as ad spend.
const AD_PATTERNS: RegExp[] = [
  /google\s*ads|googleads|adwords|google\s*adw/i,
  /facebk.*ads|facebook\s*ads?\b|meta\s*ads?\b|meta\s*platforms/i,
  /tiktok\s*ads?/i,
  /microsoft\s*ad|bing\s*ads?/i,
  /amazon\s*ad(vertising|s)/i,
  /linkedin\s*ads?/i,
  /pinterest\s*ads?/i,
  /snap(chat)?\s*ads?/i,
  /twitter\s*ads?|x\s*ads\b/i,
  /reddit\s*ads?/i,
  /taboola|outbrain|criteo/i,
  /advertis/i, // Plaid category "Advertising"
];

export function isAdTransaction(t: FinanceTransaction): boolean {
  const haystack = `${t.merchantName ?? ''} ${t.description} ${t.category ?? ''}`;
  return AD_PATTERNS.some((p) => p.test(haystack));
}

export function adSpendLimitFor(card: Pick<FinanceCard, 'name' | 'companyName'>): number | null {
  const label = `${card.name} ${card.companyName ?? ''}`;
  const rule = AD_SPEND_LIMITS.find((r) => r.cardMatch.test(label));
  return rule ? rule.annualLimit : null;
}

export interface AdSpendStatus {
  spent: number;
  limit: number;
  fraction: number; // spent / limit
  projected: number; // straight-line pace to Dec 31
  year: number;
}

// Calendar-year ad spend for one card: ad-platform expenses/fees minus
// ad-platform refunds. Pending transactions count — they are real spend.
export function computeAdSpend(
  transactions: FinanceTransaction[],
  cardId: string,
  limit: number,
  now: Date = new Date(),
): AdSpendStatus {
  const year = now.getFullYear();
  const from = `${year}-01-01`;
  let spent = 0;
  for (const t of transactions) {
    if (t.creditCardId !== cardId || t.date < from) continue;
    if (!isAdTransaction(t)) continue;
    if (t.type === 'expense' || t.type === 'fee') spent += t.amount;
    else if (t.type === 'refund') spent -= t.amount;
  }
  spent = Math.max(0, spent);

  const startOfYear = new Date(year, 0, 1);
  const daysElapsed = Math.max(1, Math.floor((now.getTime() - startOfYear.getTime()) / 86_400_000) + 1);
  const daysInYear = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
  const projected = (spent / daysElapsed) * daysInYear;

  return { spent, limit, fraction: limit > 0 ? spent / limit : 0, projected, year };
}
