import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { format, parseISO, differenceInCalendarDays } from 'date-fns';
import { useAuth } from '@/contexts/AuthContext';
import { useFinanceData, FinanceAccount, FinanceCard, FinanceTransaction } from '@/hooks/useFinanceData';
import { getNextOccurrence } from '@/utils/dateUtils';
import { cardColorClasses, CardColor } from '@/types/creditCard';
import { UserMenu } from '@/components/UserMenu';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  Wallet, LayoutDashboard, CreditCard as CardIcon, Trophy, Loader2, Building2,
  ArrowDownRight, ArrowUpRight, Landmark, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle2, CalendarClock, RefreshCw,
} from 'lucide-react';

const fmtMoney = (n: number, opts: { cents?: boolean } = {}) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  try { return format(parseISO(iso), 'MMM d, yyyy'); } catch { return iso; }
};

// Resolve a card's next due date: prefer the synced explicit date, else derive
// from the day-of-month. Returns { date, days } or null if nothing to go on.
function resolveDue(card: FinanceCard): { date: Date; days: number } | null {
  let date: Date | null = null;
  if (card.nextPaymentDueDate) {
    try { date = parseISO(card.nextPaymentDueDate); } catch { date = null; }
  }
  if (!date && card.dueDay) date = getNextOccurrence(card.dueDay);
  if (!date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return { date, days: differenceInCalendarDays(date, today) };
}

const Dashboard = () => {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { accounts, transactions, cards, loading, lastSyncedAt } = useFinanceData();
  const [company, setCompany] = useState('all');

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const companies = useMemo(
    () => Array.from(new Set(cards.map((c) => c.companyName).filter(Boolean))) as string[],
    [cards],
  );

  const visibleCards = useMemo(
    () => (company === 'all' ? cards : cards.filter((c) => c.companyName === company)),
    [cards, company],
  );

  const depository = useMemo(
    () => accounts.filter((a) => a.accountType === 'checking' || a.accountType === 'savings'),
    [accounts],
  );

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
      .filter((x) => x.due && x.due.days <= 7 && x.card.currentBalance > 0.005)
      .sort((a, b) => (a.due!.days - b.due!.days));
  }, [visibleCards]);
  const dueSoonTotal = dueSoon.reduce((s, x) => s + x.card.currentBalance, 0);

  // ── Activity roll-up (whatever period the synced data spans) ────────
  const income = transactions.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const spend = transactions.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const payments = transactions.filter((t) => t.type === 'payment');
  const paymentsTotal = payments.reduce((s, t) => s + t.amount, 0);

  const cardName = (id: string | null) =>
    cards.find((c) => c.id === id)?.name ?? null;

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
            <Button size="sm" variant="outline" asChild>
              <Link to="/"><CardIcon className="w-4 h-4 mr-1" />Cards</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/points"><Trophy className="w-4 h-4 mr-1" />Points</Link>
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
                <RefreshCw className="w-3 h-3" /> Synced {fmtDate(lastSyncedAt)}
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
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {depository.map((a) => <AccountTile key={a.id} account={a} />)}
                </div>
              )}
            </div>

            {/* Card tiles */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle icon={CardIcon}>Your Cards</SectionTitle>
                <span className="text-xs text-muted-foreground">
                  {visibleCards.length} {visibleCards.length === 1 ? 'card' : 'cards'}
                </span>
              </div>
              {visibleCards.length === 0 ? (
                <Empty>No cards to show.</Empty>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleCards.map((c) => <CardTile key={c.id} card={c} />)}
                </div>
              )}
            </div>

            {/* Activity summary */}
            <div className="bg-card rounded-2xl border border-border p-5">
              <SectionTitle icon={TrendingUp}>Activity</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-3">
                <Flow label="Income" value={income} icon={ArrowDownRight} tone="success" />
                <Flow label="Spending" value={spend} icon={ArrowUpRight} tone="warning" />
                <Flow label="Card Payments" value={paymentsTotal} icon={CardIcon} tone="muted" />
                <div className="flex items-center justify-between sm:justify-end sm:gap-2">
                  <span className="text-sm font-medium">Net</span>
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
                {transactions.length === 0 ? (
                  <Empty>No transactions synced yet.</Empty>
                ) : (
                  <div className="space-y-2 mt-3">
                    {transactions.filter((t) => t.type !== 'payment').slice(0, 8).map((t) => (
                      <TxnRow key={t.id} txn={t} cardName={cardName(t.creditCardId)} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>
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

function AccountTile({ account }: { account: FinanceAccount }) {
  return (
    <div className="bg-card rounded-2xl border border-border p-5 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Landmark className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold truncate">{account.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {account.institution ?? 'Bank'}
            {account.lastFour ? ` •••• ${account.lastFour}` : ''}
            {' · '}{account.accountType}
          </p>
        </div>
      </div>
      <p className="text-3xl font-bold text-card-foreground">{fmtMoney(account.currentBalance, { cents: true })}</p>
      {account.availableBalance !== account.currentBalance && (
        <p className="text-xs text-muted-foreground mt-1">{fmtMoney(account.availableBalance, { cents: true })} available</p>
      )}
    </div>
  );
}

function Flow({ label, value, icon: Icon, tone }: {
  label: string; value: number; icon: React.ComponentType<{ className?: string }>; tone: Tone;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className={cn('w-4 h-4', toneText[tone])} />{label}
      </span>
      <span className="font-semibold">{fmtMoney(value, { cents: true })}</span>
    </div>
  );
}

function CardTile({ card }: { card: FinanceCard }) {
  const due = resolveDue(card);
  const paidStatement =
    card.currentBalance <= 0.005 ||
    (card.paymentStatus?.toLowerCase().includes('not required') ?? false) ||
    (card.paymentStatus?.toLowerCase().includes('no payment') ?? false);

  let status: { label: string; tone: Tone; icon: React.ComponentType<{ className?: string }> };
  if (card.isOverdue) status = { label: 'Overdue', tone: 'danger', icon: AlertTriangle };
  else if (paidStatement) status = { label: 'Paid / none due', tone: 'success', icon: CheckCircle2 };
  else if (due && due.days <= 3) status = { label: due.days <= 0 ? 'Due today' : `Due in ${due.days}d`, tone: 'danger', icon: AlertTriangle };
  else if (due && due.days <= 7) status = { label: `Due in ${due.days}d`, tone: 'warning', icon: CalendarClock };
  else status = { label: due ? `Due in ${due.days}d` : 'No due date', tone: 'muted', icon: CalendarClock };

  const gradient = cardColorClasses[(card.color as CardColor)] ?? cardColorClasses.navy;
  const utilization = card.creditLimit > 0 ? Math.min(1, card.totalBalance / card.creditLimit) : null;

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm flex flex-col">
      {/* Colored header strip */}
      <div className={cn('bg-gradient-to-r px-4 py-3 text-white', gradient)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold leading-tight truncate">{card.name}</p>
            <p className="text-xs text-white/80 truncate">
              {card.lastFour ? `•••• ${card.lastFour}` : ''}{card.companyName ? ` · ${card.companyName}` : ''}
            </p>
          </div>
          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap bg-white/15 text-white')}>
            <status.icon className="w-3 h-3" />{status.label}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Statement Due</p>
            <p className="text-2xl font-bold text-card-foreground">{fmtMoney(card.currentBalance, { cents: true })}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Min Payment</p>
            <p className="font-semibold">{card.minimumPayment ? fmtMoney(card.minimumPayment) : '—'}</p>
          </div>
        </div>

        {/* Utilization */}
        {utilization != null && (
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>{fmtMoney(card.totalBalance)} of {fmtMoney(card.creditLimit)}</span>
              <span>{Math.round(utilization * 100)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div className={cn('h-full rounded-full',
                utilization >= 0.9 ? 'bg-destructive' : utilization >= 0.5 ? 'bg-warning' : 'bg-success')}
                style={{ width: `${Math.max(2, utilization * 100)}%` }} />
            </div>
          </div>
        )}

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3 text-sm pt-1">
          <Field label="Closes">
            {card.lastStatementDate ? format(parseISO(card.lastStatementDate), 'MMM d')
              : card.statementDay ? `Day ${card.statementDay}` : '—'}
          </Field>
          <Field label="Due">
            {due ? format(due.date, 'MMM d') : card.dueDay ? `Day ${card.dueDay}` : '—'}
          </Field>
          <Field label="Last Payment">
            {card.lastPaymentAmount != null ? fmtMoney(card.lastPaymentAmount) : '—'}
          </Field>
          <Field label="Paid On">
            {card.lastPaymentDate ? format(parseISO(card.lastPaymentDate), 'MMM d') : '—'}
          </Field>
        </div>
      </div>
    </div>
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
