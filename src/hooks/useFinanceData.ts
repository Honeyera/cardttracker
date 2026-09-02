import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

// These tables/columns are populated by the external finance sync (ChatGPT →
// Plaid → Supabase) and are not in the generated types.ts, so we query through
// an untyped client and map into the interfaces below.
const db = supabase as any;

export type AccountType = 'checking' | 'savings' | 'credit_card' | string;

export interface FinanceAccount {
  id: string;
  name: string;
  institution: string | null;
  accountType: AccountType;
  accountSubtype: string | null;
  lastFour: string | null;
  currentBalance: number;
  availableBalance: number;
  creditLimit: number | null;
  isActive: boolean;
  updatedAt: string | null;
}

export type TransactionDirection = 'expense' | 'income' | 'payment' | 'transfer' | string;

export interface FinanceTransaction {
  id: string;
  accountId: string | null;
  creditCardId: string | null;
  date: string; // YYYY-MM-DD
  description: string;
  merchantName: string | null;
  amount: number; // always positive; direction given by `type`
  type: TransactionDirection;
  category: string | null;
  isPending: boolean;
  isRecurring: boolean;
}

// A credit card enriched with the finance-sync fields (statement/payment info)
// that the basic useCreditCards() hook does not expose.
export interface FinanceCard {
  id: string;
  name: string;
  companyName: string | null;
  ownerName: string | null;
  lastFour: string | null;
  color: string;
  creditLimit: number;
  currentBalance: number; // statement balance due
  totalBalance: number; // full amount owed
  statementDay: number | null; // day of month the statement closes
  dueDay: number | null; // day of month payment is due
  lastStatementDate: string | null;
  lastStatementBalance: number | null;
  minimumPayment: number | null;
  nextPaymentDueDate: string | null;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  purchaseApr: number | null;
  isOverdue: boolean;
  paymentStatus: string | null;
  syncedAt: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function useFinanceData() {
  const { user } = useAuth();

  const accountsQuery = useQuery({
    queryKey: ['finance', 'accounts', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<FinanceAccount[]> => {
      const { data, error } = await db
        .from('accounts')
        .select('*')
        .order('current_balance', { ascending: false });
      if (error) throw error;
      return (data ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
        institution: a.institution_name ?? null,
        accountType: a.account_type,
        accountSubtype: a.account_subtype ?? null,
        lastFour: a.last_four ?? null,
        currentBalance: num(a.current_balance),
        availableBalance: num(a.available_balance),
        creditLimit: a.credit_limit == null ? null : num(a.credit_limit),
        isActive: a.is_active ?? true,
        updatedAt: a.updated_at ?? null,
      }));
    },
  });

  const transactionsQuery = useQuery({
    queryKey: ['finance', 'transactions', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<FinanceTransaction[]> => {
      const { data, error } = await db
        .from('transactions')
        .select('*')
        .order('transaction_date', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []).map((t: any) => ({
        id: t.id,
        accountId: t.account_id ?? null,
        creditCardId: t.credit_card_id ?? null,
        date: t.transaction_date,
        description: t.description ?? '',
        merchantName: t.merchant_name ?? null,
        amount: num(t.amount),
        type: t.transaction_type ?? 'expense',
        category: t.category ?? null,
        isPending: t.is_pending ?? false,
        isRecurring: t.is_recurring ?? false,
      }));
    },
  });

  const cardsQuery = useQuery({
    queryKey: ['finance', 'cards', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<FinanceCard[]> => {
      const { data, error } = await db
        .from('credit_cards')
        .select('*')
        .order('display_order', { ascending: true });
      if (error) throw error;
      return (data ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        companyName: c.company_name ?? null,
        ownerName: c.owner_name ?? null,
        lastFour: c.last_four ?? null,
        color: c.network ?? 'navy',
        creditLimit: num(c.credit_limit),
        currentBalance: num(c.current_balance),
        totalBalance: num(c.total_balance),
        statementDay: c.statement_date ?? null,
        dueDay: c.due_date ?? null,
        lastStatementDate: c.last_statement_date ?? null,
        lastStatementBalance: c.last_statement_balance == null ? null : num(c.last_statement_balance),
        minimumPayment: c.minimum_payment == null ? null : num(c.minimum_payment),
        nextPaymentDueDate: c.next_payment_due_date ?? null,
        lastPaymentDate: c.last_payment_date ?? null,
        lastPaymentAmount: c.last_payment_amount == null ? null : num(c.last_payment_amount),
        purchaseApr: c.purchase_apr == null ? null : num(c.purchase_apr),
        isOverdue: c.is_overdue ?? false,
        paymentStatus: c.payment_status ?? null,
        syncedAt: c.finance_synced_at ?? null,
      }));
    },
  });

  return {
    accounts: accountsQuery.data ?? [],
    transactions: transactionsQuery.data ?? [],
    cards: cardsQuery.data ?? [],
    loading: accountsQuery.isLoading || transactionsQuery.isLoading || cardsQuery.isLoading,
    error: accountsQuery.error || transactionsQuery.error || cardsQuery.error,
    lastSyncedAt: (cardsQuery.data ?? []).reduce<string | null>((latest, c) => {
      if (!c.syncedAt) return latest;
      return !latest || c.syncedAt > latest ? c.syncedAt : latest;
    }, null),
  };
}
