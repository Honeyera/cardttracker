import { useState } from 'react';
import { CreditCard } from '@/types/creditCard';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkles, Loader2, Calendar, CreditCard as CreditCardIcon, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

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

interface RecommendationResponse {
  recommendations: CardRecommendation[];
}

export function ChargeRecommendation({ cards }: ChargeRecommendationProps) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [recommendations, setRecommendations] = useState<CardRecommendation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9.]/g, '');
    setAmount(value);
  };

  const handleGetRecommendation = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    if (cards.length === 0) {
      toast.error('No cards available for recommendation');
      return;
    }

    setLoading(true);
    setError(null);
    setRecommendations([]);

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
          chargeAmount: parseFloat(amount),
        },
      });

      if (fnError) {
        throw new Error(fnError.message);
      }

      if (data.error) {
        throw new Error(data.error);
      }

      setRecommendations(data.recommendations || []);
    } catch (err) {
      console.error('Error getting recommendation:', err);
      const message = err instanceof Error ? err.message : 'Failed to get recommendation';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleGetRecommendation();
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-card-foreground">Smart Charge Advisor</h2>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Enter an amount and AI will recommend which card to use for the longest payment deferral.
        </p>

        <div className="flex gap-3 mb-4">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
            <Input
              type="text"
              placeholder="0.00"
              value={amount}
              onChange={handleAmountChange}
              onKeyDown={handleKeyDown}
              className="pl-7"
              disabled={loading}
            />
          </div>
          <Button onClick={handleGetRecommendation} disabled={loading || cards.length === 0}>
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

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive mb-4">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {recommendations.length > 0 && (
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
