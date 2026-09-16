import { useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { FinanceAccount, FinanceCard, FinanceTransaction } from '@/hooks/useFinanceData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sparkles, Loader2, CornerDownLeft } from 'lucide-react';

const EXAMPLES = [
  'Show me a charge that recurs every month',
  'How much did I spend on Amazon ads this year?',
  'Which card is due next and how much?',
  'What was my total income last month?',
];

export function AskBox({ accounts, cards, transactions }: {
  accounts: FinanceAccount[]; cards: FinanceCard[]; transactions: FinanceTransaction[];
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Small context: accounts + cards only. The edge function queries the FULL
  // transaction history itself (via a tool), so we don't ship transactions here.
  const context = useMemo(() => ({
    today: new Date().toISOString().slice(0, 10),
    transactionCount: transactions.length,
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
  }), [accounts, cards, transactions.length]);

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
