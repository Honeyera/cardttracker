import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { CreditCard, CardColor } from '@/types/creditCard';
import { CheckCircle, ClipboardPaste, Loader2, Plus, RefreshCw, X } from 'lucide-react';

interface PasteTextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingCards: CreditCard[];
  onCardsFound: (newCards: Omit<CreditCard, 'id'>[]) => void;
  onCardsUpdated: (updates: { id: string; currentBalance: number; totalBalance?: number; paymentStatus?: string }[]) => void;
}

interface MatchedCard {
  existingCard: CreditCard;
  newBalance: number;
  newTotalBalance?: number;
  newPaymentStatus?: string;
}

interface ParsedCard {
  name: string;
  lastFiveDigits: string;
  closingDay: number;
  dueDay: number;
  color: CardColor;
  currentBalance: number;
  totalBalance?: number;
  creditLimit?: number;
  paymentStatus?: string;
}

const cardColors: CardColor[] = ['navy', 'teal', 'slate', 'ocean', 'gold', 'rose', 'purple', 'emerald'];

function normalizeLastFiveDigits(value: unknown): string {
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '');
  const digitsOnly = raw.replace(/\D/g, '');
  if (!digitsOnly) return '00000';
  return digitsOnly.slice(-5).padStart(5, '0');
}

