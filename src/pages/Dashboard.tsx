import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { format, parseISO, differenceInCalendarDays } from 'date-fns';
import { useAuth } from '@/contexts/AuthContext';
import { useFinanceData, FinanceAccount, FinanceCard, FinanceTransaction, FinanceAlert, ForecastPoint, BalanceSnapshot } from '@/hooks/useFinanceData';
import { getNextOccurrence } from '@/utils/dateUtils';
import { adSpendLimitFor, computeAdSpend, isAdTransaction, AdSpendStatus } from '@/utils/adSpend';
import { cardColorClasses, CardColor } from '@/types/creditCard';
import { UserMenu } from '@/components/UserMenu';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceDot } from 'recharts';
import {
  Wallet, LayoutDashboard, CreditCard as CardIcon, Trophy, Loader2, Building2,
  ArrowDownRight, ArrowUpRight, Landmark, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle2, CalendarClock, RefreshCw, Bell, ChevronRight, Percent, Megaphone,
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

// A card has nothing due when the sync says so (payment_status / zero minimum)
// or the statement balance is cleared — even if a running balance remains.
function isSettled(card: FinanceCard): boolean {
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
  // Statement fully covered: a payment on/after the statement date that meets or
  // exceeds the statement balance means the statement is paid, and any remaining
  // balance is next-cycle spending — nothing is due now.
  if (
    (card.lastStatementBalance ?? 0) > 0.005 &&
    card.lastPaymentAmount != null &&
    card.lastPaymentDate != null &&
    card.lastStatementDate != null &&
    card.lastPaymentAmount + 0.005 >= card.lastStatementBalance! &&
    card.lastPaymentDate >= card.lastStatementDate
  ) return true;
  return false;
}

// Interest risk: a payment was made toward the last statement, but it was less
// than the statement balance — so the unpaid remainder will accrue interest.
// Returns the shortfall details, or null if the statement was paid in full /
// nothing is owed / no payment has yet been applied to this statement.
function interestRisk(card: FinanceCard): { paid: number; statement: number; remaining: number } | null {
  if (isSettled(card)) return null;
  const stmt = card.lastStatementBalance ?? 0;
  if (stmt <= 0.005) return null;
  if (card.lastPaymentAmount == null || !card.lastPaymentDate || !card.lastStatementDate) return null;
  // Only count a payment that applies to this statement (made on/after it closed).
  if (card.lastPaymentDate < card.lastStatementDate) return null;
  const paid = card.lastPaymentAmount;
  if (paid + 0.005 >= stmt) return null; // fully covered
  if (paid <= 0.005) return null; // no payment applied — that's a "due" case, not underpayment
  return { paid, statement: stmt, remaining: stmt - paid };
}

// Lower rank = more urgent (sorts first). Overdue < due-soon (by days) < settled.
function urgencyRank(card: FinanceCard): number {
  if (card.isOverdue) return -100000;
  if (isSettled(card)) return 100000;
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
  return card.creditLimit > 0 ? card.totalBalance / card.creditLimit : -1;
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

function compareCards(a: FinanceCard, b: FinanceCard, sort: CardSort): number {
  switch (sort) {
    case 'due': {
      const da = resolveDue(a)?.days ?? 999999;
      const db = resolveDue(b)?.days ?? 999999;
      return da - db;
    }
    case 'closing': return nextClosingDays(a) - nextClosingDays(b);
    case 'balance': return b.totalBalance - a.totalBalance;
    case 'limit': return b.creditLimit - a.creditLimit;
    case 'utilization': return utilization(b) - utilization(a);
    case 'name': return a.name.localeCompare(b.name);
    default: return urgencyRank(a) - urgencyRank(b);
  }
}

const Dashboard = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { accounts, transactions, cards, alerts, forecast, snapshots, loading, lastSyncedAt } = useFinanceData();
  const [company, setCompany] = useState('all');
  const [selectedCard, setSelectedCard] = useState<FinanceCard | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<FinanceAccount | null>(null);
  const [activityPeriod, setActivityPeriod] = useState<'month' | '30d' | '90d' | 'all'>('month');
  const [cardSort, setCardSort] = useState<CardSort>('urgency');
  const [activityDetail, setActivityDetail] = useState<null | 'income' | 'spend' | 'payments'>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const companies = useMemo(
    () => Array.from(new Set([
      ...cards.map((c) => c.companyName),
      ...accounts.map((a) => a.company),
    ].filter(Boolean))).sort() as string[],
    [cards, accounts],
  );

  const visibleCards = useMemo(() => {
    const filtered = company === 'all' ? cards : cards.filter((c) => c.companyName === company);
    return [...filtered].sort((a, b) => compareCards(a, b, cardSort));
  }, [cards, company, cardSort]);

  const depository = useMemo(
    () => accounts
      .filter((a) => a.accountType === 'checking' || a.accountType === 'savings')
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

  // ── Top-line numbers ────────────────────────────────────────────────
  const availableCash = depository.reduce((s, a) => s + a.currentBalance, 0);
  const totalCardDebt = visibleCards.reduce((s, c) => s + c.totalBalance, 0);
  const statementDue = visibleCards.reduce((s, c) => s + c.currentBalance, 0);
  const creditAvailable = visibleCards.reduce(
    (s, c) => s + Math.max(0, c.creditLimit - c.totalBalance), 0,
  );

  const dueSoon = useMemo(() => {
    return visibleCards
      .map((c) => ({ card: c, due: resolveDue(c) }))
      .filter((x) => x.due && x.due.days >= 0 && x.due.days <= 7 && !isSettled(x.card))
      .sort((a, b) => (a.due!.days - b.due!.days));
  }, [visibleCards]);
  const dueSoonTotal = dueSoon.reduce((s, x) => s + x.card.currentBalance, 0);

  // ── Activity roll-up, scoped to a selected period ──────────────────
  const activityFrom = activityPeriod === 'month' ? isoMonthStart()
    : activityPeriod === '30d' ? isoDaysAgo(30)
    : activityPeriod === '90d' ? isoDaysAgo(90) : '';
  const activityTxns = useMemo(
    () => brandTxns.filter((t) => !activityFrom || t.date >= activityFrom),
    [brandTxns, activityFrom],
  );
  // Income counts deposits + refunds; spending counts purchases + fees.
  const income = activityTxns.filter((t) => t.type === 'income' || t.type === 'refund').reduce((s, t) => s + t.amount, 0);
  const spend = activityTxns.filter((t) => t.type === 'expense' || t.type === 'fee').reduce((s, t) => s + t.amount, 0);
  // Card payments are recorded twice — once as the bank outflow (account_id, no
  // card) and once on the card that received it (credit_card_id). Count only the
  // bank-side outflow to avoid double-counting the same payment.
  const payments = activityTxns.filter((t) => t.type === 'payment' && !t.creditCardId);
  const paymentsTotal = payments.reduce((s, t) => s + t.amount, 0);

  const cardName = (id: string | null) =>
    cards.find((c) => c.id === id)?.name ?? null;

  // Which bank/card a transaction came from (for the breakdown view).
  const sourceOf = (t: FinanceTransaction): string => {
    if (t.creditCardId) return cards.find((c) => c.id === t.creditCardId)?.name ?? 'Card';
    if (t.accountId) return accounts.find((a) => a.id === t.accountId)?.name ?? 'Account';
    return 'Unlinked';
  };

  const periodLabel = activityPeriod === 'month' ? 'This month'
    : activityPeriod === '30d' ? 'Last 30 days'
    : activityPeriod === '90d' ? 'Last 90 days' : 'All time';

  const activityBreakdown = useMemo(() => {
    if (!activityDetail) return null;
    const cfg = {
      income: { title: 'Income', tone: 'success' as Tone, calc: 'Deposits and refunds (money in)',
        txns: activityTxns.filter((t) => t.type === 'income' || t.type === 'refund') },
      spend: { title: 'Spending', tone: 'warning' as Tone, calc: 'Purchases and fees (money out) — excludes card payments & transfers',
        txns: activityTxns.filter((t) => t.type === 'expense' || t.type === 'fee') },
      payments: { title: 'Card Payments', tone: 'muted' as Tone, calc: 'Cash paid from bank accounts toward cards (each payment counted once)',
        txns: payments },
    }[activityDetail];
    return { ...cfg, period: periodLabel };
  }, [activityDetail, activityTxns, payments, periodLabel]);

  // Cards needing attention: overdue, or due within 7 days with a balance owed.
  const attentionCards = useMemo(
    () => visibleCards
      .filter((c) => c.isOverdue || (() => { const d = resolveDue(c); return d && d.days <= 7 && !isSettled(c); })())
      .sort((a, b) => urgencyRank(a) - urgencyRank(b)),
    [visibleCards],
  );
  const openAlerts = useMemo(
    () => alerts.filter((a) => (a.status ?? 'open').toLowerCase() !== 'resolved'),
    [alerts],
  );

  // Cards where the statement was underpaid → interest will accrue.
  const interestRiskCards = useMemo(
    () => visibleCards.map((c) => ({ card: c, risk: interestRisk(c) })).filter((x) => x.risk != null),
    [visibleCards],
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

  // Forecast: lowest projected balance point over the horizon.
  const lowestPoint = useMemo(() => {
    if (forecast.length === 0) return null;
    return forecast.reduce((min, p) => (p.projectedBalance < min.projectedBalance ? p : min), forecast[0]);
  }, [forecast]);
  const endPoint = forecast.length ? forecast[forecast.length - 1] : null;

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
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
              <h1 className="text-xl font-bold text-foreground">CardTrack</h1>
              <p className="text-xs text-muted-foreground">Cash &amp; card overview</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" asChild>
              <Link to="/dashboard"><LayoutDashboard className="w-4 h-4 mr-1" />Dashboard</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/points"><Trophy className="w-4 h-4 mr-1" />Points</Link>
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/cards"><CardIcon className="w-4 h-4 mr-1" />Old Dashboard</Link>
            </Button>
            <UserMenu userEmail={user?.email || ''} onSignOut={async () => { await signOut(); navigate('/auth'); }} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Financial Dashboard</h2>
          </div>
          <div className="flex items-center gap-3">
            {lastSyncedAt && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> Synced {fmtDateTime(lastSyncedAt)}
              </span>
            )}
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
            {/* Needs Attention */}
            {(attentionCards.length > 0 || openAlerts.length > 0 || interestRiskCards.length > 0 || adSpendWarnings.length > 0) && (
              <div className="rounded-2xl border border-warning/40 bg-warning/5 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Bell className="w-4 h-4 text-warning" />
                  <h3 className="font-semibold text-foreground">Needs Attention</h3>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {attentionCards.map((c) => {
                    const due = resolveDue(c);
                    const urgent = c.isOverdue || (due != null && due.days <= 3);
                    return (
                      <button key={c.id} onClick={() => setSelectedCard(c)}
                        className="flex items-center justify-between gap-2 text-left rounded-lg bg-card border border-border px-3 py-2 hover:border-warning/50 transition-colors">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{c.name} <span className="text-muted-foreground font-normal">••{c.lastFour}</span></p>
                          <p className="text-xs text-muted-foreground">
                            {c.isOverdue ? 'Overdue' : due ? (due.days <= 0 ? 'Due today' : `Due in ${due.days} days`) : 'Due soon'}
                            {due ? ` · ${format(due.date, 'MMM d')}` : ''}
                          </p>
                        </div>
                        <span className={cn('font-semibold whitespace-nowrap', urgent ? 'text-destructive' : 'text-warning')}>
                          {fmtMoney(c.minimumPayment && c.minimumPayment > 0 ? c.minimumPayment : (c.lastStatementBalance ?? c.currentBalance))}
                        </span>
                      </button>
                    );
                  })}
                  {interestRiskCards.map(({ card, risk }) => (
                    <button key={`ir-${card.id}`} onClick={() => setSelectedCard(card)}
                      className="flex items-center justify-between gap-2 text-left rounded-lg bg-card border border-destructive/30 px-3 py-2 hover:border-destructive/60 transition-colors">
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
                    </button>
                  ))}
                  {adSpendWarnings.map(({ card, ad }) => {
                    const over = ad.fraction >= 1;
                    const tone = ad.fraction >= 0.9 ? 'text-destructive' : 'text-warning';
                    return (
                      <button key={`ad-${card.id}`} onClick={() => setSelectedCard(card)}
                        className={cn('flex items-center justify-between gap-2 text-left rounded-lg bg-card border px-3 py-2 transition-colors',
                          ad.fraction >= 0.9 ? 'border-destructive/30 hover:border-destructive/60' : 'border-border hover:border-warning/50')}>
                        <div className="flex items-start gap-2 min-w-0">
                          <Megaphone className={cn('w-4 h-4 mt-0.5 shrink-0', tone)} />
                          <div className="min-w-0">
                            <p className="font-medium truncate">
                              {card.name} <span className="text-muted-foreground font-normal">ad spend {Math.round(ad.fraction * 100)}% of cap</span>
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
                      </button>
                    );
                  })}
                  {openAlerts.map((a) => (
                    <div key={a.id} className="flex items-start gap-2 rounded-lg bg-card border border-border px-3 py-2">
                      <AlertTriangle className={cn('w-4 h-4 mt-0.5 shrink-0',
                        (a.severity ?? '').toLowerCase() === 'high' ? 'text-destructive' : 'text-warning')} />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{a.title ?? a.alertType ?? 'Alert'}</p>
                        {a.message && <p className="text-xs text-muted-foreground line-clamp-2">{a.message}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi label="Available Cash" value={fmtMoney(availableCash)} icon={Landmark} tone="success"
                   sub={`${depository.length} bank ${depository.length === 1 ? 'account' : 'accounts'}`} />
              <Kpi label="Total Card Debt" value={fmtMoney(totalCardDebt)} icon={CardIcon} tone="warning"
                   sub={`${visibleCards.length} cards • ${fmtMoney(creditAvailable)} available`} />
              <Kpi label="Net Cash Position" value={fmtMoney(availableCash - totalCardDebt)} icon={TrendingUp}
                   tone={availableCash - totalCardDebt >= 0 ? 'success' : 'danger'}
                   sub="cash minus card debt" />
              <Kpi label="Due in 7 Days" value={fmtMoney(dueSoonTotal)} icon={CalendarClock}
                   tone={dueSoon.length ? 'danger' : 'muted'}
                   sub={dueSoon.length ? `${dueSoon.length} ${dueSoon.length === 1 ? 'card' : 'cards'} due` : 'nothing due'} />
            </div>

            {/* Bank accounts — prominent, on top */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle icon={Landmark}>Bank Accounts</SectionTitle>
                <span className="text-sm font-semibold text-success">{fmtMoney(availableCash, { cents: true })} total</span>
              </div>
              {depository.length === 0 ? (
                <div className="bg-card rounded-2xl border border-border p-5"><Empty>No bank accounts synced yet.</Empty></div>
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

            {/* Cash projection */}
            {forecast.length > 0 && (
              <div className="bg-card rounded-2xl border border-border p-5">
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
                    <CardTile key={c.id} card={c} adSpend={adSpendByCard.get(c.id)} onClick={() => setSelectedCard(c)} />
                  ))}
                </div>
              )}
            </div>

            {/* Activity summary */}
            <div className="bg-card rounded-2xl border border-border p-5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <SectionTitle icon={TrendingUp}>Activity</SectionTitle>
                <div className="flex items-center gap-1">
                  <RangeChip onClick={() => setActivityPeriod('month')} active={activityPeriod === 'month'}>This Month</RangeChip>
                  <RangeChip onClick={() => setActivityPeriod('30d')} active={activityPeriod === '30d'}>30d</RangeChip>
                  <RangeChip onClick={() => setActivityPeriod('90d')} active={activityPeriod === '90d'}>90d</RangeChip>
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

            {/* Payments + recent transactions */}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="bg-card rounded-2xl border border-border p-5">
                <SectionTitle icon={CheckCircle2}>Recent Payments</SectionTitle>
                {payments.length === 0 ? (
                  <Empty>No card payments in the synced period.</Empty>
                ) : (
                  <div className="space-y-2 mt-3">
                    {payments.slice(0, 8).map((t) => (
                      <TxnRow key={t.id} txn={t} cardName={cardName(t.creditCardId)} />
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-card rounded-2xl border border-border p-5">
                <SectionTitle icon={TrendingDown}>Recent Transactions</SectionTitle>
                {brandTxns.length === 0 ? (
                  <Empty>No transactions synced yet.</Empty>
                ) : (
                  <div className="space-y-2 mt-3">
                    {brandTxns.filter((t) => t.type !== 'payment').slice(0, 8).map((t) => (
                      <TxnRow key={t.id} txn={t} cardName={cardName(t.creditCardId)} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <CardDetailDialog
        card={selectedCard}
        adSpend={selectedCard ? adSpendByCard.get(selectedCard.id) : undefined}
        transactions={selectedCard ? transactions.filter((t) => t.creditCardId === selectedCard.id) : []}
        onClose={() => setSelectedCard(null)}
      />

      <AccountDetailDialog
        account={selectedAccount}
        transactions={selectedAccount ? transactions.filter((t) => t.accountId === selectedAccount.id) : []}
        history={selectedAccount ? snapshots.filter((s) => s.accountId === selectedAccount.id) : []}
        onClose={() => setSelectedAccount(null)}
      />

      <ActivityBreakdownDialog
        detail={activityBreakdown}
        sourceOf={sourceOf}
        onClose={() => setActivityDetail(null)}
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
        <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Landmark className="w-4 h-4" />
        </div>
        <p className="font-semibold text-sm truncate flex-1 min-w-0">{account.name}</p>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
      <p className="text-xs text-muted-foreground truncate mb-1.5">
        {account.institution ?? 'Bank'}
        {account.lastFour ? ` •••• ${account.lastFour}` : ''}
        {' · '}{account.accountType}
      </p>
      <p className="text-2xl font-bold text-card-foreground truncate">{fmtMoney(account.currentBalance, { cents: true })}</p>
      <div className="flex items-end justify-between gap-2 mt-1">
        <p className="text-xs text-muted-foreground truncate">
          {fmtMoney(account.availableBalance)} available
        </p>
        {history.length > 1 && <Sparkline data={history} />}
      </div>
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

function AccountDetailDialog({ account, transactions, history, onClose }: {
  account: FinanceAccount | null; transactions: FinanceTransaction[]; history: BalanceSnapshot[]; onClose: () => void;
}) {
  const open = account != null;
  const chartData = history.map((s) => ({ ...s, label: format(parseISO(s.date), 'MMM d') }));
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto overflow-x-hidden">
        {account && (
          <>
            <DialogHeader>
              <DialogTitle>
                {account.name}{' '}
                <span className="text-muted-foreground font-normal">
                  {account.institution}{account.lastFour ? ` •••• ${account.lastFour}` : ''}
                </span>
              </DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Current Balance">{fmtMoney(account.currentBalance, { cents: true })}</Field>
              <Field label="Available Balance">{fmtMoney(account.availableBalance, { cents: true })}</Field>
              <Field label="Type">{account.accountType}{account.accountSubtype ? ` · ${account.accountSubtype}` : ''}</Field>
              <Field label="Last Updated">{account.updatedAt ? fmtDate(account.updatedAt) : '—'}</Field>
            </div>

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
                          <span className="truncate">{t.merchantName || t.description}</span>
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

function CardTile({ card, adSpend, onClick }: { card: FinanceCard; adSpend?: AdSpendStatus; onClick?: () => void }) {
  const due = resolveDue(card);
  const settled = isSettled(card);
  const risk = interestRisk(card);
  const gradient = cardColorClasses[(card.color as CardColor)] ?? cardColorClasses.navy;
  const utilization = card.creditLimit > 0 ? Math.min(1, card.totalBalance / card.creditLimit) : null;

  // Amount to pay now: the remaining statement balance. Fallbacks cover odd
  // synced states (an overdue card can report a zero statement remainder).
  const payAmount = card.currentBalance > 0.005
    ? card.currentBalance
    : (card.minimumPayment || card.lastStatementBalance || card.totalBalance);

  // One status strip per tile: do I need to act, how much, by when.
  let strip: { tone: Tone; icon: React.ComponentType<{ className?: string }>; text: string };
  if (card.isOverdue) {
    strip = { tone: 'danger', icon: AlertTriangle, text: `Overdue — pay ${fmtMoney(payAmount)} now` };
  } else if (settled) {
    strip = { tone: 'success', icon: CheckCircle2, text: 'Nothing due' };
  } else if (due) {
    const when = due.days <= 0 ? 'due today' : due.days === 1 ? 'in 1 day' : `in ${due.days} days`;
    strip = {
      tone: due.days <= 3 ? 'danger' : due.days <= 7 ? 'warning' : 'muted',
      icon: due.days <= 3 ? AlertTriangle : CalendarClock,
      text: `Pay ${fmtMoney(payAmount)} by ${format(due.date, 'MMM d')} · ${when}`,
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
      <div className={cn('bg-gradient-to-r px-4 py-2.5 text-white', gradient)}>
        <p className="font-semibold leading-tight truncate">{card.name}</p>
        <p className="text-xs text-white/80 truncate">
          {card.lastFour ? `•••• ${card.lastFour}` : ''}{card.companyName ? ` · ${card.companyName}` : ''}
        </p>
      </div>

      {/* Status strip — tinted by state so overdue vs paid reads at a glance */}
      <div className={cn('px-4 py-2 text-sm font-medium flex flex-col gap-1', toneBg[strip.tone])}>
        <span className="flex items-center gap-1.5 min-w-0">
          <strip.icon className="w-4 h-4 shrink-0" />
          <span className="truncate">{strip.text}</span>
        </span>
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
          <p className="text-xs text-muted-foreground">Balance</p>
          <p className="text-2xl font-bold text-card-foreground">{fmtMoney(card.totalBalance)}</p>
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

type Flow = 'all' | 'in' | 'out' | 'ads';
const isMoneyIn = (t: FinanceTransaction) => t.type === 'income';
const isMoneyOut = (t: FinanceTransaction) => t.type === 'expense' || t.type === 'payment';

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
        <div className="space-y-1">
          {filtered.map((t) => <TxnRow key={t.id} txn={t} cardName={null} />)}
        </div>
      )}
    </div>
  );
}

function CardDetailDialog({ card, adSpend, transactions, onClose }: {
  card: FinanceCard | null; adSpend?: AdSpendStatus; transactions: FinanceTransaction[]; onClose: () => void;
}) {
  const open = card != null;
  const due = card ? resolveDue(card) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto overflow-x-hidden">
        {card && (
          <>
            <DialogHeader>
              <DialogTitle>{card.name} <span className="text-muted-foreground font-normal">•••• {card.lastFour}</span></DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Total Balance (owed now)">{fmtMoney(card.totalBalance, { cents: true })}</Field>
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
            <TransactionsPanel transactions={transactions} resetKey={card.id} showAdsFilter={adSpend != null} />
          </>
        )}
      </DialogContent>
    </Dialog>
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

function TxnRow({ txn, cardName }: { txn: FinanceTransaction; cardName: string | null }) {
  const inflow = txn.type === 'income';
  const isPayment = txn.type === 'payment';
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-3 min-w-0">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
          inflow ? 'bg-success/10 text-success' : isPayment ? 'bg-muted text-muted-foreground' : 'bg-warning/10 text-warning')}>
          {inflow ? <ArrowDownRight className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{txn.merchantName || txn.description}</p>
          <p className="text-xs text-muted-foreground truncate">
            {format(parseISO(txn.date), 'MMM d')}
            {txn.category ? ` · ${txn.category}` : ''}
            {cardName ? ` · ${cardName}` : ''}
            {txn.isPending ? ' · pending' : ''}
          </p>
        </div>
      </div>
      <span className={cn('font-semibold shrink-0 ml-2', inflow ? 'text-success' : 'text-foreground')}>
        {inflow ? '+' : isPayment ? '' : '−'}{fmtMoney(txn.amount, { cents: true })}
      </span>
    </div>
  );
}

export default Dashboard;
