import { useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { FinanceAccount, FinanceCard, FinanceTransaction } from '@/hooks/useFinanceData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sparkles, Loader2, CornerDownLeft } from 'lucide-react';

const EXAMPLES = [
  'What are the latest 3 transactions on the Amex cards?',
  'Which card is due next and how much?',
  'How much did I spend on ads this month?',
  'Which card has the most points?',
];

export function AskBox({ accounts, cards, transactions }: {
  accounts: FinanceAccount[]; cards: FinanceCard[]; transactions: FinanceTransaction[];
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Compact context for the model: accounts, cards, and recent transactions
  // (with the source card/account name resolved).
  const context = useMemo(() => {
    const cardName = (id: string | null) => cards.find((c) => c.id === id)?.name ?? null;
    const acctName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? null;

    // Recurring-charge summary computed over ALL history, so pattern questions
    // ("what recurs monthly?") work without shipping every raw row to the model.
    const norm = (s: string) => s.toLowerCase()
      .replace(/\d+/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
      .split(' ').slice(0, 4).join(' ');
    const groups = new Map<string, { name: string; months: Set<string>; count: number; amounts: number[]; sources: Set<string>; last: string }>();
    for (const t of transactions) {
      if (t.type === 'payment' || t.type === 'transfer') continue;
      const label = t.merchantName || t.description || '';
      const key = norm(label);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = { name: label, months: new Set(), count: 0, amounts: [], sources: new Set(), last: t.date }; groups.set(key, g); }
      g.months.add(t.date.slice(0, 7));
      g.count++; g.amounts.push(t.amount);
      const src = cardName(t.creditCardId) ?? acctName(t.accountId);
      if (src) g.sources.add(src);
      if (t.date > g.last) g.last = t.date;
    }
    const recurringCharges = [...groups.values()]
      .filter((g) => g.months.size >= 3)
      .sort((a, b) => b.months.size - a.months.size)
      .slice(0, 60)
      .map((g) => ({
        name: g.name,
        occurrences: g.count,
        distinctMonths: g.months.size,
        typicalAmount: Math.round((g.amounts.reduce((s, a) => s + a, 0) / g.amounts.length) * 100) / 100,
        minAmount: Math.min(...g.amounts), maxAmount: Math.max(...g.amounts),
        lastSeen: g.last, sources: [...g.sources],
      }));

    return {
      today: new Date().toISOString().slice(0, 10),
      _note: 'recentTransactions is only the latest 250 rows. recurringCharges is aggregated over the FULL history (all years) — use it for recurring/pattern/frequency questions. transactionCount is the total on file.',
      transactionCount: transactions.length,
      recurringCharges,
      accounts: accounts.map((a) => ({
        name: a.name, institution: a.institution, type: a.accountType, lastFour: a.lastFour,
        currentBalance: a.currentBalance, availableBalance: a.availableBalance, company: a.company,
      })),
      cards: cards.map((c) => ({
        name: c.name, lastFour: c.lastFour, company: c.companyName, owner: c.ownerName,
        currentBalance: c.currentBalance, statementBalance: c.lastStatementBalance,
        minimumPayment: c.minimumPayment, creditLimit: c.creditLimit, apr: c.purchaseApr,
        statementDate: c.lastStatementDate, dueDate: c.nextPaymentDueDate,
        lastPaymentAmount: c.lastPaymentAmount, lastPaymentDate: c.lastPaymentDate,
      })),
      recentTransactions: transactions.slice(0, 250).map((t) => ({
        date: t.date, description: t.merchantName || t.description, amount: t.amount,
        type: t.type, category: t.category,
        source: cardName(t.creditCardId) ?? acctName(t.accountId) ?? null,
      })),
    };
  }, [accounts, cards, transactions]);

  const ask = async (q: string) => {
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true); setError(null); setAnswer(null);
    try {
      const { data, error } = await supabase.functions.invoke('ask', { body: { question: query, context } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setAnswer(data?.answer ?? 'No answer returned.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="font-semibold text-foreground">Ask about your accounts</h3>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); ask(question); }} className="flex items-center gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What are the latest 3 transactions on the Amex cards?"
          className="flex-1"
        />
        <Button type="submit" disabled={loading || !question.trim()}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CornerDownLeft className="w-4 h-4" />}
        </Button>
      </form>

      {!answer && !loading && !error && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { setQuestion(ex); ask(ex); }}
              className="text-xs rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:bg-muted transition-colors">
              {ex}
            </button>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground mt-3 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…</p>}
      {error && <p className="text-sm text-destructive mt-3">{error}</p>}
      {answer && (
        <div className="mt-3 rounded-xl bg-muted/50 p-4 text-sm whitespace-pre-wrap text-card-foreground">{answer}</div>
      )}
    </div>
  );
}