export function PasteTextDialog({
  open,
  onOpenChange,
  existingCards,
  onCardsFound,
  onCardsUpdated,
}: PasteTextDialogProps) {
  const [isParsing, setIsParsing] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [newCards, setNewCards] = useState<ParsedCard[]>([]);
  const [matchedCards, setMatchedCards] = useState<MatchedCard[]>([]);
  const [unchangedCount, setUnchangedCount] = useState(0);
  const [hasParsed, setHasParsed] = useState(false);
  const { toast } = useToast();

  const findExistingCard = (parsedCard: ParsedCard): CreditCard | null => {
    const parsedDigits = normalizeLastFiveDigits(parsedCard.lastFiveDigits);
    if (parsedDigits === '00000') return null;
    return existingCards.find(
      (c) => normalizeLastFiveDigits(c.lastFiveDigits) === parsedDigits
    ) ?? null;
  };

  const handleParse = async () => {
    if (!textInput.trim()) {
      toast({
        title: 'No text provided',
        description: 'Please paste some text to parse.',
        variant: 'destructive',
      });
      return;
    }

    setIsParsing(true);
    setNewCards([]);
    setMatchedCards([]);
    setUnchangedCount(0);
    setHasParsed(false);

    try {
      const { data, error } = await supabase.functions.invoke('parse-text', {
        body: { text: textInput },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      setHasParsed(true);

      if (data?.cards && data.cards.length > 0) {
        const parsedCards: ParsedCard[] = data.cards.map((card: any, index: number) => ({
          name: card?.name || 'Unknown Card',
          lastFiveDigits: normalizeLastFiveDigits(card?.lastFiveDigits),
          closingDay: Math.min(31, Math.max(1, parseInt(card?.closingDay) || 15)),
          dueDay: Math.min(31, Math.max(1, parseInt(card?.dueDay) || 22)),
          color: cardColors[index % cardColors.length],
          currentBalance: parseFloat(card?.remainingStatementBalance) || parseFloat(card?.currentBalance) || 0,
          totalBalance: parseFloat(card?.totalBalance) || undefined,
          creditLimit: card?.creditLimit ? parseFloat(card.creditLimit) : undefined,
          paymentStatus: card?.paymentStatus || undefined,
        }));

        const missingDigitsCount = parsedCards.filter((c) => c.lastFiveDigits === '00000').length;
        if (missingDigitsCount > 0) {
          toast({
            title: 'Some card digits could not be read',
            description: 'Cards without digits will be treated as new.',
            variant: 'destructive',
          });
        }

        const newCardsList: ParsedCard[] = [];
        const matchedCardsList: MatchedCard[] = [];
        let unchangedCardCount = 0;

        parsedCards.forEach((parsedCard) => {
          const existing = findExistingCard(parsedCard);
          if (existing) {
            const existingBalance = existing.currentBalance || 0;
            const newBalance = parsedCard.currentBalance || 0;
            const existingTotal = existing.totalBalance || 0;
            const newTotal = parsedCard.totalBalance || 0;
            const balanceChanged = Math.abs(existingBalance - newBalance) >= 0.01;
            const totalChanged = Math.abs(existingTotal - newTotal) >= 0.01;
            const statusChanged = parsedCard.paymentStatus !== existing.paymentStatus;

            if (balanceChanged || totalChanged || statusChanged) {
              matchedCardsList.push({
                existingCard: existing,
                newBalance: parsedCard.currentBalance,
                newTotalBalance: parsedCard.totalBalance,
                newPaymentStatus: parsedCard.paymentStatus,
              });
            } else {
              unchangedCardCount++;
            }
          } else {
            newCardsList.push(parsedCard);
          }
        });

        setNewCards(newCardsList);
        setMatchedCards(matchedCardsList);
        setUnchangedCount(unchangedCardCount);

        if (newCardsList.length === 0 && matchedCardsList.length === 0 && unchangedCardCount === 0) {
          toast({
            title: 'No cards found',
            description: 'Could not detect any credit cards in the text.',
            variant: 'destructive',
          });
        }
      } else {
        toast({
          title: 'No cards found',
          description: 'Could not detect any credit cards in the text.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      console.error('Error parsing text:', err);
      toast({
        title: 'Parsing failed',
        description: err instanceof Error ? err.message : 'Failed to parse text',
        variant: 'destructive',
      });
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirm = () => {
    if (matchedCards.length > 0) {
      const updates = matchedCards.map((m) => ({
        id: m.existingCard.id,
        currentBalance: m.newBalance,
        totalBalance: m.newTotalBalance,
        paymentStatus: m.newPaymentStatus,
      }));
      onCardsUpdated(updates);
    }

    if (newCards.length > 0) {
      onCardsFound(newCards);
    }

    const messages: string[] = [];
    if (matchedCards.length > 0) {
      messages.push(`Updated ${matchedCards.length} card${matchedCards.length > 1 ? 's' : ''}`);
    }
    if (newCards.length > 0) {
      messages.push(`Added ${newCards.length} new card${newCards.length > 1 ? 's' : ''}`);
    }

    toast({
      title: 'Success!',
      description: messages.join(' and ') + '.',
    });

    handleClose();
  };

  const handleClose = () => {
    setTextInput('');
    setNewCards([]);
    setMatchedCards([]);
    setUnchangedCount(0);
    setIsParsing(false);
    setHasParsed(false);
    onOpenChange(false);
  };

  const totalCards = newCards.length + matchedCards.length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Paste Card Text</DialogTitle>
          <DialogDescription>
            Paste copied text from your banking app or statement to extract card info.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Text Input Area */}
          <Textarea
            placeholder="Paste your card information here...&#10;&#10;Example:&#10;Ink Unlimited&#10;Account ending in 01012&#10;Current balance: $5,248.21&#10;Statement balance: $0.00"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="min-h-[150px] font-mono text-sm"
            disabled={isParsing}
          />

          {/* All Up To Date Overlay */}
          {hasParsed && unchangedCount > 0 && newCards.length === 0 && matchedCards.length === 0 && (
            <div className="flex items-center gap-3 p-4 bg-primary/10 border border-primary/20 rounded-lg">
              <CheckCircle className="w-8 h-8 text-primary flex-shrink-0" />
              <div>
                <p className="font-semibold text-foreground">All up to date!</p>
                <p className="text-sm text-muted-foreground">
                  {unchangedCount} card{unchangedCount > 1 ? 's' : ''} found — balances unchanged.
                </p>
              </div>
            </div>
          )}

          {/* Matched Cards (Updates) */}
          {matchedCards.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-accent" />
                Updating {matchedCards.length} existing card{matchedCards.length > 1 ? 's' : ''}:
              </p>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {matchedCards.map((match, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-accent/10 border border-accent/20 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-sm">{match.existingCard.name}</p>
                      <p className="text-xs text-muted-foreground">
                        •••• {match.existingCard.lastFiveDigits} | Balance: ${
                          (match.existingCard.currentBalance || 0).toLocaleString()
                        } → ${match.newBalance.toLocaleString()}
                      </p>
                    </div>
                    <RefreshCw className="w-4 h-4 text-accent" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* New Cards */}
          {newCards.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <Plus className="w-4 h-4 text-success" />
                Adding {newCards.length} new card{newCards.length > 1 ? 's' : ''}:
              </p>
              <p className="text-xs text-muted-foreground">
                Click the X to remove any incorrectly detected cards.
              </p>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {newCards.map((card, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-success/10 border border-success/20 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{card.name}</p>
                      <p className="text-xs text-muted-foreground">
                        •••• {card.lastFiveDigits} | Due: {card.dueDay}th | Balance: ${
                          card.currentBalance?.toLocaleString()
                        }
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNewCards((prev) => prev.filter((_, i) => i !== index))}
                      className="ml-2 p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                      title="Remove this card"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unchanged count info */}
          {unchangedCount > 0 && (newCards.length > 0 || matchedCards.length > 0) && (
            <p className="text-xs text-muted-foreground text-center">
              {unchangedCount} card{unchangedCount > 1 ? 's' : ''} skipped (balance unchanged)
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={handleClose} className="flex-1">
              Cancel
            </Button>
            {totalCards > 0 ? (
              <Button onClick={handleConfirm} className="flex-1">
                Confirm Changes
              </Button>
            ) : (
              <Button
                onClick={handleParse}
                disabled={isParsing || !textInput.trim()}
                className="flex-1"
              >
                {isParsing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Parsing...
                  </>
                ) : (
                  <>
                    <ClipboardPaste className="w-4 h-4 mr-2" />
                    Parse Text
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
