import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { format, parseISO, differenceInCalendarDays } from 'date-fns';
import { useAuth } from '@/contexts/AuthContext';
import { useFinanceData, FinanceAccount, FinanceCard, FinanceTransaction, FinanceAlert, ForecastPoint, BalanceSnapshot, TxnTag } from '@/hooks/useFinanceData';
import { getNextOccurrence } from '@/utils/dateUtils';
import { adSpendLimitFor, computeAdSpend, isAdTransaction, AdSpendStatus } from '@/utils/adSpend';
import { detectRecurring, Cadence } from '@/utils/recurring';
import { cardColorClasses, CardColor } from '@/types/creditCard';
import { UserMenu } from '@/components/UserMenu';
import { AskBox } from '@/components/AskBox';
import { ConnectBank } from '@/components/ConnectBank';
import { ForceMfaSetup } from '@/components/ForceMfaSetup';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { AreaChart, Area, ComposedChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceDot, ReferenceLine } from 'recharts';
import {
  Wallet, LayoutDashboard, CreditCard as CardIcon, Trophy, Loader2, Building2,
  ArrowDownRight, ArrowUpRight, Landmark, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle2, CalendarClock, RefreshCw, Bell, ChevronRight, Percent, Megaphone, X, Repeat,
  Sun, Moon, PieChart as PieChartIcon,
} from 'lucide-react';

const fmtMoney = (n: number, opts: { cents?: boolean } = {}) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });

// Compact money for tight tile rows: $87,400 -> $87k. Exact values live in
// the card dialog.
const fmtCompact = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : fmtMoney(n));

// Owner-specific: 0% balance-transfer promos to track payoff before the rate
// jumps. Keyed by card last-four; endDate ISO; goToApr is the % after the promo.
// The transferred principal is auto-detected from the card's "balance transfer"
// transactions, so only the promo terms live here.
const BT_PROMOS: { last4: string; endDate: string; goToApr: number }[] = [
  { last4: '6125', endDate: '2027-06-30', goToApr: 18 }, // BofA Cash Card
];

// Spending-by-category donut palette — validated (CVD-safe, both modes) via the
// dataviz skill against the app's card surfaces. Fixed order, never cycled; a 9th
// category folds into a neutral "Everything else" (CAT_OTHER). Dark = same 8 hues
// re-stepped for the dark surface.
const CAT_COLORS_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const CAT_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const CAT_OTHER = '#898781'; // neutral gray, same in both modes

