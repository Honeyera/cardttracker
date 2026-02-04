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

interface Recommendation {
  recommendedCard: string;
  daysUntilPayment: number;
  nextClosingDate: string;
  paymentDueDate: string;
  explanation: string;
}

export function ChargeRecommendation({ cards }: ChargeRecommendationProps) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
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
    setRecommendation(null);

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

      setRecommendation(data);
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

        {recommendation && (
          <div className="p-4 rounded-lg bg-primary/5 border border-primary/20 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <CreditCardIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Recommended Card</p>
                <p className="font-semibold text-card-foreground">{recommendation.recommendedCard}</p>
              </div>
            </div>

            <div className="flex items-center gap-6 pt-2">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Days Until Payment</p>
                  <p className={cn(
                    "font-semibold",
                    recommendation.daysUntilPayment > 30 ? "text-emerald-600" : 
                    recommendation.daysUntilPayment > 14 ? "text-amber-600" : "text-destructive"
                  )}>
                    {recommendation.daysUntilPayment} days
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Next Closing</p>
                <p className="font-medium text-card-foreground">{recommendation.nextClosingDate}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payment Due</p>
                <p className="font-medium text-card-foreground">{recommendation.paymentDueDate}</p>
              </div>
            </div>

            <div className="pt-2 border-t border-border">
              <p className="text-sm text-muted-foreground">{recommendation.explanation}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
