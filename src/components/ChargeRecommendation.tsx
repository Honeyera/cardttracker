import { useState } from 'react';
import { CreditCard } from '@/types/creditCard';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkles, Loader2, Calendar, CreditCard as CreditCardIcon, AlertCircle, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ChargeRecommendationProps {
  cards: CreditCard[];
}

interface CardRecommendation {
  rank: number;
  cardName: string;
  lastFiveDigits: string;
  daysUntilPayment: number;
  nextClosingDate: string;
  paymentDueDate: string;
  explanation: string;
}

type ResponseMode = 'recommendations' | 'freeform';

export function ChargeRecommendation({ cards }: ChargeRecommendationProps) {
  const [loading, setLoading] = useState(false);
  const [recommendations, setRecommendations] = useState<CardRecommendation[]>([]);
  const [freeformAnswer, setFreeformAnswer] = useState<string | null>(null);
  const [responseMode, setResponseMode] = useState<ResponseMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');

  const fetchRecommendations = async () => {
    if (cards.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('recommend-card', {
        body: {
          cards: cards.map(card => ({
            name: card.name,
            lastFiveDigits: card.lastFiveDigits,
            closingDay: card.closingDay,
            dueDay: card.dueDay,
            currentBalance: card.currentBalance,
            totalBalance: card.totalBalance,
            creditLimit: card.creditLimit,
            paymentStatus: card.paymentStatus,
          })),
          chargeAmount: 100,
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (data.error) throw new Error(data.error);

      setRecommendations(data.recommendations || []);
      setFreeformAnswer(null);
      setResponseMode('recommendations');
    } catch (err) {
      console.error('Error getting recommendation:', err);
      setError(err instanceof Error ? err.message : 'Failed to get recommendation');
    } finally {
      setLoading(false);
    }
  };

  const askQuestion = async () => {
    if (cards.length === 0 || !question.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('recommend-card', {
        body: {
          cards: cards.map(card => ({
            name: card.name,
            lastFiveDigits: card.lastFiveDigits,
            closingDay: card.closingDay,
            dueDay: card.dueDay,
            currentBalance: card.currentBalance,
            totalBalance: card.totalBalance,
            creditLimit: card.creditLimit,
            paymentStatus: card.paymentStatus,
          })),
          chargeAmount: 100,
          userQuestion: question.trim(),
        },
      });

      if (fnError) throw new Error(fnError.message);
      if (data.error) throw new Error(data.error);

      if (data.answer) {
        setFreeformAnswer(data.answer);
        setRecommendations([]);
        setResponseMode('freeform');
      } else {
        setRecommendations(data.recommendations || []);
        setFreeformAnswer(null);
        setResponseMode('recommendations');
      }
    } catch (err) {
      console.error('Error asking question:', err);
      setError(err instanceof Error ? err.message : 'Failed to get answer');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askQuestion();
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-card-foreground">Smart Charge Advisor</h2>
          </div>
          <Button 
            onClick={fetchRecommendations} 
            disabled={loading || cards.length === 0}
            size="sm"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Get Recommendation
              </>
            )}
          </Button>
        </div>

        <div className="flex gap-2 mb-4">
          <Textarea
            placeholder="Ask anything about your cards... e.g. 'Which card should I use for a $500 purchase?' or 'Which card has the most available credit?'"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-h-[60px] resize-none text-sm"
            rows={2}
          />
          <Button
            onClick={askQuestion}
            disabled={loading || cards.length === 0 || !question.trim()}
            size="sm"
            className="self-end"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {responseMode === 'freeform' && freeformAnswer && (
          <div className="p-4 rounded-lg border border-primary/20 bg-primary/5">
            <p className="text-sm text-card-foreground whitespace-pre-wrap">{freeformAnswer}</p>
          </div>
        )}

        {responseMode === 'recommendations' && recommendations.length > 0 && (
          <div className="space-y-3">
            {recommendations.map((rec, index) => (
              <div 
                key={rec.rank} 
                className={cn(
                  "p-4 rounded-lg border space-y-3",
                  index === 0 
                    ? "bg-primary/5 border-primary/20" 
                    : "bg-muted/30 border-border"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm",
                    index === 0 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-muted text-muted-foreground"
                  )}>
                    #{rec.rank}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-card-foreground">{rec.cardName}</p>
                    <p className="text-xs text-muted-foreground font-mono">•••• {rec.lastFiveDigits || '•••••'}</p>
                  </div>
                  <div className={cn(
                    "px-3 py-1 rounded-full text-sm font-semibold",
                    rec.daysUntilPayment > 45 ? "bg-emerald-100 text-emerald-700" : 
                    rec.daysUntilPayment > 30 ? "bg-amber-100 text-amber-700" : 
                    "bg-red-100 text-red-700"
                  )}>
                    {rec.daysUntilPayment} days
                  </div>
                </div>

                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Closes:</span>
                    <span className="font-medium text-card-foreground">{rec.nextClosingDate}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CreditCardIcon className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Due:</span>
                    <span className="font-medium text-card-foreground">{rec.paymentDueDate}</span>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">{rec.explanation}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