// Map Plaid's raw category codes (detailed PFC, lowercased) to friendly labels,
// matching the familiar names on a spending report. Longest/most-specific prefixes
// first — the first match wins.
function categoryLabel(t: FinanceTransaction): string {
  const c = (t.category ?? '').toLowerCase();
  if (!c) return 'Uncategorized';
  const map: [string, string][] = [
    ['food_and_drink_groceries', 'Groceries'],
    ['food_and_drink', 'Food & Dining'],
    ['transportation_gas', 'Gas'],
    ['transportation', 'Transportation'],
    ['travel', 'Travel'],
    ['general_merchandise_clothing', 'Clothing'],
    ['general_merchandise_electronics', 'Electronics'],
    ['general_merchandise', 'Shopping'],
    ['home_improvement', 'Home Improvement'],
    ['rent_and_utilities_rent', 'Rent'],
    ['rent_and_utilities_internet', 'Internet & Cable'],
    ['rent_and_utilities_telephone', 'Phone'],
    ['rent_and_utilities', 'Utilities'],
    ['loan_payments_mortgage', 'Mortgage'],
    ['loan_payments_car', 'Car Payment'],
    ['loan_payments_student', 'Student Loan'],
    ['loan_payments_personal', 'Personal Loan'],
    ['loan_payments', 'Loan Payment'],
    ['medical', 'Medical'],
    ['personal_care', 'Personal Care'],
    ['entertainment', 'Entertainment'],
    ['general_services_insurance', 'Insurance'],
    ['general_services', 'Services'],
    ['bank_fees', 'Fees'],
    ['government_and_non_profit', 'Taxes & Gov'],
  ];
  for (const [prefix, label] of map) if (c.startsWith(prefix)) return label;
  // Fallback: title-case the primary category (first two tokens).
  return c.split('_').slice(0, 2).join(' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

// Owner-specific: fix recurring-charge labels where Plaid's merchant guess is
// wrong. Keyed by the detected (title-cased) label, lowercased.
const RECURRING_LABEL_OVERRIDES: Record<string, string> = {
  'briarwood college': 'Briarwood West HOA', // really an HOA fee (bank text "BRIARWOOD WEST", cat=rent)
};

// Stable merchant/payee key for Personal/Property tagging: prefer the merchant
// name; for Zelle, the payee after the last "zelle"; else a cleaned description.
// So a tag on one transaction applies to every charge from that payee.
function merchantKey(t: { merchantName: string | null; description: string }): string {
  const name = (t.merchantName ?? '').trim().toLowerCase();
  if (name) return name;
  let d = (t.description ?? '').toLowerCase();
  const zi = d.lastIndexOf('zelle ');
  if (zi >= 0) d = d.slice(zi + 6);
  return d.replace(/\*.*/, ' ').replace(/[#\d]{2,}/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  try { return format(parseISO(iso), 'MMM d, yyyy'); } catch { return iso; }
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return '—';
  try { return format(parseISO(iso), 'MMM d, h:mm a'); } catch { return iso; }
};

// Resolve a card's next due date. Prefer the synced explicit date, but only if
// it is today or in the future — a stale past date (common right after a
// statement is paid) is rolled forward to the next occurrence of the due day so
// we never render a past date as "due today". Returns { date, days } or null.
function resolveDue(card: FinanceCard): { date: Date; days: number } | null {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let date: Date | null = null;
  if (card.nextPaymentDueDate) {
    try {
      const explicit = parseISO(card.nextPaymentDueDate);
      if (explicit >= today) date = explicit;
    } catch { /* ignore */ }
  }
  if (!date && card.dueDay) date = getNextOccurrence(card.dueDay);
  // Last resort: a past explicit date (keeps overdue cards visible).
  if (!date && card.nextPaymentDueDate) {
    try { date = parseISO(card.nextPaymentDueDate); } catch { /* ignore */ }
  }
  if (!date) return null;
  return { date, days: differenceInCalendarDays(date, today) };
}

// Ignore tiny statement residuals — rounding or payment-timing gaps between the
// synced statement balance and the payments we matched. Anything paid to within
// this many dollars of the statement counts as covered, so a few-dollar leftover
// doesn't nag as "due". Raise/lower to taste.
const DUE_EPSILON = 10;

// A card has nothing due when the sync says so (payment_status / zero minimum)
// or the statement balance is cleared — even if a running balance remains.
function isSettled(card: FinanceCard, paidTowardStatement = 0): boolean {
  if (card.isOverdue) return false;
  const s = (card.paymentStatus ?? '').toLowerCase().replace(/[‘’′]/g, "'");
  if (
    s.includes('not required') ||
    s.includes('no payment') ||
    s.includes("don't have a payment") ||
    s.includes('no amount due') ||
    s.includes('nothing due') ||
    s.includes('paid in full')
  ) return true;
  if (card.currentBalance <= 0.005) return true;
  // No statement/minimum owed and no upcoming explicit due amount → nothing due.
  if ((card.minimumPayment ?? 0) <= 0.005 && (card.lastStatementBalance ?? 0) <= 0.005) return true;
  // Statement fully covered by payments since it closed (handles installments) —
  // any remaining balance is next-cycle spending, so nothing is due now.
  const stmt = card.lastStatementBalance ?? 0;
  if (stmt > 0.005) {
    if (paidTowardStatement + DUE_EPSILON >= stmt) return true;
    if (
      card.lastPaymentAmount != null && card.lastPaymentDate != null && card.lastStatementDate != null &&
      card.lastPaymentAmount + DUE_EPSILON >= stmt && card.lastPaymentDate >= card.lastStatementDate
    ) return true;
  }
  return false;
}

// Interest risk: a payment was made toward the last statement, but it was less
// than the statement balance — so the unpaid remainder will accrue interest.
// Returns the shortfall details, or null if the statement was paid in full /
// nothing is owed / no payment has yet been applied to this statement.
// `paidTowardStatement` is the sum of all payments applied since the statement
// closed (from the transaction history) — more accurate than the single stored
// last_payment_amount, which misses installment payments.
function interestRisk(card: FinanceCard, paidTowardStatement: number): { paid: number; statement: number; remaining: number } | null {
  if (isSettled(card, paidTowardStatement)) return null;
  const stmt = card.lastStatementBalance ?? 0;
  if (stmt <= 0.005) return null;
  if (paidTowardStatement <= 0.005) return null; // nothing paid → a "due" case, not underpayment
  if (paidTowardStatement + DUE_EPSILON >= stmt) return null; // statement paid (within the small-residual threshold)
  // You can't accrue interest on more than you currently owe; if what's left is
  // within the minimum payment, treat the statement as effectively paid.
  const atRisk = Math.min(stmt - paidTowardStatement, card.currentBalance);
  if (atRisk <= Math.max(1, card.minimumPayment ?? 0) + 0.005) return null;
  return { paid: paidTowardStatement, statement: stmt, remaining: atRisk };
}

// Lower rank = more urgent (sorts first). Overdue < due-soon (by days) < settled.
// Safety net: a statement that is unpaid AND due within `days` is genuinely due,
// even if the issuer's payment_status still says "not required" (can be stale /
// autopay). Returns the resolved due info when it applies, else null.
function unpaidStatementDueWithin(card: FinanceCard, paidTowardStatement: number, days: number): { date: Date; days: number } | null {
  if (card.isOverdue) return null;
  const stmt = card.lastStatementBalance ?? 0;
  if (stmt <= 0.005) return null;
  if (paidTowardStatement + DUE_EPSILON >= stmt) return null; // statement already covered (within the small-residual threshold)
  const due = resolveDue(card);
  if (!due || due.days < 0 || due.days > days) return null;
  return due;
}

function urgencyRank(card: FinanceCard, paidTowardStatement = 0): number {
  if (card.isOverdue) return -100000;
  // An unpaid statement due within 15 days is genuinely due — rank by days even
  // if the issuer says "not required" (so it doesn't get sorted as settled).
  const forceDue = unpaidStatementDueWithin(card, paidTowardStatement, 15);
  if (forceDue) return forceDue.days;
  if (isSettled(card, paidTowardStatement)) return 100000;
  const due = resolveDue(card);
  return due ? due.days : 99999; // no due date → near the end, but before settled
}

// Days until the card's statement next closes (by statement day-of-month).
function nextClosingDays(card: FinanceCard): number {
  if (!card.statementDay) return 999999;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return differenceInCalendarDays(getNextOccurrence(card.statementDay), today);
}

function utilization(card: FinanceCard): number {
  return card.creditLimit > 0 ? card.currentBalance / card.creditLimit : -1;
}

type CardSort = 'urgency' | 'due' | 'closing' | 'balance' | 'limit' | 'utilization' | 'name';

const CARD_SORT_OPTIONS: { value: CardSort; label: string }[] = [
  { value: 'urgency', label: 'Urgency (default)' },
  { value: 'due', label: 'Payment due date' },
  { value: 'closing', label: 'Closing date' },
  { value: 'balance', label: 'Balance (high→low)' },
  { value: 'limit', label: 'Credit limit (high→low)' },
  { value: 'utilization', label: 'Utilization (high→low)' },
  { value: 'name', label: 'Name (A→Z)' },
];

function compareCards(a: FinanceCard, b: FinanceCard, sort: CardSort, paidFor: (id: string) => number = () => 0): number {
  switch (sort) {
    case 'due': {
      const da = resolveDue(a)?.days ?? 999999;
      const db = resolveDue(b)?.days ?? 999999;
      return da - db;
    }
    case 'closing': return nextClosingDays(a) - nextClosingDays(b);
    case 'balance': return b.currentBalance - a.currentBalance;
    case 'limit': return b.creditLimit - a.creditLimit;
    case 'utilization': return utilization(b) - utilization(a);
    case 'name': return a.name.localeCompare(b.name);
    default: return urgencyRank(a, paidFor(a.id)) - urgencyRank(b, paidFor(b.id));
  }
}

const Dashboard = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const queryClient = useQueryClient();
  const refreshFinance = () => queryClient.invalidateQueries({ queryKey: ['finance'] });
  // Persist a per-card custom tile color (hex), or null to reset to automatic.
  const setCardColor = async (id: string, color: string | null) => {
    await (supabase as any).from('credit_cards').update({ tile_color: color }).eq('id', id);
    refreshFinance();
  };

  // Rename a card. Writes a display_name override that Plaid sync never touches
  // (sync keeps rewriting `name`), so the rename sticks. Passing null clears the
  // override and falls back to the synced name.
  const setCardName = async (id: string, name: string | null) => {
    const value = name == null ? null : name.trim();
    if (value === '') return; // ignore empty — use "Reset to automatic" to clear
    await (supabase as any).from('credit_cards').update({ display_name: value }).eq('id', id);
    refreshFinance();
  };

  // Rename a bank account — same sync-safe display_name override as cards.
  const setAccountName = async (id: string, name: string | null) => {
    const value = name == null ? null : name.trim();
    if (value === '') return;
    await (supabase as any).from('accounts').update({ display_name: value }).eq('id', id);
    refreshFinance();
  };
  const { accounts, transactions, cards, alerts, forecast, snapshots, availablePoints, merchantTags, loading, lastSyncedAt } = useFinanceData();
  // Owner = the person who owns the finance rows (vs. a granted view-only user,
  // who only sees the owner's rows they were granted). Gates the admin UI.
  const isOwner = useMemo(() => !!user && accounts.some((a) => a.userId === user.id), [user, accounts]);
  // Require 2FA for everyone: a signed-in user with no verified authenticator
  // factor sits at aal1/aal1 — block them on a mandatory enrollment screen.
  const [needsMfa, setNeedsMfa] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!user) { setNeedsMfa(null); return; }
    supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => { if (!cancelled) setNeedsMfa(data?.currentLevel === 'aal1' && data?.nextLevel === 'aal1'); })
      .catch(() => { if (!cancelled) setNeedsMfa(false); });
    return () => { cancelled = true; };
  }, [user]);
  const [company, setCompany] = useState('all');
  const [selectedCard, setSelectedCard] = useState<FinanceCard | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<FinanceAccount | null>(null);
  const [activityPeriod, setActivityPeriod] = useState<'month' | '30d' | '90d' | 'ytd' | 'all'>('month');
  const [cardSort, setCardSort] = useState<CardSort>('urgency');
  const [activityDetail, setActivityDetail] = useState<null | 'income' | 'spend' | 'payments'>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null); // YYYY-MM clicked on the spend chart
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null); // category drill-down in the Categories tab
  const [categorySource, setCategorySource] = useState<string | null>(null); // Categories tab: filter to one card/account id (null = all)
  const [insightTab, setInsightTab] = useState<'spending' | 'categories' | 'activity' | 'recurring' | 'properties' | 'business' | 'projection'>('spending');
  // Dismissed alerts, keyed by a per-cycle signature so they return when action
  // is next needed (e.g. new due date / new statement). Persisted per browser.
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('ct_dismissed_alerts') || '[]')); }
    catch { return new Set<string>(); }
  });
  const dismiss = (sig: string) => setDismissed((prev) => {
    const next = new Set(prev); next.add(sig);
    try { localStorage.setItem('ct_dismissed_alerts', JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  useEffect(() => {
    if (authLoading) return;
    if (!user) { navigate('/auth'); return; }
    // Enforce 2FA: if a verified factor requires step-up and the session is only
    // AAL1, bounce to the login screen to complete the authenticator code.
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data, error }) => {
      if (!error && data?.nextLevel === 'aal2' && data.currentLevel === 'aal1') navigate('/auth');
    }).catch(() => {});
  }, [user, authLoading, navigate]);

  const companies = useMemo(
    () => Array.from(new Set([
      ...cards.map((c) => c.companyName),
      ...accounts.map((a) => a.company),
    ].filter(Boolean))).sort() as string[],
    [cards, accounts],
  );

  // Total paid toward each card's current statement (payments on/after its close
  // date), from transactions — handles installment payments.
  const paidTowardStatementByCard = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of transactions) {
      if (t.type !== 'payment' || !t.creditCardId) continue;
      const card = cards.find((c) => c.id === t.creditCardId);
      if (card?.lastStatementDate && t.date >= card.lastStatementDate) {
        m.set(t.creditCardId, (m.get(t.creditCardId) ?? 0) + t.amount);
      }
    }
    for (const c of cards) {
      if (c.lastPaymentAmount && c.lastPaymentDate && c.lastStatementDate && c.lastPaymentDate >= c.lastStatementDate) {
        m.set(c.id, Math.max(m.get(c.id) ?? 0, c.lastPaymentAmount));
      }
    }
    return m;
  }, [transactions, cards]);
  const paidFor = (id: string) => paidTowardStatementByCard.get(id) ?? 0;

  const visibleCards = useMemo(() => {
    const filtered = company === 'all' ? cards : cards.filter((c) => c.companyName === company);
    return [...filtered].sort((a, b) => compareCards(a, b, cardSort, paidFor));
  }, [cards, company, cardSort, paidTowardStatementByCard]);

  const depository = useMemo(
    () => accounts
      .filter((a) => a.accountType === 'checking' || a.accountType === 'savings')
      .filter((a) => company === 'all' || a.company === company),
    [accounts, company],
  );

  const loans = useMemo(
    () => accounts
      .filter((a) => a.accountType === 'loan')
      .filter((a) => company === 'all' || a.company === company),
    [accounts, company],
  );

  // A transaction belongs to the selected brand if its card or its account does.
  const brandTxns = useMemo(() => {
    if (company === 'all') return transactions;
    const cardIds = new Set(cards.filter((c) => c.companyName === company).map((c) => c.id));
    const acctIds = new Set(accounts.filter((a) => a.company === company).map((a) => a.id));
    return transactions.filter((t) =>
      (t.creditCardId && cardIds.has(t.creditCardId)) || (t.accountId && acctIds.has(t.accountId)));
  }, [transactions, cards, accounts, company]);

  // "Recent Transactions" list: non-payment activity ordered by when it was
  // SYNCED into our DB (created_at), not by posting date — so a charge that just
  // arrived in a sync but is dated a few days ago still surfaces at the top
  // instead of being buried below newer-dated rows. Falls back to posting date
  // when created_at is missing.
  const recentTxns = useMemo(() => {
    const sortKey = (t: FinanceTransaction) => t.createdAt ?? t.date;
    return brandTxns
      .filter((t) => t.type !== 'payment')
      .slice()
      .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  }, [brandTxns]);
  // A transaction is "new" if it was synced into our DB within the last 48h.
  const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;
  const isNewTxn = (t: FinanceTransaction) =>
    t.createdAt != null && Date.now() - new Date(t.createdAt).getTime() < NEW_WINDOW_MS;

  // ── Top-line numbers ────────────────────────────────────────────────
  const availableCash = depository.reduce((s, a) => s + a.availableBalance, 0);
  const totalCardDebt = visibleCards.reduce((s, c) => s + c.currentBalance, 0);
  const statementDue = visibleCards.reduce((s, c) => s + c.currentBalance, 0);
  const creditAvailable = visibleCards.reduce(
    (s, c) => s + Math.max(0, c.creditLimit - c.currentBalance), 0,
  );

  // ── Activity roll-up, scoped to a selected period ──────────────────
  // TD account (••5097) is the owner's investment-property bucket: rent income
  // and property costs there are NOT personal income/spend — they're shown
  // separately in the Properties tab and excluded from the personal figures.
  const propertyAccountIds = useMemo(() => {
    const propLast4 = new Set(['5097']); // TD Personal CHK — rentals (default bucket)
    return new Set(accounts.filter((a) => a.lastFour && propLast4.has(a.lastFour)).map((a) => a.id));
  }, [accounts]);

  // VOWIDEAS business checking (Chase ••7015): default bucket = business.
  const businessAccountIds = useMemo(
    () => new Set(accounts.filter((a) => a.lastFour === '7015').map((a) => a.id)),
    [accounts],
  );

  // Michael's CHK ('0015') — excluded from the Monthly Spending chart (and the
  // category breakdown), but not from the rest of my figures.
  const michaelAccountIds = useMemo(
    () => new Set(accounts.filter((a) => a.lastFour === '0015').map((a) => a.id)),
    [accounts],
  );

  // Classify a transaction Personal / Property / Business. A per-merchant tag
  // wins (remembered across syncs/months); otherwise the default is account-based
  // (TD = property, Chase 7015 = business, everything else = personal).
  const classify = useCallback((t: FinanceTransaction): TxnTag => {
    const tag = merchantTags.get(merchantKey(t));
    if (tag === 'property' || tag === 'personal' || tag === 'business') return tag;
    if (t.accountId && propertyAccountIds.has(t.accountId)) return 'property';
    if (t.accountId && businessAccountIds.has(t.accountId)) return 'business';
    return 'personal';
  }, [merchantTags, propertyAccountIds, businessAccountIds]);
  const isProperty = useCallback((t: FinanceTransaction) => classify(t) === 'property', [classify]);
  const isBusiness = useCallback((t: FinanceTransaction) => classify(t) === 'business', [classify]);
  const isPersonal = useCallback((t: FinanceTransaction) => classify(t) === 'personal', [classify]);

  // Tag a merchant/payee — applies to all of its transactions.
  const setMerchantTag = async (key: string, tag: TxnTag) => {
    if (!user || !key) return;
    await (supabase as any).from('merchant_tags').upsert(
      { user_id: user.id, merchant_key: key, tag, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,merchant_key' },
    );
    refreshFinance();
  };
  // Remove a tag rule — reverts that payee to the default (account-based).
  const removeMerchantTag = async (key: string) => {
    if (!user || !key) return;
    await (supabase as any).from('merchant_tags').delete().eq('user_id', user.id).eq('merchant_key', key);
    refreshFinance();
  };

  const activityFrom = activityPeriod === 'month' ? isoMonthStart()
    : activityPeriod === '30d' ? isoDaysAgo(30)
    : activityPeriod === '90d' ? isoDaysAgo(90)
    : activityPeriod === 'ytd' ? isoYearStart() : '';
  const activityTxns = useMemo(
    () => brandTxns.filter((t) => (!activityFrom || t.date >= activityFrom) && isPersonal(t)),
    [brandTxns, activityFrom, isPersonal],
  );
  // Income = real deposits only (refunds are money-back on purchases, not revenue).
  // Spending = purchases + fees, net of refunds (a refund reverses a purchase).
  const income = activityTxns.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const refunds = activityTxns.filter((t) => t.type === 'refund').reduce((s, t) => s + t.amount, 0);
  const spend = activityTxns.filter((t) => t.type === 'expense' || t.type === 'fee').reduce((s, t) => s + t.amount, 0) - refunds;
  // Card payments can be recorded twice — once as the bank outflow (account_id,
  // no card) and once on the card that received it (credit_card_id). Show every
  // payment ONCE: all bank-side payments, plus any card-side payment that has no
  // matching bank-side payment (its bank debit hasn't synced yet — common on
  // Amex — or was paid from an unconnected account). Match by amount + near date.
  const payments = useMemo(() => {
    const bankSide = activityTxns.filter((t) => t.type === 'payment' && !t.creditCardId);
    const cardSide = activityTxns.filter((t) => t.type === 'payment' && t.creditCardId);
    const daysApart = (a: string, b: string) =>
      Math.abs(differenceInCalendarDays(parseISO(a), parseISO(b)));
    const unmatchedCardSide = cardSide.filter(
      (cp) => !bankSide.some((bp) => Math.abs(bp.amount - cp.amount) < 0.005 && daysApart(bp.date, cp.date) <= 5),
    );
    return [...bankSide, ...unmatchedCardSide].sort((a, b) => b.date.localeCompare(a.date));
  }, [activityTxns]);
  const paymentsTotal = payments.reduce((s, t) => s + t.amount, 0);

  // Rental-property cash flow through the TD account, over the selected period:
  // rent/income IN vs property costs OUT (expenses, fees, mortgage/loan payments).
  // Transfers to/from personal are excluded (own-money moves, not cash flow).
  const isRentIn = (t: FinanceTransaction) =>
    t.type === 'income' || (t.type === 'transfer' && (t.category ?? '').startsWith('transfer_in'));
  // Whether a property txn falls in the selected period. For the single-MONTH
  // view, RENT is attributed by its "rent month": payments arriving in the last
  // ROLL_RENT_DAYS of a month count toward the NEXT month, so rent that comes a
  // few days early (e.g. NJ rental assistance) lands in the month it's for.
  // Costs and the longer periods use the actual date.
  const ROLL_RENT_DAYS = 10;
  const inPropertyPeriod = useCallback((t: FinanceTransaction): boolean => {
    if (isRentIn(t) && activityPeriod === 'month') {
      const d = new Date(`${t.date}T00:00:00`);
      const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const base = d.getDate() > dim - ROLL_RENT_DAYS ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : d;
      const now = new Date();
      return base.getFullYear() === now.getFullYear() && base.getMonth() === now.getMonth();
    }
    return !activityFrom || t.date >= activityFrom;
  }, [activityFrom, activityPeriod]);

  const propertyFlow = useMemo(() => {
    const txns = brandTxns.filter((t) => isProperty(t) && inPropertyPeriod(t));
    const sum = (pred: (t: FinanceTransaction) => boolean) => txns.filter(pred).reduce((s, t) => s + t.amount, 0);
    const income = sum(isRentIn);
    const refunds = sum((t) => t.type === 'refund');
    const costs = sum((t) => t.type === 'expense' || t.type === 'fee' || t.type === 'payment') - refunds;
    return { income, costs, net: income - costs, count: txns.length };
  }, [brandTxns, isProperty, inPropertyPeriod]);

  // The property account's own transactions (within the selected period), newest
  // first — listed under the Properties tab so you can see the rental activity.
  const propertyTxns = useMemo(
    () => brandTxns
      .filter((t) => isProperty(t) && inPropertyPeriod(t))
      .slice()
      .sort((a, b) => ((a.createdAt ?? a.date) < (b.createdAt ?? b.date) ? 1 : -1)),
    [brandTxns, isProperty, inPropertyPeriod],
  );

  // VOWIDEAS business cash flow (Chase ••7015) over the selected period: income
  // in (deposits) vs expenses out (expense/fee/card payments) and owner draws/
  // payroll out (outgoing transfers). Net = income − expenses − draws.
  const businessFlow = useMemo(() => {
    const txns = brandTxns.filter((t) => isBusiness(t) && (!activityFrom || t.date >= activityFrom));
    const sum = (pred: (t: FinanceTransaction) => boolean) => txns.filter(pred).reduce((s, t) => s + t.amount, 0);
    const isInflow = (t: FinanceTransaction) => t.type === 'income' || (t.type === 'transfer' && (t.category ?? '').startsWith('transfer_in'));
    // Owner draws / payroll: money moved OUT of the business to a personal account —
    // a Plaid transfer_out, or a "transfer to checking" (e.g. to the owner's Citi ••3017).
    const isDraw = (t: FinanceTransaction) => !isInflow(t) && (
      (t.type === 'transfer' && (t.category ?? '').startsWith('transfer_out'))
      || /transfer to checking/i.test(t.description ?? '')
    );
    const income = sum(isInflow);
    const refunds = sum((t) => t.type === 'refund');
    const draws = sum(isDraw);
    const expenses = sum((t) => !isDraw(t) && (t.type === 'expense' || t.type === 'fee' || t.type === 'payment')) - refunds;
    return { income, expenses, draws, net: income - expenses - draws };
  }, [brandTxns, isBusiness, activityFrom]);

  const businessTxns = useMemo(
    () => brandTxns
      .filter((t) => isBusiness(t) && (!activityFrom || t.date >= activityFrom))
      .slice()
      .sort((a, b) => ((a.createdAt ?? a.date) < (b.createdAt ?? b.date) ? 1 : -1)),
    [brandTxns, isBusiness, activityFrom],
  );

  // Spending by category ("all money out"): every outflow — purchases, fees, and
  // real debt service (mortgage/car/other loans) — but NOT transfers, card
  // payments (the purchases they pay for are already counted), or property/
  // business. Refunds net against their category.
  const categoryOutflow = useCallback((t: FinanceTransaction): number => {
    if (t.type === 'expense' || t.type === 'fee') return t.amount;
    if (t.type === 'refund') return -t.amount;
    if (t.type === 'payment' && !t.creditCardId) {
      const c = t.category ?? '';
      if (c.startsWith('loan_payments') && !c.includes('credit_card')) return t.amount;
    }
    return 0;
  }, []);
  const inCategoryScope = useCallback((t: FinanceTransaction) => {
    if (activityFrom && t.date < activityFrom) return false;
    // Filtered to one card/account: show everything on it (any tag). Otherwise the
    // default view is personal-only (property/business/Michael excluded).
    if (categorySource) return t.creditCardId === categorySource || t.accountId === categorySource;
    return isPersonal(t) && !(t.accountId && michaelAccountIds.has(t.accountId));
  }, [activityFrom, categorySource, isPersonal, michaelAccountIds]);
  const categoryData = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const t of brandTxns) {
      const amt = categoryOutflow(t);
      if (amt === 0 || !inCategoryScope(t)) continue;
      const label = categoryLabel(t);
      byCat.set(label, (byCat.get(label) ?? 0) + amt);
    }
    const entries = [...byCat.entries()]
      .map(([label, amount]) => ({ label, amount: Math.round(amount * 100) / 100 }))
      .filter((e) => e.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const colors = isDark ? CAT_COLORS_DARK : CAT_COLORS_LIGHT;
    let slices: { key: string; label: string; amount: number; color: string }[];
    let otherLabels: string[] = [];
    if (entries.length > colors.length) {
      otherLabels = entries.slice(colors.length).map((e) => e.label);
      const otherAmt = Math.round(entries.slice(colors.length).reduce((s, e) => s + e.amount, 0) * 100) / 100;
      slices = entries.slice(0, colors.length).map((e, i) => ({ key: e.label, label: e.label, amount: e.amount, color: colors[i] }));
      if (otherAmt > 0) slices.push({ key: '__other__', label: 'Everything else', amount: otherAmt, color: CAT_OTHER });
    } else {
      slices = entries.map((e, i) => ({ key: e.label, label: e.label, amount: e.amount, color: colors[i] ?? CAT_OTHER }));
    }
    const total = Math.round(slices.reduce((s, e) => s + e.amount, 0) * 100) / 100;
    return { slices: slices.map((s) => ({ ...s, pct: total > 0 ? s.amount / total : 0 })), total, otherLabels };
  }, [brandTxns, categoryOutflow, inCategoryScope, isDark]);
  const categoryTxns = useMemo(() => {
    if (!selectedCategory) return [] as FinanceTransaction[];
    const inSel = (t: FinanceTransaction) => selectedCategory === '__other__'
      ? categoryData.otherLabels.includes(categoryLabel(t))
      : categoryLabel(t) === selectedCategory;
    return brandTxns
      .filter((t) => categoryOutflow(t) > 0 && inCategoryScope(t) && inSel(t))
      .slice()
      .sort((a, b) => ((a.createdAt ?? a.date) < (b.createdAt ?? b.date) ? 1 : -1));
  }, [selectedCategory, brandTxns, categoryOutflow, inCategoryScope, categoryData.otherLabels]);
  // Cards + accounts, for the "filter by card" selector on the Categories tab.
  const categorySources = useMemo(() => [
    ...cards.map((c) => ({ id: c.id, label: `${c.name} ••${c.lastFour}` })),
    ...accounts.map((a) => ({ id: a.id, label: `${a.name} ••${a.lastFour}` })),
  ], [cards, accounts]);

  // Month-over-month spending: net spend (purchases + fees − refunds) per
  // calendar month for the trailing 12 months, from the first month with data
  // up to now. Gaps fill as 0; the current (in-progress) month is flagged partial.
  // Michael's CHK ('0015') is excluded here (not from the rest); property is
  // handled separately via isProperty (tag-aware).
  const monthlySpend = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const t of brandTxns) {
      if (t.type !== 'expense' && t.type !== 'fee' && t.type !== 'refund') continue;
      if ((t.accountId && michaelAccountIds.has(t.accountId)) || !isPersonal(t)) continue;
      const key = t.date.slice(0, 7); // YYYY-MM
      byMonth.set(key, (byMonth.get(key) ?? 0) + (t.type === 'refund' ? -t.amount : t.amount));
    }
    if (byMonth.size === 0) return [] as { key: string; label: string; total: number; partial: boolean }[];
    const now = new Date();
    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const firstKey = [...byMonth.keys()].sort()[0];
    const out: { key: string; label: string; total: number; partial: boolean }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (key < firstKey) continue; // don't show empty months before any data
      out.push({
        key,
        label: format(d, 'MMM'),
        total: Math.max(0, Math.round((byMonth.get(key) ?? 0) * 100) / 100),
        partial: key === curKey,
      });
    }
    return out;
  }, [brandTxns, michaelAccountIds, isPersonal]);
  // Trend read on COMPLETE months only (the current month is partial, so comparing
  // it would falsely look "down"). Average line covers the completed months.
  const spendInsight = useMemo(() => {
    const complete = monthlySpend.filter((m) => !m.partial);
    const avg = complete.length ? complete.reduce((s, m) => s + m.total, 0) / complete.length : 0;
    if (complete.length < 2) return { avg, momPct: null as number | null, down: false, lastLabel: '', prevLabel: '' };
    const last = complete[complete.length - 1];
    const prev = complete[complete.length - 2];
    const momPct = prev.total > 0 ? Math.round(((last.total - prev.total) / prev.total) * 100) : null;
    return { avg, momPct, down: last.total < prev.total, lastLabel: last.label, prevLabel: prev.label };
  }, [monthlySpend]);

  // Recurring charges — detected from the FULL history (not the activity window).
  // Property-account (TD) charges are excluded: those are rental costs, shown in
  // the Properties tab, not personal subscriptions.
  const recurring = useMemo(
    () => detectRecurring(brandTxns.filter((t) => isPersonal(t))),
    [brandTxns, isPersonal],
  );
  const recurringMonthly = recurring.reduce((s, r) => s + r.monthlyEquivalent, 0);

  // 0% balance-transfer promo payoff tracker (per BT_PROMOS). Tracks the
  // transferred balance specifically: principal auto-detected from the card's
  // "balance transfer" charges, minus payments made since the transfer.
  const btPromos = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const threeMoAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate()).toISOString().slice(0, 10);
    return BT_PROMOS.flatMap((cfg) => {
      const card = cards.find((c) => c.lastFour === cfg.last4);
      if (!card) return [];
      const isBT = (t: FinanceTransaction) => /balance\s*transfer/i.test(`${t.description} ${t.merchantName ?? ''}`);
      const btTxns = transactions.filter((t) => t.creditCardId === card.id && isBT(t));
      if (btTxns.length === 0) return [];
      const detected = Math.round(btTxns.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100;
      const transferDate = btTxns.map((t) => t.date).sort()[0];
      const pays = transactions.filter((t) => t.creditCardId === card.id && t.type === 'payment' && t.date >= transferDate);
      // Remaining = the card's LIVE balance straight from Plaid (authoritative).
      // We intentionally DON'T cap it at the auto-detected transfer amount — that
      // detection misses charges outside the synced window and was under-reporting
      // the real payoff. The headline always equals exactly what Plaid reports.
      const remaining = Math.max(0, Math.round(card.currentBalance * 100) / 100);
      // "Transferred" baseline for the progress bar only: reconstruct from what's
      // still owed plus payments made since the transfer; never below the detected
      // amount, so remaining can't exceed the baseline.
      const paidSoFar = Math.max(0, Math.round(pays.reduce((s, t) => s + t.amount, 0) * 100) / 100);
      const original = Math.max(detected, Math.round((remaining + paidSoFar) * 100) / 100);
      const paid = Math.max(0, Math.round((original - remaining) * 100) / 100);
      const end = new Date(`${cfg.endDate}T00:00:00`);
      const daysLeft = Math.round((end.getTime() - today.getTime()) / 86_400_000);
      const monthsLeft = Math.max(0, daysLeft / 30.44);
      const requiredMonthly = monthsLeft > 0.1 ? remaining / monthsLeft : remaining;
      const recentPace = pays.filter((t) => t.date >= threeMoAgo).reduce((s, t) => s + t.amount, 0) / 3;
      const projShortfall = Math.max(0, Math.round((remaining - recentPace * monthsLeft) * 100) / 100);
      const onTrack = remaining <= 0.005 || recentPace + 0.005 >= requiredMonthly;
      const interestIfMissed = Math.round(projShortfall * (cfg.goToApr / 100));
      return [{ card, cfg, original, paid, remaining, daysLeft, requiredMonthly, recentPace, onTrack, projShortfall, interestIfMissed }];
    });
  }, [cards, transactions]);
  const recurringYearly = recurringMonthly * 12;
  // Show most-recently-charged first ("latest on top"), by last charge date.
  const recurringSorted = useMemo(
    () => [...recurring].sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0)),
    [recurring],
  );

  const cardName = (id: string | null) =>
    cards.find((c) => c.id === id)?.name ?? null;

  // Which bank/card a transaction came from (for the breakdown view).
  const sourceOf = (t: FinanceTransaction): string => {
    if (t.creditCardId) {
      const c = cards.find((c) => c.id === t.creditCardId);
      if (c) return c.lastFour ? `${c.name} ••${c.lastFour}` : c.name;
    }
    if (t.accountId) {
      const a = accounts.find((a) => a.id === t.accountId);
      if (a) return a.lastFour ? `${a.name} ••${a.lastFour}` : a.name;
    }
    return 'Unlinked';
  };

  // A bank-side payment has no card link, but the same payment is also recorded
  // on the card that received it. Match by amount + nearest date to find which
  // card a payment went to.
  const cardSidePayments = useMemo(
    () => transactions.filter((t) => t.type === 'payment' && t.creditCardId),
    [transactions],
  );
  const paymentDestCard = (t: FinanceTransaction): string | null => {
    if (t.creditCardId) return sourceOf(t); // already card-linked
    const matches = cardSidePayments.filter((c) => Math.abs(c.amount - t.amount) < 0.005);
    if (matches.length === 0) return null;
    matches.sort((a, b) =>
      Math.abs(differenceInCalendarDays(parseISO(a.date), parseISO(t.date))) -
      Math.abs(differenceInCalendarDays(parseISO(b.date), parseISO(t.date))));
    const c = cards.find((c) => c.id === matches[0].creditCardId);
    return c ? (c.lastFour ? `${c.name} ••${c.lastFour}` : c.name) : null;
  };

  const periodLabel = activityPeriod === 'month' ? 'This month'
    : activityPeriod === '30d' ? 'Last 30 days'
    : activityPeriod === '90d' ? 'Last 90 days'
    : activityPeriod === 'ytd' ? 'Year to date' : 'All time';

  const activityBreakdown = useMemo(() => {
    if (!activityDetail) return null;
    const cfg = {
      income: { title: 'Income', tone: 'success' as Tone, calc: 'Deposits only (revenue). Refunds are not income.',
        txns: activityTxns.filter((t) => t.type === 'income') },
      spend: { title: 'Spending', tone: 'warning' as Tone, calc: 'Purchases + fees, net of refunds (refunds shown as negative). Excludes card payments & transfers.',
        txns: [
          ...activityTxns.filter((t) => t.type === 'expense' || t.type === 'fee'),
          // Refunds subtract from spending — show them as negative line items.
          ...activityTxns.filter((t) => t.type === 'refund').map((t) => ({ ...t, amount: -t.amount })),
        ] },
      payments: { title: 'Card Payments', tone: 'muted' as Tone, calc: 'Cash paid from bank accounts toward cards (each payment counted once)',
        txns: payments },
    }[activityDetail];
    return { ...cfg, period: periodLabel };
  }, [activityDetail, activityTxns, payments, periodLabel]);

  // Breakdown for a month clicked on the spending chart: that month's spend
  // transactions (same definition as the Spending flow), grouped by source.
  const monthBreakdown = useMemo(() => {
    if (!selectedMonth) return null;
    const inMonth = (t: FinanceTransaction) =>
      t.date.slice(0, 7) === selectedMonth && !(t.accountId && michaelAccountIds.has(t.accountId)) && isPersonal(t);
    const txns = [
      ...brandTxns.filter((t) => inMonth(t) && (t.type === 'expense' || t.type === 'fee')),
      ...brandTxns.filter((t) => inMonth(t) && t.type === 'refund').map((t) => ({ ...t, amount: -t.amount })),
    ];
    let label = selectedMonth;
    try { label = format(new Date(`${selectedMonth}-01T00:00:00`), 'MMMM yyyy'); } catch { /* keep key */ }
    return {
      title: 'Spending',
      tone: 'warning' as Tone,
      calc: 'Purchases + fees, net of refunds (refunds shown as negative). Excludes card payments & transfers.',
      txns,
      period: label,
    };
  }, [selectedMonth, brandTxns, michaelAccountIds, isPersonal]);

  // Cards needing attention: overdue, or due within 7 days with a balance owed.
  const attentionCards = useMemo(
    () => visibleCards
      .filter((c) => c.isOverdue
        || unpaidStatementDueWithin(c, paidFor(c.id), 15) != null
        || (() => { const d = resolveDue(c); return d && d.days <= 7 && !isSettled(c, paidFor(c.id)); })())
      .sort((a, b) => urgencyRank(a, paidFor(a.id)) - urgencyRank(b, paidFor(b.id))),
    [visibleCards],
  );
  // Synced alerts, but suppress stale ones contradicted by the card's current
  // state (payment-due alerts for cards now paid; over-limit alerts no longer over).
  const openAlerts = useMemo(
    () => alerts.filter((a) => {
      if ((a.status ?? 'open').toLowerCase() === 'resolved') return false;
      // Due-payment alerts are computed live from card data (see attentionCards),
      // so ignore the synced payment_due rows — they go stale.
      if (a.alertType === 'payment_due') return false;
      const card = a.creditCardId ? cards.find((c) => c.id === a.creditCardId) : null;
      if (card) {
        if (a.alertType === 'high_balance' && card.creditLimit > 0 && card.currentBalance <= card.creditLimit + 0.005) return false;
      }
      return true;
    }),
    [alerts, cards, paidTowardStatementByCard],
  );

  // Total paid toward each card's current statement (sum of payments on/after the
  // statement close date), from actual transactions — handles installments.

  // Cards where the statement was underpaid → interest will accrue.
  const interestRiskCards = useMemo(
    () => visibleCards.map((c) => ({ card: c, risk: interestRisk(c, paidTowardStatementByCard.get(c.id) ?? 0) })).filter((x) => x.risk != null),
    [visibleCards, paidTowardStatementByCard],
  );

  // Calendar-year ad spend, per card with a configured annual cap.
  const adSpendByCard = useMemo(() => {
    const map = new Map<string, AdSpendStatus>();
    for (const c of cards) {
      const limit = adSpendLimitFor(c);
      if (limit) map.set(c.id, computeAdSpend(transactions, c.id, limit));
    }
    return map;
  }, [cards, transactions]);

  // Ad-spend caps ≥80% used surface in Needs Attention.
  const adSpendWarnings = useMemo(
    () => visibleCards
      .map((c) => ({ card: c, ad: adSpendByCard.get(c.id) }))
      .filter((x): x is { card: FinanceCard; ad: AdSpendStatus } => x.ad != null && x.ad.fraction >= 0.8)
      .sort((a, b) => b.ad.fraction - a.ad.fraction),
    [visibleCards, adSpendByCard],
  );

  // Per-cycle dismiss signatures — change when action is next required, so a
  // dismissed alert reappears (new due date, new statement, next year, etc.).
  const thisYear = new Date().getFullYear();
  const dueSig = (c: FinanceCard) => `due:${c.id}:${resolveDue(c)?.date.toISOString().slice(0, 10) ?? 'na'}`;
  const riskSig = (card: FinanceCard) => `risk:${card.id}:${card.lastStatementDate ?? 'na'}`;
  const adSig = (card: FinanceCard, ad: AdSpendStatus) => `ad:${card.id}:${thisYear}:${Math.floor(ad.fraction * 10)}`;
  const alertSig = (a: FinanceAlert) => `alert:${a.id}`;

  const shownInterest = interestRiskCards.filter(({ card }) => !dismissed.has(riskSig(card)));
  const shownAdSpend = adSpendWarnings.filter(({ card, ad }) => !dismissed.has(adSig(card, ad)));
  const shownAlerts = openAlerts.filter((a) => !dismissed.has(alertSig(a)));

  // The "Due this week" hero's payment plan: every card that needs a payment
  // (overdue / due soon / unpaid statement), with the amount owed and timing.
  // Same source set as the old due-reminder rows, now shown as the headline.
  const duePlan = useMemo(() => attentionCards.map((c) => {
    const stmt = (c.lastStatementBalance && c.lastStatementBalance > 0.005) ? c.lastStatementBalance : 0;
    // Bill the uncovered remainder of the statement (reflects payments already
    // made), mirroring the card tile — falls back to current/min balance when
    // there's no statement figure.
    const paid = stmt > 0 ? Math.min(stmt, Math.max(paidFor(c.id), Math.max(0, stmt - c.currentBalance))) : 0;
    const amount = stmt > 0 ? Math.max(0, stmt - paid) : (c.currentBalance || c.minimumPayment || c.totalBalance || 0);
    return { card: c, amount, due: resolveDue(c), overdue: c.isOverdue };
  }), [attentionCards]);
  const duePlanTotal = duePlan.reduce((s, x) => s + x.amount, 0);
  const overdueCount = duePlan.filter((x) => x.overdue).length;

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  // Available-cash trend for the hero sparkline. balance_snapshots are depository
  // only, so this is total available cash per day (summed across bank accounts),
  // not net position (card balances aren't snapshotted). Last 30 days.
  const cashTrend = useMemo(() => {
    const depIds = new Set(depository.map((a) => a.id));
    const byDate = new Map<string, number>();
    for (const s of snapshots) {
      if (!depIds.has(s.accountId)) continue;
      byDate.set(s.date, (byDate.get(s.date) ?? 0) + (s.availableBalance || 0));
    }
    return [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-30)
      .map(([date, total]) => ({ date, total }));
  }, [snapshots, depository]);
  const cashDelta = cashTrend.length >= 2
    ? cashTrend[cashTrend.length - 1].total - cashTrend[0].total
    : null;

  // Forecast: lowest projected balance point over the horizon.
  const lowestPoint = useMemo(() => {
    if (forecast.length === 0) return null;
    return forecast.reduce((min, p) => (p.projectedBalance < min.projectedBalance ? p : min), forecast[0]);
  }, [forecast]);
  const endPoint = forecast.length ? forecast[forecast.length - 1] : null;

  // Stale-sync detection: warn if data hasn't synced in 2+ days.
  const syncHoursAgo = lastSyncedAt ? (Date.now() - new Date(lastSyncedAt).getTime()) / 3_600_000 : null;
  const syncStale = !loading && (syncHoursAgo == null || syncHoursAgo >= 48);
  const syncDaysAgo = syncHoursAgo != null ? Math.floor(syncHoursAgo / 24) : null;

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Mandatory 2FA: block the app until the signed-in user has enrolled.
  if (needsMfa === true) {
    return <ForceMfaSetup onDone={() => setNeedsMfa(false)} onSignOut={async () => { await signOut(); navigate('/auth'); }} />;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
              <Wallet className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Personal Finance Tracker</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="w-9 px-0" aria-label="Toggle dark mode"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={() => setTheme(isDark ? 'light' : 'dark')}>
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
            <UserMenu userEmail={user?.email || ''} isOwner={isOwner} onSignOut={async () => { await signOut(); navigate('/auth'); }} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-semibold">{greeting}</h2>
            <p className="text-xs text-muted-foreground">Here's your money at a glance</p>
          </div>
          <div className="flex items-center gap-3">
            {lastSyncedAt && (
              <span className={cn('text-xs flex items-center gap-1', syncStale ? 'text-destructive font-medium' : 'text-muted-foreground')}>
                {syncStale ? <AlertTriangle className="w-3 h-3" /> : <RefreshCw className="w-3 h-3" />}
                Synced {fmtDateTime(lastSyncedAt)}
              </span>
            )}
            {isOwner && <ConnectBank onSynced={refreshFinance} />}
            {companies.length > 0 && (
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-muted-foreground" />
                <Select value={company} onValueChange={setCompany}>
                  <SelectTrigger className="w-[180px] h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Companies</SelectItem>
                    {companies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Stale sync warning (full-width, above the other alerts) */}
            {syncStale && (
              <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-foreground">Data hasn't synced in {syncDaysAgo != null ? `${syncDaysAgo} day${syncDaysAgo === 1 ? '' : 's'}` : 'a while'}</p>
                  <p className="text-sm text-muted-foreground">
                    Last sync was {lastSyncedAt ? fmtDateTime(lastSyncedAt) : 'unknown'}. Balances and transactions may be out of date — click "Sync now" above.
                  </p>
                </div>
              </div>
            )}

            {/* Due this week — the headline "what do I owe, and when" panel */}
            <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
                <div>
                  <p className="text-[11px] uppercase tracking-wide font-bold text-muted-foreground">Due this week</p>
                  {duePlan.length === 0 ? (
                    <>
                      <p className="text-3xl font-bold tracking-tight mt-1 flex items-center gap-2">
                        <CheckCircle2 className="w-7 h-7 text-success" /> All caught up
                      </p>
                      <p className="text-muted-foreground mt-1">Nothing due right now — nice.</p>
                    </>
                  ) : (
                    <>
                      <p className="text-4xl font-bold tracking-tight mt-1 tabular-nums">
                        {fmtMoney(duePlanTotal)}
                        <span className="text-base font-semibold text-muted-foreground"> across {duePlan.length} {duePlan.length === 1 ? 'card' : 'cards'}</span>
                      </p>
                      <p className={cn('mt-1 text-sm', overdueCount ? 'text-destructive font-medium' : 'text-muted-foreground')}>
                        {overdueCount
                          ? `${overdueCount} overdue — pay now to avoid fees`
                          : 'Nothing overdue — pay by the due dates to skip interest'}
                      </p>
                      <div className="mt-4 space-y-2">
                        {duePlan.slice(0, 4).map(({ card, amount, due, overdue }) => {
                          const days = due?.days ?? null;
                          const chip = overdue
                            ? { cls: 'bg-destructive/10 text-destructive border-destructive/30', Icon: AlertTriangle, text: 'Overdue' }
                            : days != null
                              ? {
                                  cls: days <= 3 ? 'bg-destructive/10 text-destructive border-destructive/30'
                                    : days <= 7 ? 'bg-warning/10 text-warning border-warning/30'
                                    : 'bg-muted text-muted-foreground border-transparent',
                                  Icon: days <= 3 ? AlertTriangle : CalendarClock,
                                  text: days <= 0 ? 'Due today' : days === 1 ? 'Due in 1 day' : `Due in ${days} days`,
                                }
                              : { cls: 'bg-muted text-muted-foreground border-transparent', Icon: CalendarClock, text: 'No due date' };
                          return (
                            <button key={card.id} onClick={() => setSelectedCard(card)}
                              className="w-full flex items-center gap-3 rounded-xl border border-border/70 bg-muted/40 hover:bg-muted px-3 py-2.5 text-left transition-colors">
                              <span className="w-2.5 h-9 rounded-full shrink-0" style={{ background: card.tileColor ?? 'hsl(var(--primary))' }} />
                              <div className="min-w-0">
                                <p className="font-semibold truncate">{card.name}</p>
                                <p className="text-xs text-muted-foreground truncate">•••• {card.lastFour} · statement balance</p>
                              </div>
                              <div className="ml-auto text-right shrink-0">
                                <p className="font-bold tabular-nums">{fmtMoney(amount)}</p>
                                <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', chip.cls)}>
                                  <chip.Icon className="w-3 h-3" />{chip.text}
                                </span>
                              </div>
                              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                            </button>
                          );
                        })}
                        {duePlan.length > 4 && (
                          <p className="text-xs text-muted-foreground pl-1">+{duePlan.length - 4} more below in Your Cards</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="lg:border-l lg:border-border lg:pl-5 flex flex-col">
                  <p className="text-[11px] uppercase tracking-wide font-bold text-muted-foreground">Net cash position</p>
                  <p className={cn('text-3xl font-bold tracking-tight mt-1 tabular-nums',
                    availableCash - totalCardDebt < 0 && 'text-destructive')}>
                    {fmtMoney(availableCash - totalCardDebt)}
                  </p>
                  <div className="mt-3 space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-2"><Landmark className="w-4 h-4 text-success" />Available cash</span>
                      <span className="font-semibold tabular-nums">{fmtMoney(availableCash)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-2"><CardIcon className="w-4 h-4 text-warning" />Card debt</span>
                      <span className="font-semibold tabular-nums">−{fmtMoney(totalCardDebt)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-2"><Percent className="w-4 h-4 text-primary" />Credit available</span>
                      <span className="font-semibold tabular-nums">{fmtMoney(creditAvailable)}</span>
                    </div>
                  </div>
                  {cashTrend.length >= 2 && (
                    <div className="mt-auto pt-4">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-muted-foreground">Available cash · last {cashTrend.length} days</span>
                        {cashDelta != null && (
                          <span className={cn('font-semibold flex items-center gap-1',
                            cashDelta >= 0 ? 'text-success' : 'text-destructive')}>
                            {cashDelta >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                            {cashDelta >= 0 ? '+' : '−'}{fmtMoney(Math.abs(cashDelta))}
                          </span>
                        )}
                      </div>
                      <HeroSparkline values={cashTrend.map((p) => p.total)}
                        ariaLabel={`Available cash trend over the last ${cashTrend.length} days, currently ${fmtMoney(availableCash)}`} />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Needs Attention */}
            {(shownAlerts.length > 0 || shownInterest.length > 0 || shownAdSpend.length > 0) && (
              <div className="rounded-2xl border border-warning/40 bg-warning/5 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Bell className="w-4 h-4 text-warning" />
                  <h3 className="font-semibold text-foreground">Needs Attention</h3>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {shownInterest.map(({ card, risk }) => (
                    <AttentionItem key={`ir-${card.id}`} onOpen={() => setSelectedCard(card)} onDismiss={() => dismiss(riskSig(card))} borderClass="border-destructive/30">
                      <div className="flex items-start gap-2 min-w-0">
                        <Percent className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                        <div className="min-w-0">
                          <p className="font-medium truncate">{card.name} <span className="text-muted-foreground font-normal">••{card.lastFour}</span></p>
                          <p className="text-xs text-muted-foreground">
                            Paid {fmtMoney(risk!.paid)} of {fmtMoney(risk!.statement)} statement — interest will accrue
                          </p>
                        </div>
                      </div>
                      <span className="font-semibold whitespace-nowrap text-destructive">{fmtMoney(risk!.remaining)}</span>
                    </AttentionItem>
                  ))}
                  {shownAdSpend.map(({ card, ad }) => {
                    const over = ad.fraction >= 1;
                    const tone = ad.fraction >= 0.9 ? 'text-destructive' : 'text-warning';
                    return (
                      <AttentionItem key={`ad-${card.id}`} onOpen={() => setSelectedCard(card)} onDismiss={() => dismiss(adSig(card, ad))}
                        borderClass={ad.fraction >= 0.9 ? 'border-destructive/30' : undefined}>
                        <div className="flex items-start gap-2 min-w-0">
                          <Megaphone className={cn('w-4 h-4 mt-0.5 shrink-0', tone)} />
                          <div className="min-w-0">
                            <p className="font-medium truncate">
                              {card.name} <span className="text-muted-foreground font-normal">••{card.lastFour}{card.companyName ? ` · ${card.companyName}` : ''} · ad spend {Math.round(ad.fraction * 100)}% of cap</span>
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {fmtMoney(ad.spent)} of {fmtMoney(ad.limit)}
                              {over ? ' — over the annual cap' : ` · on pace for ${fmtMoney(ad.projected)} by Dec 31`}
                            </p>
                          </div>
                        </div>
                        <span className={cn('font-semibold whitespace-nowrap', tone)}>
                          {over ? `+${fmtMoney(ad.spent - ad.limit)}` : `${fmtMoney(ad.limit - ad.spent)} left`}
                        </span>
                      </AttentionItem>
                    );
                  })}
                  {shownAlerts.map((a) => (
                    <AttentionItem key={a.id} onDismiss={() => dismiss(alertSig(a))}>
                      <div className="flex items-start gap-2 min-w-0">
                        <AlertTriangle className={cn('w-4 h-4 mt-0.5 shrink-0',
                          (a.severity ?? '').toLowerCase() === 'high' ? 'text-destructive' : 'text-warning')} />
                        <div className="min-w-0">
                          <p className="font-medium truncate">{a.title ?? a.alertType ?? 'Alert'}</p>
                          {a.message && <p className="text-xs text-muted-foreground line-clamp-2">{a.message}</p>}
                        </div>
                      </div>
                    </AttentionItem>
                  ))}
                </div>
              </div>
            )}

            {/* KPI row removed — the hero already shows net cash / available /
                debt / credit. The Ask box moved to the bottom (it's a utility). */}

            {/* 0% balance-transfer promo payoff tracker (owner-only) */}
            {isOwner && btPromos.filter((p) => p.remaining > 0.005).map((p) => (
              <div key={p.card.id} className={cn('rounded-2xl border bg-card p-5 shadow-sm',
                p.daysLeft <= 90 || !p.onTrack ? 'border-warning/40' : 'border-border')}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <SectionTitle icon={Percent}>0% Balance Transfer · {p.card.name} ••{p.card.lastFour}</SectionTitle>
                  <span className={cn('text-sm font-semibold', p.daysLeft <= 90 ? 'text-warning' : 'text-muted-foreground')}>
                    0% ends {fmtDate(p.cfg.endDate)} · {p.daysLeft >= 0 ? `${p.daysLeft} days left` : 'ended'}
                  </span>
                </div>
                <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr] mt-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Transfer balance remaining</p>
                    <p className="text-3xl font-bold tracking-tight tabular-nums">{fmtMoney(p.remaining)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Paid {fmtMoney(p.paid)} of {fmtMoney(p.original)} transferred</p>
                    <div className="h-2 rounded-full bg-muted overflow-hidden mt-3">
                      <div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, Math.max(2, (p.paid / p.original) * 100))}%` }} />
                    </div>
                  </div>
                  <div className="lg:border-l lg:border-border lg:pl-5 space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Pay to clear in time</span>
                      <span className="font-semibold tabular-nums">{fmtMoney(p.requiredMonthly)}/mo</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Your recent pace</span>
                      <span className="font-semibold tabular-nums">{fmtMoney(p.recentPace)}/mo</span>
                    </div>
                    <div className={cn('mt-2 rounded-lg p-2.5 flex items-start gap-2 font-medium',
                      p.onTrack ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
                      {p.onTrack ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                      <span>
                        {p.onTrack
                          ? 'On track to clear the 0% balance before the rate jumps.'
                          : `Behind: at ${fmtMoney(p.recentPace)}/mo you'll still owe ~${fmtMoney(p.projShortfall)} when 0% ends — then ${p.cfg.goToApr}% APR (~${fmtMoney(p.interestIfMissed)}/yr) starts. Pay ${fmtMoney(p.requiredMonthly)}/mo to beat it.`}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {/* Bank accounts — prominent, on top */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle icon={Landmark}>Bank Accounts</SectionTitle>
                <span className="text-sm font-semibold text-success">{fmtMoney(availableCash, { cents: true })} total</span>
              </div>
              {depository.length === 0 ? (
                <div className="bg-card rounded-2xl border border-border p-5 shadow-sm"><Empty>No bank accounts synced yet.</Empty></div>
              ) : (
                // auto-fit packs as many compact tiles per row as fit (~200px
                // min), so 4 accounts land in one row and it still wraps
                // gracefully as the count grows or the screen narrows.
                <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                  {depository.map((a) => (
                    <AccountTile key={a.id} account={a}
                      history={snapshots.filter((s) => s.accountId === a.id)}
                      onClick={() => setSelectedAccount(a)} />
                  ))}
                </div>
              )}
            </div>

            {/* Loans / leases — liabilities, shown separately from cash */}
            {loans.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <SectionTitle icon={Landmark}>Loans</SectionTitle>
                  <span className="text-sm font-semibold text-muted-foreground">
                    {fmtMoney(loans.reduce((s, a) => s + a.currentBalance, 0), { cents: true })} owed
                  </span>
                </div>
                <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                  {loans.map((a) => (
                    <LoanTile key={a.id} account={a} onClick={() => setSelectedAccount(a)} />
                  ))}
                </div>
              </div>
            )}

            {/* Card tiles */}
            <div>
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <SectionTitle icon={CardIcon}>Your Cards</SectionTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Sort:</span>
                  <Select value={cardSort} onValueChange={(v) => setCardSort(v as CardSort)}>
                    <SelectTrigger className="w-[190px] h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CARD_SORT_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {visibleCards.length} {visibleCards.length === 1 ? 'card' : 'cards'}
                  </span>
                </div>
              </div>
              {visibleCards.length === 0 ? (
                <Empty>No cards to show.</Empty>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleCards.map((c) => (
                    <CardTile key={c.id} card={c} adSpend={adSpendByCard.get(c.id)} paidTowardStatement={paidTowardStatementByCard.get(c.id) ?? 0} points={availablePoints.get(c.id)} onClick={() => setSelectedCard(c)} />
                  ))}
                </div>
              )}
            </div>

            {/* Insights — spending / activity / recurring / projection, tabbed so
                only one shows at a time (keeps the page from feeling busy). */}
            <div className="flex items-center justify-between flex-wrap gap-3 pt-2">
              <SectionTitle icon={TrendingUp}>Insights</SectionTitle>
              <div className="inline-flex items-center gap-1 rounded-xl bg-muted p-1">
                {(['spending', 'categories', 'activity', 'recurring', 'properties', 'business', 'projection'] as const)
                  .filter((t) => (t !== 'projection' || forecast.length > 0)
                    && (t !== 'categories' || categoryData.total > 0 || categorySource != null)
                    && (t !== 'properties' || (isOwner && propertyAccountIds.size > 0))
                    && (t !== 'business' || (isOwner && businessAccountIds.size > 0)))
                  .map((t) => (
                    <button key={t} type="button" onClick={() => setInsightTab(t)}
                      className={cn('px-3.5 h-8 rounded-lg text-sm font-medium transition-colors capitalize',
                        insightTab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      {t === 'business' ? 'VOWIDEAS' : t}
                    </button>
                  ))}
              </div>
            </div>

            {/* Activity: income/spend/payments roll-up + recent payments & transactions */}
            {insightTab === 'activity' && (
            <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <SectionTitle icon={TrendingUp}>Activity</SectionTitle>
                <div className="flex items-center gap-1">
                  <RangeChip onClick={() => setActivityPeriod('month')} active={activityPeriod === 'month'}>This Month</RangeChip>
                  <RangeChip onClick={() => setActivityPeriod('30d')} active={activityPeriod === '30d'}>30d</RangeChip>
                  <RangeChip onClick={() => setActivityPeriod('90d')} active={activityPeriod === '90d'}>90d</RangeChip>
                  <RangeChip onClick={() => setActivityPeriod('ytd')} active={activityPeriod === 'ytd'}>YTD</RangeChip>
                  <RangeChip onClick={() => setActivityPeriod('all')} active={activityPeriod === 'all'}>All</RangeChip>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-3">
                <Flow label="Income" value={income} icon={ArrowDownRight} tone="success" onClick={() => setActivityDetail('income')} />
                <Flow label="Spending" value={spend} icon={ArrowUpRight} tone="warning" onClick={() => setActivityDetail('spend')} />
                <Flow label="Card Payments" value={paymentsTotal} icon={CardIcon} tone="muted" onClick={() => setActivityDetail('payments')} />
                <div className="flex items-center justify-between sm:justify-end sm:gap-2" title="Income − Spending">
                  <span className="text-sm font-medium">Net (income − spend)</span>
                  <span className={cn('text-sm font-bold', income - spend >= 0 ? 'text-success' : 'text-destructive')}>
                    {fmtMoney(income - spend, { cents: true })}
                  </span>
                </div>
              </div>
            </div>
            )}

            {/* Monthly spending */}
            {insightTab === 'spending' && monthlySpend.length >= 2 && (
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                  <SectionTitle icon={TrendingUp}>Monthly Spending</SectionTitle>
                  {spendInsight.momPct != null && (
                    <span className={cn('flex items-center gap-1.5 text-sm font-semibold',
                      spendInsight.down ? 'text-success' : 'text-destructive')}>
                      {spendInsight.down ? <TrendingDown className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
                      {spendInsight.down ? '↓' : '↑'} {Math.abs(spendInsight.momPct)}%
                      <span className="text-muted-foreground font-normal">
                        {spendInsight.lastLabel} vs {spendInsight.prevLabel}
                      </span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Net spend per month (purchases + fees − refunds; excludes card payments & transfers).
                  {monthlySpend.some((m) => m.partial) && ' Current month is still in progress.'}
                </p>
                <MonthlySpendChart data={monthlySpend} average={spendInsight.avg} onSelectMonth={setSelectedMonth} />
                <p className="text-[11px] text-muted-foreground mt-2">Tip: click a month to see what you spent on.</p>
              </div>
            )}

            {/* Spending by category — donut + ranked legend of where money went. */}
            {insightTab === 'categories' && (
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <SectionTitle icon={PieChartIcon}>Spending by Category</SectionTitle>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Select value={categorySource ?? 'all'}
                      onValueChange={(v) => { setCategorySource(v === 'all' ? null : v); setSelectedCategory(null); }}>
                      <SelectTrigger className="h-8 w-[210px] text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All cards &amp; accounts</SelectItem>
                        {categorySources.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1">
                      <RangeChip onClick={() => setActivityPeriod('month')} active={activityPeriod === 'month'}>This Month</RangeChip>
                      <RangeChip onClick={() => setActivityPeriod('90d')} active={activityPeriod === '90d'}>90d</RangeChip>
                      <RangeChip onClick={() => setActivityPeriod('ytd')} active={activityPeriod === 'ytd'}>YTD</RangeChip>
                      <RangeChip onClick={() => setActivityPeriod('all')} active={activityPeriod === 'all'}>All</RangeChip>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {categorySource
                    ? <>Spending on <span className="font-medium text-foreground">{categorySources.find((s) => s.id === categorySource)?.label ?? 'this card'}</span>, by category — everything out on it in the period.</>
                    : <>Where your money went — everything out (purchases, loans, rent &amp; bills), excluding transfers, card payments, and property/business.</>}
                </p>
                {categoryData.total > 0 ? (
                  <>
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,260px)_1fr] mt-4 items-center">
                      <CategoryDonut data={categoryData.slices} total={categoryData.total}
                        selected={selectedCategory}
                        onSelect={(k) => setSelectedCategory((cur) => (cur === k ? null : k))} />
                      <div className="grid gap-x-5 gap-y-0.5 sm:grid-cols-2">
                        {categoryData.slices.map((s) => (
                          <button key={s.key} type="button"
                            onClick={() => setSelectedCategory((cur) => (cur === s.key ? null : s.key))}
                            className={cn('flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors',
                              selectedCategory === s.key ? 'bg-muted' : 'hover:bg-muted/60')}>
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                              <span className="text-sm truncate">{s.label}</span>
                            </span>
                            <span className="shrink-0 text-right whitespace-nowrap">
                              <span className="text-sm font-semibold tabular-nums">{fmtMoney(s.amount)}</span>
                              <span className="text-xs text-muted-foreground ml-1.5 tabular-nums">{(s.pct * 100).toFixed(1)}%</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {selectedCategory && (
                      <div className="mt-4 border-t border-border pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">
                            {selectedCategory === '__other__' ? 'Everything else' : selectedCategory} · {categoryTxns.length} transaction{categoryTxns.length === 1 ? '' : 's'}
                          </p>
                          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setSelectedCategory(null)}>Clear</button>
                        </div>
                        <div className="space-y-2 max-h-96 overflow-y-auto overflow-x-hidden -mx-2 px-2">
                          {categoryTxns.slice(0, 100).map((t) => (
                            <TxnRow key={t.id} txn={t} source={sourceOf(t)} isNew={isNewTxn(t)} />
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-3">Tip: click a category to see the transactions behind it.</p>
                  </>
                ) : (
                  <div className="mt-6"><Empty>No spending to categorize for this selection in the chosen period.</Empty></div>
                )}
              </div>
            )}

            {/* Recurring charges — subscriptions / regular bills detected from history.
                Surfaced prominently with the annual cost, so forgotten charges stand out. */}
            {insightTab === 'recurring' && recurring.length > 0 && (
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <SectionTitle icon={Repeat}>Recurring Charges</SectionTitle>
                  <span className="text-sm text-muted-foreground">
                    <span className="font-semibold text-foreground">{fmtMoney(recurringMonthly)}</span>/mo ·{' '}
                    <span className="font-semibold text-foreground">{fmtMoney(recurringYearly)}</span>/yr · {recurring.length} found
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Charges that repeat on a schedule — a quick way to catch subscriptions you forgot you're paying for.
                </p>
                <div className="mt-3 space-y-1.5 max-h-[32rem] overflow-y-auto overflow-x-hidden -mx-1 px-1">
                  {recurringSorted.map((r) => {
                    const card = r.creditCardId ? cards.find((c) => c.id === r.creditCardId) : null;
                    const acct = r.accountId ? accounts.find((a) => a.id === r.accountId) : null;
                    const src = card ? `${card.name}${card.lastFour ? ` ••${card.lastFour}` : ''}`
                      : acct ? `${acct.name}${acct.lastFour ? ` ••${acct.lastFour}` : ''}` : null;
                    const cadenceLabel: Record<Cadence, string> = {
                      weekly: 'Weekly', biweekly: 'Every 2 wks', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 mo', yearly: 'Yearly',
                    };
                    return (
                      <div key={r.key} className="flex items-center justify-between gap-3 py-1.5 border-b border-border/50 last:border-0">
                        <div className="min-w-0">
                          <p className="font-medium truncate flex items-center gap-2">
                            {RECURRING_LABEL_OVERRIDES[r.label.toLowerCase()] ?? r.label}
                            {r.possible && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full bg-warning/15 text-warning border border-warning/30 px-1.5 py-0.5 whitespace-nowrap">
                                possible
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {cadenceLabel[r.cadence]} · {r.count}× · last {format(parseISO(r.lastDate), 'MMM d')} · next {format(parseISO(r.nextExpectedDate), 'MMM d')}
                            {src ? ` · ${src}` : ''}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-semibold">{fmtMoney(r.typicalAmount, { cents: true })}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {r.cadence !== 'monthly' && `${fmtMoney(r.monthlyEquivalent)}/mo · `}{fmtMoney(r.monthlyEquivalent * 12)}/yr
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Properties: rental cash flow through the TD account, kept out of personal spend/income */}
            {insightTab === 'properties' && isOwner && propertyAccountIds.size > 0 && (
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <SectionTitle icon={Landmark}>Rental Properties</SectionTitle>
                  <div className="flex items-center gap-1">
                    <RangeChip onClick={() => setActivityPeriod('month')} active={activityPeriod === 'month'}>This Month</RangeChip>
                    <RangeChip onClick={() => setActivityPeriod('90d')} active={activityPeriod === '90d'}>90d</RangeChip>
                    <RangeChip onClick={() => setActivityPeriod('ytd')} active={activityPeriod === 'ytd'}>YTD</RangeChip>
                    <RangeChip onClick={() => setActivityPeriod('all')} active={activityPeriod === 'all'}>All</RangeChip>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  TD account cash flow — rent in (incl. Zelle &amp; bank transfers) vs property costs out
                  (ACH/card charges &amp; mortgage). Note: money you send via Zelle isn't auto-categorized, so
                  costs can run low — review the list below. Kept separate from personal spending &amp; income.
                </p>
                <div className="grid gap-3 sm:grid-cols-3 mt-3">
                  <Flow label="Rent / income in" value={propertyFlow.income} icon={ArrowDownRight} tone="success" />
                  <Flow label="Property costs out" value={propertyFlow.costs} icon={ArrowUpRight} tone="warning" />
                  <div className="flex items-center justify-between sm:justify-end sm:gap-2" title="Rent in − costs out">
                    <span className="text-sm font-medium">Net cash flow</span>
                    <span className={cn('text-sm font-bold', propertyFlow.net >= 0 ? 'text-success' : 'text-destructive')}>
                      {fmtMoney(propertyFlow.net, { cents: true })}
                    </span>
                  </div>
                </div>
                <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground mt-5 mb-2">Property transactions</p>
                {propertyTxns.length === 0 ? (
                  <Empty>No property transactions in this period.</Empty>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto overflow-x-hidden -mx-2 px-2">
                    {propertyTxns.slice(0, 100).map((t) => (
                      <TxnRow key={t.id} txn={t} source={sourceOf(t)} isNew={isNewTxn(t)}
                        tag={classify(t)}
                        onSetTag={isOwner ? (tag) => setMerchantTag(merchantKey(t), tag) : undefined} />
                    ))}
                  </div>
                )}

                {/* Tag manager — review/correct every payee you've tagged (incl.
                    ones now hidden from this list because you marked them Personal). */}
                {merchantTags.size > 0 && (
                  <div className="mt-5 border-t border-border pt-4">
                    <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">
                      Your tags ({merchantTags.size})
                    </p>
                    <div className="space-y-1.5 max-h-80 overflow-y-auto overflow-x-hidden -mx-1 px-1">
                      {[...merchantTags.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, tag]) => (
                        <div key={key} className="flex items-center justify-between gap-3 py-1 border-b border-border/50 last:border-0">
                          <span className="text-sm truncate capitalize min-w-0">{key}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="inline-flex rounded-full border border-border overflow-hidden text-[10px] font-semibold">
                              {(['personal', 'property', 'business'] as TxnTag[]).map((opt, i) => (
                                <button key={opt} type="button" onClick={() => setMerchantTag(key, opt)}
                                  className={cn('px-2 py-0.5 transition-colors capitalize', i > 0 && 'border-l border-border',
                                    tag === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                                  {opt}
                                </button>
                              ))}
                            </div>
                            <button type="button" onClick={() => removeMerchantTag(key)} title="Remove rule (revert to default)"
                              className="text-muted-foreground hover:text-destructive text-sm leading-none px-1">✕</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* VOWIDEAS business cash flow (Chase ••7015) */}
            {insightTab === 'business' && isOwner && businessAccountIds.size > 0 && (
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <SectionTitle icon={Building2}>VOWIDEAS (Business)</SectionTitle>
                  <div className="flex items-center gap-1">
                    <RangeChip onClick={() => setActivityPeriod('month')} active={activityPeriod === 'month'}>This Month</RangeChip>
                    <RangeChip onClick={() => setActivityPeriod('90d')} active={activityPeriod === '90d'}>90d</RangeChip>
                    <RangeChip onClick={() => setActivityPeriod('ytd')} active={activityPeriod === 'ytd'}>YTD</RangeChip>
                    <RangeChip onClick={() => setActivityPeriod('all')} active={activityPeriod === 'all'}>All</RangeChip>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Cash flow through your business account (Chase ••7015) — every deposit is income. Kept separate from personal.
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-3">
                  <Flow label="Income in" value={businessFlow.income} icon={ArrowDownRight} tone="success" />
                  <Flow label="Expenses out" value={businessFlow.expenses} icon={ArrowUpRight} tone="warning" />
                  <Flow label="Payroll / draws" value={businessFlow.draws} icon={CardIcon} tone="muted" />
                  <div className="flex items-center justify-between sm:justify-end sm:gap-2" title="Income − expenses − draws">
                    <span className="text-sm font-medium">Net</span>
                    <span className={cn('text-sm font-bold', businessFlow.net >= 0 ? 'text-success' : 'text-destructive')}>
                      {fmtMoney(businessFlow.net, { cents: true })}
                    </span>
                  </div>
                </div>
                <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground mt-5 mb-2">Business transactions</p>
                {businessTxns.length === 0 ? (
                  <Empty>No business transactions in this period.</Empty>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto overflow-x-hidden -mx-2 px-2">
                    {businessTxns.slice(0, 100).map((t) => (
                      <TxnRow key={t.id} txn={t} source={sourceOf(t)} isNew={isNewTxn(t)}
                        tag={classify(t)} tagOptions={['personal', 'business']}
                        onSetTag={isOwner ? (tag) => setMerchantTag(merchantKey(t), tag) : undefined} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Activity (cont.): recent payments & transactions */}
            {insightTab === 'activity' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <SectionTitle icon={CheckCircle2}>Recent Payments</SectionTitle>
                {payments.length === 0 ? (
                  <Empty>No card payments in the synced period.</Empty>
                ) : (
                  <div className="space-y-2 mt-3 max-h-96 overflow-y-auto overflow-x-hidden -mx-2 px-2">
                    {payments.slice(0, 50).map((t) => (
                      <TxnRow key={t.id} txn={t} source={paymentDestCard(t) ? `→ ${paymentDestCard(t)}` : sourceOf(t)}
                        tag={classify(t)}
                        onSetTag={isOwner ? (tag) => setMerchantTag(merchantKey(t), tag) : undefined} />
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <SectionTitle icon={TrendingDown}>Recent Transactions</SectionTitle>
                {recentTxns.length === 0 ? (
                  <Empty>No transactions synced yet.</Empty>
                ) : (
                  <div className="space-y-2 mt-3 max-h-96 overflow-y-auto overflow-x-hidden -mx-2 px-2">
                    {recentTxns.slice(0, 50).map((t) => (
                      <TxnRow key={t.id} txn={t} source={sourceOf(t)} isNew={isNewTxn(t)}
                        tag={classify(t)}
                        onSetTag={isOwner ? (tag) => setMerchantTag(merchantKey(t), tag) : undefined} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            )}

            {/* Projection */}
            {insightTab === 'projection' && forecast.length > 0 && (
              <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                  <SectionTitle icon={TrendingUp}>Cash Projection</SectionTitle>
                  <div className="flex items-center gap-4 text-sm">
                    {lowestPoint && (
                      <span className="text-muted-foreground">
                        Lowest: <span className={cn('font-semibold', lowestPoint.projectedBalance < 0 ? 'text-destructive' : 'text-foreground')}>
                          {fmtMoney(lowestPoint.projectedBalance)}</span> on {format(parseISO(lowestPoint.date), 'MMM d')}
                      </span>
                    )}
                    {endPoint && (
                      <span className="text-muted-foreground">
                        End: <span className="font-semibold text-foreground">{fmtMoney(endPoint.projectedBalance)}</span>
                      </span>
                    )}
                  </div>
                </div>
                <CashProjectionChart data={forecast} lowest={lowestPoint} />
              </div>
            )}

            {/* Ask — AI Q&A about your finances; a utility, so it sits at the end (owner-only) */}
            {isOwner && <AskBox accounts={accounts} cards={cards} transactions={transactions} />}

          </>
        )}
      </main>

      <CardDetailDialog
        card={selectedCard}
        adSpend={selectedCard ? adSpendByCard.get(selectedCard.id) : undefined}
        transactions={selectedCard ? transactions.filter((t) => t.creditCardId === selectedCard.id) : []}
        onColorChange={setCardColor}
        onNameChange={setCardName}
        onClose={() => setSelectedCard(null)}
      />

      <AccountDetailDialog
        account={selectedAccount}
        onNameChange={setAccountName}
        transactions={selectedAccount ? transactions.filter((t) => t.accountId === selectedAccount.id) : []}
        history={selectedAccount ? snapshots.filter((s) => s.accountId === selectedAccount.id) : []}
        onClose={() => setSelectedAccount(null)}
      />

      <ActivityBreakdownDialog
        detail={activityBreakdown}
        sourceOf={sourceOf}
        onClose={() => setActivityDetail(null)}
      />

      <ActivityBreakdownDialog
        detail={monthBreakdown}
        sourceOf={sourceOf}
        onClose={() => setSelectedMonth(null)}
      />
    </div>
  );
};

// ── Presentational pieces ─────────────────────────────────────────────
type Tone = 'success' | 'warning' | 'danger' | 'muted' | 'primary';
const toneText: Record<Tone, string> = {
  success: 'text-success', warning: 'text-warning', danger: 'text-destructive',
  muted: 'text-muted-foreground', primary: 'text-primary',
};
const toneBg: Record<Tone, string> = {
  success: 'bg-success/10 text-success', warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive', muted: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
};

function Kpi({ label, value, sub, icon: Icon, tone }: {
  label: string; value: string; sub: string; icon: React.ComponentType<{ className?: string }>; tone: Tone;
}) {
  return (
    <div className="bg-card rounded-2xl p-5 shadow-sm border border-border">
      <div className="flex items-center gap-2 mb-3">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', toneBg[tone])}>
          <Icon className="w-4 h-4" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      </div>
      <p className="text-2xl font-bold text-card-foreground mb-1">{value}</p>
      <p className="text-xs text-muted-foreground truncate" title={sub}>{sub}</p>
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-4 h-4 text-primary" />
      <h3 className="font-semibold text-foreground">{children}</h3>
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-muted-foreground py-6 text-center">{children}</p>
);

function AccountTile({ account, history, onClick }: {
  account: FinanceAccount; history: BalanceSnapshot[]; onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className="bg-card rounded-2xl border border-border p-4 shadow-sm text-left w-full hover:border-primary/40 hover:shadow-md transition-all">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 overflow-hidden">
          {account.logoUrl
            ? <img src={account.logoUrl} alt="" className="w-full h-full object-contain" />
            : <Landmark className="w-4 h-4" />}
        </div>
        <p className="font-semibold text-sm leading-tight line-clamp-2 flex-1 min-w-0">{account.name}</p>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
      </div>
      <p className="text-xs text-muted-foreground truncate mb-1.5">
        {account.institution ?? 'Bank'}
        {account.lastFour ? ` •••• ${account.lastFour}` : ''}
        {' · '}{account.accountType}
      </p>
      <p className="text-2xl font-bold text-card-foreground truncate">{fmtMoney(account.availableBalance, { cents: true })}</p>
      <div className="flex items-end justify-between gap-2 mt-1">
        <p className="text-xs text-muted-foreground truncate">
          {Math.abs(account.availableBalance - account.currentBalance) > 0.005
            ? `Posted ${fmtMoney(account.currentBalance)}`
            : 'Available balance'}
        </p>
        {history.length > 1 && <Sparkline data={history} />}
      </div>
    </button>
  );
}

function LoanTile({ account, onClick }: { account: FinanceAccount; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="bg-card rounded-2xl border border-border p-4 shadow-sm text-left w-full hover:border-primary/40 hover:shadow-md transition-all">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 overflow-hidden">
          {account.logoUrl
            ? <img src={account.logoUrl} alt="" className="w-full h-full object-contain" />
            : <Landmark className="w-4 h-4" />}
        </div>
        <p className="font-semibold text-sm truncate flex-1 min-w-0">{account.name}</p>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
      <p className="text-xs text-muted-foreground truncate mb-1.5">
        {account.institution ?? 'Loan'}
        {account.lastFour ? ` •••• ${account.lastFour}` : ''}
        {' · '}{account.accountSubtype ?? account.accountType}
      </p>
      <p className="text-2xl font-bold text-card-foreground truncate">{fmtMoney(account.currentBalance, { cents: true })}</p>
      <p className="text-xs text-muted-foreground mt-1">balance owed</p>
    </button>
  );
}

function Sparkline({ data }: { data: BalanceSnapshot[] }) {
  return (
    <div className="w-16 h-7 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="currentBalance" stroke="hsl(var(--primary))" strokeWidth={1.5} fill="url(#spark)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function AccountDetailDialog({ account, transactions, history, onNameChange, onClose }: {
  account: FinanceAccount | null; transactions: FinanceTransaction[]; history: BalanceSnapshot[];
  onNameChange?: (id: string, name: string | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const open = account != null;
  const chartData = history.map((s) => ({ ...s, label: format(parseISO(s.date), 'MMM d') }));
  const [pendingName, setPendingName] = useState<string>('');
  useEffect(() => { setPendingName(account?.name ?? ''); }, [account?.id, account?.name]);
  const trimmedName = pendingName.trim();
  const nameDirty = account != null && trimmedName.length > 0 && trimmedName !== account.name;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col">
        {account && (
          <>
            <DialogHeader className="shrink-0">
              {onNameChange ? (
                <div className="flex items-center gap-2 flex-wrap pr-6">
                  <Input
                    value={pendingName}
                    onChange={(e) => setPendingName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) onNameChange(account.id, trimmedName); }}
                    aria-label="Account name"
                    className="h-8 w-56 font-semibold"
                  />
                  <span className="text-muted-foreground">{account.institution}{account.lastFour ? ` •••• ${account.lastFour}` : ''}</span>
                  <Button size="sm" className="h-8 text-xs" disabled={!nameDirty}
                    onClick={() => onNameChange(account.id, trimmedName)}>
                    Save name
                  </Button>
                  {account.hasNameOverride && (
                    <Button variant="ghost" size="sm" className="h-8 text-xs"
                      onClick={() => onNameChange(account.id, null)}>
                      Reset to automatic
                    </Button>
                  )}
                  <DialogTitle className="sr-only">{account.name} {account.lastFour ? `•••• ${account.lastFour}` : ''}</DialogTitle>
                </div>
              ) : (
                <DialogTitle>
                  {account.name}{' '}
                  <span className="text-muted-foreground font-normal">
                    {account.institution}{account.lastFour ? ` •••• ${account.lastFour}` : ''}
                  </span>
                </DialogTitle>
              )}
            </DialogHeader>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 text-sm shrink-0">
              <Field label="Current Balance">{fmtMoney(account.currentBalance, { cents: true })}</Field>
              <Field label="Available Balance">{fmtMoney(account.availableBalance, { cents: true })}</Field>
              <Field label="Type">{account.accountType}{account.accountSubtype ? ` · ${account.accountSubtype}` : ''}</Field>
              <Field label="Last Updated">{account.updatedAt ? fmtDate(account.updatedAt) : '—'}</Field>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mx-1 px-1">
            {chartData.length > 1 && (
              <div className="mt-2">
                <p className="text-sm font-semibold mb-2">Balance History</p>
                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                      <defs>
                        <linearGradient id="acctFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={56}
                        tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                      <Tooltip formatter={(v: number) => [fmtMoney(Number(v), { cents: true }), 'Balance']}
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
                      <Area type="monotone" dataKey="currentBalance" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#acctFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <TransactionsPanel transactions={transactions} resetKey={account.id} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ActivityBreakdownDialog({ detail, sourceOf, onClose }: {
  detail: { title: string; tone: Tone; calc: string; period: string; txns: FinanceTransaction[] } | null;
  sourceOf: (t: FinanceTransaction) => string;
  onClose: () => void;
}) {
  const open = detail != null;
  // Group transactions by their source (bank/card), each with a subtotal.
  const groups = useMemo(() => {
    if (!detail) return [];
    const m = new Map<string, { source: string; total: number; txns: FinanceTransaction[] }>();
    for (const t of detail.txns) {
      const src = sourceOf(t);
      if (!m.has(src)) m.set(src, { source: src, total: 0, txns: [] });
      const g = m.get(src)!;
      g.total += t.amount; g.txns.push(t);
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total);
  }, [detail, sourceOf]);
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
        {detail && (
          <>
            <DialogHeader>
              <DialogTitle>{detail.title} · <span className="font-normal text-muted-foreground">{detail.period}</span></DialogTitle>
            </DialogHeader>

            {/* Total + how it's calculated */}
            <div className="rounded-xl bg-muted/50 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Total</span>
                <span className={cn('text-2xl font-bold', toneText[detail.tone])}>{fmtMoney(grandTotal, { cents: true })}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">How it's calculated: {detail.calc}</p>
              <p className="text-xs text-muted-foreground">{detail.txns.length} transaction{detail.txns.length === 1 ? '' : 's'} across {groups.length} source{groups.length === 1 ? '' : 's'}.</p>
            </div>

            {/* Per-source groups with subtotals */}
            <div className="space-y-4 mt-1 min-w-0">
              {groups.map((g) => (
                <div key={g.source} className="min-w-0">
                  <div className="flex items-center justify-between gap-2 border-b border-border pb-1 mb-1 min-w-0">
                    <span className="flex items-center gap-2 font-semibold text-sm min-w-0">
                      {g.txns[0]?.creditCardId ? <CardIcon className="w-4 h-4 text-primary shrink-0" /> : <Landmark className="w-4 h-4 text-primary shrink-0" />}
                      <span className="truncate">{g.source}</span>
                      <span className="text-xs text-muted-foreground font-normal shrink-0">({g.txns.length})</span>
                    </span>
                    <span className="font-semibold text-sm shrink-0">{fmtMoney(g.total, { cents: true })}</span>
                  </div>
                  <div className="space-y-0.5">
                    {g.txns.sort((a, b) => (a.date < b.date ? 1 : -1)).map((t) => (
                      <div key={t.id} className="flex items-center justify-between gap-2 text-sm py-0.5 min-w-0">
                        <span className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-xs text-muted-foreground w-12 shrink-0">{format(parseISO(t.date), 'MMM d')}</span>
                          <span className="truncate">{t.description || t.merchantName}</span>
                        </span>
                        <span className="shrink-0 tabular-nums font-medium">{fmtMoney(t.amount, { cents: true })}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {groups.length === 0 && <Empty>No transactions in this period.</Empty>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttentionItem({ onOpen, onDismiss, borderClass, children }: {
  onOpen?: () => void; onDismiss: () => void; borderClass?: string; children: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-center gap-1 rounded-lg bg-card border px-3 py-2', borderClass ?? 'border-border')}>
      {onOpen ? (
        <button onClick={onOpen} className="flex items-center justify-between gap-2 text-left flex-1 min-w-0 hover:opacity-80 transition-opacity">
          {children}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 flex-1 min-w-0">{children}</div>
      )}
      <button onClick={onDismiss} title="Dismiss — reappears when action is next needed"
        className="shrink-0 text-muted-foreground hover:text-foreground rounded p-1 hover:bg-muted">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function Flow({ label, value, icon: Icon, tone, onClick }: {
  label: string; value: number; icon: React.ComponentType<{ className?: string }>; tone: Tone; onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={cn('flex items-center justify-between w-full text-left rounded-lg px-2 py-1 -mx-2',
        onClick && 'hover:bg-muted transition-colors cursor-pointer')}>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className={cn('w-4 h-4', toneText[tone])} />{label}
        {onClick && <ChevronRight className="w-3 h-3 opacity-50" />}
      </span>
      <span className="font-semibold">{fmtMoney(value, { cents: true })}</span>
    </button>
  );
}

function CardTile({ card, adSpend, paidTowardStatement, points, onClick }: { card: FinanceCard; adSpend?: AdSpendStatus; paidTowardStatement: number; points?: number; onClick?: () => void }) {
  const due = resolveDue(card);
  const settled = isSettled(card, paidTowardStatement);
  const risk = interestRisk(card, paidTowardStatement);
  const gradient = cardColorClasses[(card.color as CardColor)] ?? cardColorClasses.navy;
  // A user-set custom hex overrides the auto palette: build a gradient from it
  // (base → a darker shade) via inline style instead of a preset class.
  const customHeaderStyle = card.tileColor
    ? { backgroundImage: `linear-gradient(to right, ${card.tileColor}, color-mix(in srgb, ${card.tileColor} 65%, black))` }
    : undefined;
  const utilization = card.creditLimit > 0 ? Math.min(1, card.currentBalance / card.creditLimit) : null;

  // Amount to pay: the statement balance (what's due for the cycle), with
  // fallbacks for odd synced states.
  const payAmount = (card.lastStatementBalance && card.lastStatementBalance > 0.005)
    ? card.lastStatementBalance
    : (card.currentBalance || card.minimumPayment || card.totalBalance);

  // One status strip per tile: do I need to act, how much, by when.
  let strip: { tone: Tone; icon: React.ComponentType<{ className?: string }>; text: string; subtext?: string };
  const stmtBal = card.lastStatementBalance ?? 0;
  const notRequired = /not required|no payment|don'?t have a payment|paid in full|nothing due/i.test(card.paymentStatus ?? '');
  const forceDue = unpaidStatementDueWithin(card, paidTowardStatement, 15);
  // How much of the statement is already covered, so we can show progress and
  // bill only the remainder. Precise matching needs the statement close date;
  // when Plaid omits it, fall back to (statement − current balance) so a payment
  // still shows up. Clamped to [0, statement].
  const paidOnStmt = stmtBal > 0.005
    ? Math.min(stmtBal, Math.max(paidTowardStatement, Math.max(0, stmtBal - card.currentBalance)))
    : 0;
  const remainingOnStmt = Math.max(0, Math.round((stmtBal - paidOnStmt) * 100) / 100);
  const partiallyPaid = paidOnStmt > 0.005 && remainingOnStmt > 0.005;
  // Bill the uncovered remainder (falls back to payAmount when no statement).
  const dueAmount = stmtBal > 0.005 ? remainingOnStmt : payAmount;
  const paidSubtext = partiallyPaid ? `Paid ${fmtMoney(paidOnStmt)} of ${fmtMoney(stmtBal)} statement` : undefined;
  if (card.isOverdue) {
    strip = { tone: 'danger', icon: AlertTriangle, text: `Overdue — pay ${fmtMoney(dueAmount, { cents: true })} now`, subtext: paidSubtext };
  } else if (forceDue) {
    // Statement unpaid and due within 7 days — surface it even if the issuer
    // reports "not required" (stale / autopay).
    const when = forceDue.days <= 0 ? 'due today' : forceDue.days === 1 ? 'in 1 day' : `in ${forceDue.days} days`;
    strip = {
      tone: forceDue.days <= 3 ? 'danger' : 'warning',
      icon: forceDue.days <= 3 ? AlertTriangle : CalendarClock,
      text: `Pay ${fmtMoney(dueAmount, { cents: true })} by ${format(forceDue.date, 'MMM d')} · ${when}`,
      subtext: paidSubtext,
    };
  } else if (settled) {
    const statementPaid = stmtBal > 0.005 && (paidTowardStatement + DUE_EPSILON) >= stmtBal;
    if (statementPaid) {
      // Statement was paid — show it as paid, not as an amount due.
      strip = {
        tone: 'success', icon: CheckCircle2,
        text: `Statement ${fmtMoney(stmtBal, { cents: true })} · paid`,
        subtext: 'Payment not required at this time',
      };
    } else if (due && stmtBal > 0.005) {
      // Not covered yet, but the issuer says not required — surface the upcoming due date.
      strip = {
        tone: 'success', icon: CheckCircle2,
        text: `Statement ${fmtMoney(stmtBal, { cents: true })} · due ${format(due.date, 'MMM d')}`,
        subtext: 'Payment not required at this time',
      };
    } else {
      strip = { tone: 'success', icon: CheckCircle2, text: notRequired ? 'Payment not required at this time' : 'Nothing due' };
    }
  } else if (due) {
    const when = due.days <= 0 ? 'due today' : due.days === 1 ? 'in 1 day' : `in ${due.days} days`;
    strip = {
      tone: due.days <= 3 ? 'danger' : due.days <= 7 ? 'warning' : 'muted',
      icon: due.days <= 3 ? AlertTriangle : CalendarClock,
      text: `Pay ${fmtMoney(dueAmount, { cents: true })} by ${format(due.date, 'MMM d')} · ${when}`,
      subtext: paidSubtext,
    };
  } else {
    strip = { tone: 'muted', icon: CalendarClock, text: 'No due date on file' };
  }

  const footerBits = [
    card.lastStatementDate ? `Closed ${format(parseISO(card.lastStatementDate), 'MMM d')}` : null,
    card.lastPaymentAmount != null
      ? `Paid ${fmtMoney(card.lastPaymentAmount)}${card.lastPaymentDate ? ` on ${format(parseISO(card.lastPaymentDate), 'MMM d')}` : ''}`
      : null,
  ].filter(Boolean);

  return (
    <button type="button" onClick={onClick}
      className={cn(
        'bg-card rounded-2xl border border-border overflow-hidden shadow-sm flex flex-col text-left hover:border-primary/40 hover:shadow-md transition-all',
        card.isOverdue && 'ring-1 ring-destructive/40',
      )}>
      {/* Identity header — name, digits, company. Status lives in the strip below. */}
      <div className={cn('px-4 py-2.5 text-white flex items-start justify-between gap-2', !card.tileColor && 'bg-gradient-to-r', !card.tileColor && gradient)} style={customHeaderStyle}>
        <div className="min-w-0">
          <p className="font-semibold leading-tight truncate">{card.name}</p>
          <p className="text-xs text-white/80 truncate">
            {card.lastFour ? `•••• ${card.lastFour}` : ''}{card.companyName ? ` · ${card.companyName}` : ''}
          </p>
          {card.ownerName && <p className="text-xs text-white/70 truncate">{card.ownerName}</p>}
        </div>
        <div className="flex items-start gap-2 shrink-0">
          {points != null && (
            <div className="text-right leading-tight">
              <p className="text-sm font-bold flex items-center gap-1 justify-end">
                <Trophy className="w-3.5 h-3.5" />{points.toLocaleString('en-US')}
              </p>
              <p className="text-[10px] text-white/80 uppercase tracking-wide">points</p>
            </div>
          )}
          {card.logoUrl && (
            <div className="w-8 h-8 rounded-md bg-white/90 flex items-center justify-center overflow-hidden shrink-0">
              <img src={card.logoUrl} alt="" className="w-full h-full object-contain p-0.5" />
            </div>
          )}
        </div>
      </div>

      {/* Status strip — tinted by state so overdue vs paid reads at a glance */}
      <div className={cn('px-4 py-2 text-sm font-medium flex flex-col gap-1', toneBg[strip.tone])}>
        <span className="flex items-center gap-1.5 min-w-0">
          <strip.icon className="w-4 h-4 shrink-0" />
          <span className="truncate">{strip.text}</span>
        </span>
        {strip.subtext && <span className="text-xs font-normal opacity-90 pl-[22px] truncate">{strip.subtext}</span>}
        {risk && (
          <span className="flex items-center gap-1.5 text-xs text-destructive min-w-0">
            <Percent className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Underpaid — {fmtMoney(risk.remaining)} accruing interest</span>
          </span>
        )}
      </div>

      {/* Body — one hero number, then standing */}
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div>
          {!settled && stmtBal > 0.005 ? (
            <>
              {/* Lead with what must actually be paid. When the statement is
                  partly paid, that's the remaining amount, with the paid portion
                  shown underneath; otherwise the full statement balance. */}
              <p className="text-xs text-muted-foreground">{partiallyPaid ? 'Statement balance remaining' : 'Statement balance due'}</p>
              <p className="text-2xl font-bold text-card-foreground">{fmtMoney(partiallyPaid ? remainingOnStmt : stmtBal, { cents: true })}</p>
              {partiallyPaid ? (
                <p className="text-xs text-muted-foreground mt-0.5">Paid {fmtMoney(paidOnStmt)} of {fmtMoney(stmtBal)} · total balance {fmtMoney(card.currentBalance)}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">Total balance {fmtMoney(card.currentBalance, { cents: true })}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Balance</p>
              <p className="text-2xl font-bold text-card-foreground">{fmtMoney(card.currentBalance, { cents: true })}</p>
            </>
          )}
        </div>

        {utilization != null && (
          <div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className={cn('h-full rounded-full',
                utilization >= 0.9 ? 'bg-destructive' : utilization >= 0.5 ? 'bg-warning' : 'bg-success')}
                style={{ width: `${Math.max(2, utilization * 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {Math.round(utilization * 100)}% of {fmtMoney(card.creditLimit)} limit
            </p>
          </div>
        )}

        {/* Annual ad-spend budget (only cards with a configured cap).
            Deliberately a different form than the utilization bar above:
            10 discrete blocks ($15k each), divider-separated, "left" framing —
            so the two meters can't be confused at a glance. */}
        {adSpend && (
          <div className="border-t border-border pt-2.5">
            <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
              <span className="flex items-center gap-1 text-muted-foreground min-w-0">
                <Megaphone className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  Ad spend {Math.round(adSpend.fraction * 100)}% of {fmtCompact(adSpend.limit)}
                </span>
              </span>
              <span className={cn('font-semibold whitespace-nowrap',
                adSpend.fraction >= 1 ? 'text-destructive'
                  : adSpend.fraction >= 0.8 ? 'text-warning' : 'text-muted-foreground')}>
                {adSpend.fraction >= 1
                  ? `${fmtCompact(adSpend.spent - adSpend.limit)} over`
                  : `${fmtCompact(adSpend.limit - adSpend.spent)} left`}
              </span>
            </div>
            <div className="flex gap-0.5">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className={cn('h-1.5 flex-1 rounded-sm',
                  i < Math.min(10, Math.max(adSpend.fraction > 0 ? 1 : 0, Math.round(adSpend.fraction * 10)))
                    ? (adSpend.fraction >= 0.9 ? 'bg-destructive' : adSpend.fraction >= 0.8 ? 'bg-warning' : 'bg-primary')
                    : 'bg-muted')} />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <p className="text-xs text-muted-foreground truncate">{footerBits.join(' · ')}</p>
          <span className="flex items-center gap-1 text-xs text-primary shrink-0">
            View activity <ChevronRight className="w-3 h-3" />
          </span>
        </div>
      </div>
    </button>
  );
}

type SpendPoint = { key: string; label: string; total: number; partial: boolean };

function SpendTooltip({ active, payload }: { active?: boolean; payload?: { payload: SpendPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-card-foreground">{p.label}{p.partial ? ' (so far)' : ''}</p>
      <p className="text-muted-foreground">{fmtMoney(p.total, { cents: true })} spent</p>
    </div>
  );
}

type CategorySlice = { key: string; label: string; amount: number; color: string; pct: number };

// Spending-by-category donut: magnitude-by-identity, so a validated categorical
// palette (fixed order, 8 hues + a neutral "Everything else"). The ranked legend
// beside it carries each label + $ + %, so identity never rests on color alone.
// Selecting a slice dims the rest and drills into its transactions. Drawn as plain
// SVG arcs (stroke-dasharray on concentric circles) — no chart lib, no extra deps.
function CategoryDonut({ data, total, selected, onSelect }: {
  data: CategorySlice[]; total: number; selected: string | null; onSelect: (key: string) => void;
}) {
  const size = 240, stroke = 34, r = (size - stroke) / 2, c = size / 2;
  const circ = 2 * Math.PI * r;
  const gap = data.length > 1 ? 2 : 0; // 2px surface gap between adjacent arcs
  let acc = 0; // cumulative fraction, drawn clockwise from 12 o'clock
  const arcs = data.map((s) => {
    const len = Math.max(0, s.pct * circ - gap);
    const seg = { s, dasharray: `${len} ${circ - len}`, dashoffset: -acc * circ };
    acc += s.pct;
    return seg;
  });
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Spending by category">
        <g transform={`rotate(-90 ${c} ${c})`}>
          {arcs.map(({ s, dasharray, dashoffset }) => (
            <circle key={s.key} cx={c} cy={c} r={r} fill="none"
              stroke={s.color} strokeWidth={stroke}
              strokeDasharray={dasharray} strokeDashoffset={dashoffset}
              opacity={selected && selected !== s.key ? 0.3 : 1}
              style={{ cursor: 'pointer', transition: 'opacity .15s' }}
              onClick={() => onSelect(s.key)}>
              <title>{s.label}: {fmtMoney(s.amount, { cents: true })} ({(s.pct * 100).toFixed(1)}%)</title>
            </circle>
          ))}
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-bold tabular-nums leading-none">{fmtMoney(total)}</span>
        <span className="text-xs text-muted-foreground mt-1">Total</span>
      </div>
    </div>
  );
}

// Month-over-month spending line. Single series (primary blue) with a soft area
// wash, a dashed average reference line, a crosshair tooltip, and the in-progress
// month drawn as a hollow endpoint so a partial month isn't mistaken for a dip.
function MonthlySpendChart({ data, average, onSelectMonth }: { data: SpendPoint[]; average: number; onSelectMonth?: (key: string) => void }) {
  const lastIdx = data.length - 1;
  const handleClick = (state: { activePayload?: { payload: SpendPoint }[] }) => {
    const p = state?.activePayload?.[0]?.payload;
    if (p) onSelectMonth?.(p.key);
  };
  return (
    <div className="h-60 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 0 }}
          onClick={onSelectMonth ? handleClick : undefined}
          style={onSelectMonth ? { cursor: 'pointer' } : undefined}>
          <defs>
            <linearGradient id="spendWash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.14} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false} tickLine={false} minTickGap={8} />
          <YAxis tickFormatter={(v) => fmtCompact(Number(v))} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false} tickLine={false} width={46} />
          {average > 0 && (
            <ReferenceLine y={average} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeOpacity={0.7}
              label={{ value: `avg ${fmtCompact(average)}`, position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
          )}
          <Tooltip content={<SpendTooltip />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeDasharray: '3 3' }} />
          {/* Soft fill under the line for depth (area look, line emphasis). */}
          <Area type="monotone" dataKey="total" stroke="none" fill="url(#spendWash)" isAnimationActive={false} />
          <Line type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2.5}
            dot={(props: { cx?: number; cy?: number; index?: number }) => {
              const { cx, cy, index } = props;
              if (cx == null || cy == null) return <g />;
              const partial = index === lastIdx && data[lastIdx]?.partial;
              return (
                <circle key={index} cx={cx} cy={cy} r={partial ? 4 : 3}
                  fill={partial ? 'hsl(var(--card))' : 'hsl(var(--primary))'}
                  stroke="hsl(var(--primary))" strokeWidth={2} />
              );
            }}
            activeDot={{ r: 5 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function CashProjectionChart({ data, lowest }: { data: ForecastPoint[]; lowest: ForecastPoint | null }) {
  const chartData = data.map((p) => ({ ...p, label: format(parseISO(p.date), 'MMM d') }));
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))"
            interval="preserveStartEnd" minTickGap={28} />
          <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={64}
            tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
          <Tooltip
            formatter={(v: number) => [fmtMoney(Number(v), { cents: true }), 'Projected balance']}
            labelStyle={{ color: 'hsl(var(--foreground))' }}
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
          <Area type="monotone" dataKey="projectedBalance" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#cashFill)" />
          {lowest && (
            <ReferenceDot x={format(parseISO(lowest.date), 'MMM d')} y={lowest.projectedBalance}
              r={4} fill="hsl(var(--destructive))" stroke="hsl(var(--card))" strokeWidth={2} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function isoDaysAgo(days: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function isoMonthStart(): string {
  const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function isoYearStart(): string {
  return new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
}

type Flow = 'all' | 'in' | 'out' | 'ads';
const isMoneyIn = (t: FinanceTransaction) => t.type === 'income' || t.type === 'refund';
const isMoneyOut = (t: FinanceTransaction) => t.type === 'expense' || t.type === 'payment' || t.type === 'fee';

function TransactionsPanel({ transactions, resetKey, showAdsFilter }: {
  transactions: FinanceTransaction[]; resetKey: string; showAdsFilter?: boolean;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [flow, setFlow] = useState<Flow>('all');
  useEffect(() => { setFrom(''); setTo(''); setFlow('all'); }, [resetKey]);

  const filtered = useMemo(
    () => transactions.filter((t) =>
      (!from || t.date >= from) && (!to || t.date <= to) &&
      (flow === 'all' || (flow === 'ads' ? isAdTransaction(t)
        : flow === 'in' ? isMoneyIn(t) : isMoneyOut(t)))),
    [transactions, from, to, flow],
  );
  const totalIn = filtered.filter(isMoneyIn).reduce((s, t) => s + t.amount, 0);
  const totalOut = filtered.filter(isMoneyOut).reduce((s, t) => s + t.amount, 0);
  const preset = (f: string, t = '') => { setFrom(f); setTo(t); };

  return (
    <div className="mt-2 min-w-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-semibold">Activity</p>
        <span className="text-xs text-muted-foreground">
          {filtered.length} of {transactions.length}
          {totalIn > 0 && <span className="text-success"> · +{fmtMoney(totalIn)}</span>}
          {totalOut > 0 && <span> · −{fmtMoney(totalOut)}</span>}
        </span>
      </div>

      {/* Money In / Money Out filter */}
      <div className="flex items-center gap-1 mb-2">
        <RangeChip onClick={() => setFlow('all')} active={flow === 'all'}>All</RangeChip>
        <RangeChip onClick={() => setFlow('in')} active={flow === 'in'}>Money In</RangeChip>
        <RangeChip onClick={() => setFlow('out')} active={flow === 'out'}>Money Out</RangeChip>
        {showAdsFilter && <RangeChip onClick={() => setFlow('ads')} active={flow === 'ads'}>Ads</RangeChip>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
        <div className="flex items-center gap-1 ml-auto">
          <RangeChip onClick={() => preset(isoDaysAgo(30))} active={from === isoDaysAgo(30) && !to}>30d</RangeChip>
          <RangeChip onClick={() => preset(isoDaysAgo(90))} active={from === isoDaysAgo(90) && !to}>90d</RangeChip>
          <RangeChip onClick={() => preset(isoMonthStart())} active={from === isoMonthStart() && !to}>Month</RangeChip>
          <RangeChip onClick={() => preset('', '')} active={!from && !to}>All</RangeChip>
        </div>
      </div>
      {transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No transactions synced yet.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No transactions in this date range.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {filtered.map((t) => <TxnRow key={t.id} txn={t} />)}
        </div>
      )}
    </div>
  );
}

function CardDetailDialog({ card, adSpend, transactions, onColorChange, onNameChange, onClose }: {
  card: FinanceCard | null; adSpend?: AdSpendStatus; transactions: FinanceTransaction[];
  onColorChange?: (id: string, color: string | null) => void | Promise<void>;
  onNameChange?: (id: string, name: string | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const open = card != null;
  const due = card ? resolveDue(card) : null;
  const [pendingColor, setPendingColor] = useState<string>('#1e3a8a');
  useEffect(() => { setPendingColor(card?.tileColor ?? '#1e3a8a'); }, [card?.id, card?.tileColor]);
  const colorDirty = card != null && (card.tileColor ?? null) !== pendingColor;
  const [pendingName, setPendingName] = useState<string>('');
  useEffect(() => { setPendingName(card?.name ?? ''); }, [card?.id, card?.name]);
  const trimmedName = pendingName.trim();
  const nameDirty = card != null && trimmedName.length > 0 && trimmedName !== card.name;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col">
        {card && (
          <>
            <DialogHeader className="shrink-0">
              {onNameChange ? (
                <div className="flex items-center gap-2 flex-wrap pr-6">
                  <Input
                    value={pendingName}
                    onChange={(e) => setPendingName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) onNameChange(card.id, trimmedName); }}
                    aria-label="Card name"
                    className="h-8 w-56 font-semibold"
                  />
                  <span className="text-muted-foreground">•••• {card.lastFour}</span>
                  <Button size="sm" className="h-8 text-xs" disabled={!nameDirty}
                    onClick={() => onNameChange(card.id, trimmedName)}>
                    Save name
                  </Button>
                  {card.hasNameOverride && (
                    <Button variant="ghost" size="sm" className="h-8 text-xs"
                      onClick={() => onNameChange(card.id, null)}>
                      Reset to automatic
                    </Button>
                  )}
                  {/* Keep a title for accessibility/screen readers */}
                  <DialogTitle className="sr-only">{card.name} •••• {card.lastFour}</DialogTitle>
                </div>
              ) : (
                <DialogTitle>{card.name} <span className="text-muted-foreground font-normal">•••• {card.lastFour}</span></DialogTitle>
              )}
            </DialogHeader>
            {onColorChange && (
              <div className="flex items-center gap-3 shrink-0 -mt-1 flex-wrap">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Tile color</span>
                {/* Live preview of the header gradient at the chosen color */}
                <div className="h-7 w-20 rounded-md border border-border shrink-0"
                  style={{ backgroundImage: `linear-gradient(to right, ${pendingColor}, color-mix(in srgb, ${pendingColor} 65%, black))` }} />
                <label className="relative w-7 h-7 rounded-md border border-border overflow-hidden cursor-pointer shrink-0">
                  <input
                    type="color"
                    value={pendingColor}
                    onChange={(e) => setPendingColor(e.target.value)}
                    className="absolute inset-0 w-[150%] h-[150%] -left-1/4 -top-1/4 cursor-pointer"
                    title="Pick a custom tile color"
                  />
                </label>
                <Button size="sm" className="h-7 text-xs" disabled={!colorDirty}
                  onClick={() => onColorChange(card.id, pendingColor)}>
                  Save color
                </Button>
                {card.tileColor && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => onColorChange(card.id, null)}>
                    Reset to automatic
                  </Button>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-4 text-sm shrink-0">
              <Field label="Current Balance (owed now)">{fmtMoney(card.currentBalance, { cents: true })}</Field>
              <Field label="Last Statement">
                {card.lastStatementBalance != null ? fmtMoney(card.lastStatementBalance, { cents: true }) : '—'}
                {(card.lastStatementBalance ?? 0) > 0.005 && isSettled(card) && <span className="text-success font-normal"> · paid</span>}
              </Field>
              <Field label="Credit Limit">{card.creditLimit ? fmtMoney(card.creditLimit) : '—'}</Field>
              <Field label="Minimum Payment">{card.minimumPayment ? fmtMoney(card.minimumPayment) : '—'}</Field>
              <Field label="Statement Closes">{card.lastStatementDate ? fmtDate(card.lastStatementDate) : card.statementDay ? `Day ${card.statementDay}` : '—'}</Field>
              <Field label="Payment Due">{due ? fmtDate(due.date.toISOString()) : card.dueDay ? `Day ${card.dueDay}` : '—'}</Field>
              <Field label="Last Payment">{card.lastPaymentAmount != null ? fmtMoney(card.lastPaymentAmount) : '—'}</Field>
              <Field label="Paid On">{card.lastPaymentDate ? fmtDate(card.lastPaymentDate) : '—'}</Field>
              <Field label="Purchase APR">{card.purchaseApr ? `${card.purchaseApr}%` : '—'}</Field>
              <Field label="Company">{card.companyName ?? '—'}</Field>
              {adSpend && (
                <>
                  <Field label={`Ad Spend (${adSpend.year})`}>
                    {fmtMoney(adSpend.spent, { cents: true })}
                    <span className="text-muted-foreground font-normal"> · {Math.round(adSpend.fraction * 100)}% of {fmtMoney(adSpend.limit)} cap</span>
                  </Field>
                  <Field label="Projected by Dec 31">
                    <span className={adSpend.projected > adSpend.limit ? 'text-destructive' : undefined}>
                      {fmtMoney(adSpend.projected)}
                    </span>
                  </Field>
                </>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mx-1 px-1">
              <TransactionsPanel transactions={transactions} resetKey={card.id} showAdsFilter={adSpend != null} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Compact area sparkline for the hero. Scales to the series' own min/max, draws a
// 2px line + soft gradient fill + an endpoint dot. Non-interactive by design (a
// small summary spark); the exact history lives in the per-account dialog.
function HeroSparkline({ values, ariaLabel }: { values: number[]; ariaLabel?: string }) {
  if (values.length < 2) return null;
  const W = 240, H = 48, pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
      role="img" aria-label={ariaLabel} className="text-primary overflow-visible">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkFill)" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r="3" fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RangeChip({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('px-2 h-7 rounded-md text-xs font-medium border transition-colors',
        active ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium text-card-foreground">{children}</p>
    </div>
  );
}

// Detect a bill-pay processor (Melio/Bill.com/Plastiq) mentioned in the data, so
// we can show "via Melio" — since on the card statement these show as the
// processor, not the payee.
function paymentProcessor(t: FinanceTransaction): string | null {
  const s = `${t.merchantName ?? ''} ${t.description ?? ''}`.toLowerCase();
  if (/\bmelio\b/.test(s)) return 'Melio';
  if (/bill\.?com/.test(s)) return 'Bill.com';
  if (/plastiq/.test(s)) return 'Plastiq';
  return null;
}

// Given the raw name and the processor, strip the processor noise to reveal the
// underlying payee, and decide whether to show the "via <proc>" tag.
function payeeAndVia(rawName: string, proc: string | null): { name: string; showVia: boolean } {
  if (!proc) return { name: rawName, showVia: false };
  const p = proc.replace('.', '\\.');
  const cleaned = rawName
    .replace(new RegExp(`\\s*\\bvia\\s+${p}\\b\\s*`, 'ig'), ' ')
    .replace(new RegExp(`^\\s*${p}\\s+payment\\s+to\\s+`, 'i'), '')
    .replace(new RegExp(`^\\s*${p}\\s*[-*:]\\s*`, 'i'), '')
    .replace(new RegExp(`${p}\\s*\\*\\s*`, 'ig'), '')
    .replace(new RegExp(`\\b${p}\\b`, 'ig'), '')
    .replace(/[*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // No real payee left (it was just "Melio"/"Melio Payment") — keep it as a plain
  // processor payment, no redundant tag.
  if (!cleaned || /^payment$/i.test(cleaned)) return { name: `${proc} Payment`, showVia: false };
  return { name: cleaned, showVia: true };
}

function TxnRow({ txn, source, isNew, tag, onSetTag, tagOptions = ['personal', 'property', 'business'] }: {
  txn: FinanceTransaction; source?: string | null; isNew?: boolean;
  tag?: TxnTag; onSetTag?: (tag: TxnTag) => void; tagOptions?: TxnTag[];
}) {
  // Money coming in: deposits, refunds, and incoming transfers (Zelle/bank in).
  const inflow = txn.type === 'income' || txn.type === 'refund'
    || (txn.type === 'transfer' && (txn.category ?? '').startsWith('transfer_in'));
  const isPayment = txn.type === 'payment';
  // Show the raw description exactly as the bank/Amex statement does — no stripping.
  const name = txn.description || txn.merchantName;
  const proc = paymentProcessor(txn);
  // Only add a "via Melio" tag when the name doesn't already show the processor.
  const showVia = proc != null && !name.toLowerCase().includes(proc.toLowerCase());
  return (
    <div className="flex items-center justify-between gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-muted/60 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
          inflow ? 'bg-success/10 text-success' : isPayment ? 'bg-muted text-muted-foreground' : 'bg-warning/10 text-warning')}>
          {inflow ? <ArrowDownRight className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate leading-tight">
            {name}
            {isNew && <span className="ml-2 text-[11px] font-semibold align-middle rounded-full bg-success text-success-foreground px-2 py-0.5 whitespace-nowrap">new</span>}
            {txn.isPending && <span className="ml-2 text-[11px] font-semibold align-middle rounded-full bg-warning/15 text-warning border border-warning/30 px-2 py-0.5 whitespace-nowrap">pending</span>}
            {showVia && <span className="ml-2 text-[11px] font-semibold align-middle rounded-full bg-primary text-primary-foreground border border-primary px-2 py-0.5 whitespace-nowrap">via {proc}</span>}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {format(parseISO(txn.date), 'MMM d, yyyy')}
            {source ? ` · ${source}` : ''}
            {txn.category ? ` · ${txn.category}` : ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onSetTag && (
          <div className="inline-flex rounded-full border border-border overflow-hidden text-[10px] font-semibold shrink-0"
            title="Tag this payee — applies to all its charges, past & future">
            {tagOptions.map((opt, i) => (
              <button key={opt} type="button" onClick={(e) => { e.stopPropagation(); onSetTag(opt); }}
                className={cn('px-2 py-0.5 transition-colors capitalize', i > 0 && 'border-l border-border',
                  tag === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {opt}
              </button>
            ))}
          </div>
        )}
        <span className={cn('font-semibold tabular-nums text-right whitespace-nowrap', inflow ? 'text-success' : 'text-foreground')}>
          {inflow ? '+' : isPayment ? '' : '−'}{fmtMoney(txn.amount, { cents: true })}
        </span>
      </div>
    </div>
  );
}

export default Dashboard;
