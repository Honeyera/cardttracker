import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { CreditCard, CardColor } from '@/types/creditCard';
import { Check, ImageIcon, Loader2, Plus, RefreshCw, Upload } from 'lucide-react';

interface UploadScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingCards: CreditCard[];
  onCardsFound: (newCards: Omit<CreditCard, 'id'>[]) => void;
  onCardsUpdated: (updates: { id: string; currentBalance: number }[]) => void;
}

interface MatchedCard {
  existingCard: CreditCard;
  newBalance: number;
}

interface ParsedCard {
  name: string;
  lastFiveDigits: string;
  closingDay: number;
  dueDay: number;
  color: CardColor;
  currentBalance: number;
  creditLimit?: number;
}

const cardColors: CardColor[] = ['navy', 'teal', 'slate', 'ocean', 'gold', 'rose', 'purple', 'emerald'];

function normalizeLastFiveDigits(value: unknown): string {
  // Handles values like: 81008, "81008", "•••• 81008", "x81008\n", etc.
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '');
  const digitsOnly = raw.replace(/\D/g, '');
  if (!digitsOnly) return '00000';
  return digitsOnly.slice(-5).padStart(5, '0');
}

export function UploadScreenshotDialog({
  open,
  onOpenChange,
  existingCards,
  onCardsFound,
  onCardsUpdated,
}: UploadScreenshotDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [newCards, setNewCards] = useState<ParsedCard[]>([]);
  const [matchedCards, setMatchedCards] = useState<MatchedCard[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const findExistingCard = (parsedCard: ParsedCard): CreditCard | null => {
    const parsedDigits = normalizeLastFiveDigits(parsedCard.lastFiveDigits);

    // Strict matching ONLY by the digits. If digits couldn't be extracted, do not guess.
    // This avoids incorrectly "updating" the wrong card.
    if (parsedDigits === '00000') return null;

    const byDigits = existingCards.find(
      (c) => normalizeLastFiveDigits(c.lastFiveDigits) === parsedDigits
    );

    return byDigits ?? null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      setPreviewUrl(base64);
      await analyzeImage(base64);
    };
    reader.readAsDataURL(file);
  };

  const analyzeImage = async (imageBase64: string) => {
    setIsAnalyzing(true);
    setNewCards([]);
    setMatchedCards([]);

    try {
      const { data, error } = await supabase.functions.invoke('analyze-screenshot', {
        body: { imageBase64 },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      if (data?.cards && data.cards.length > 0) {
        const parsedCards: ParsedCard[] = data.cards.map((card: any, index: number) => ({
          name: card?.name || 'Unknown Card',
          lastFiveDigits: normalizeLastFiveDigits(card?.lastFiveDigits),
          closingDay: Math.min(31, Math.max(1, parseInt(card?.closingDay) || 15)),
          dueDay: Math.min(31, Math.max(1, parseInt(card?.dueDay) || 22)),
          color: cardColors[index % cardColors.length],
          currentBalance: parseFloat(card?.currentBalance) || 0,
          creditLimit: card?.creditLimit ? parseFloat(card.creditLimit) : undefined,
        }));

        const missingDigitsCount = parsedCards.filter((c) => c.lastFiveDigits === '00000').length;
        if (missingDigitsCount > 0) {
          toast({
            title: 'Some card digits could not be read',
            description:
              'We could not detect the last 5 digits for some cards, so they will be treated as new to avoid updating the wrong card.',
            variant: 'destructive',
          });
        }

        const newCardsList: ParsedCard[] = [];
        const matchedCardsList: MatchedCard[] = [];

        parsedCards.forEach((parsedCard) => {
          const existing = findExistingCard(parsedCard);
          if (existing) {
            matchedCardsList.push({
              existingCard: existing,
              newBalance: parsedCard.currentBalance,
            });
          } else {
            newCardsList.push(parsedCard);
          }
        });

        setNewCards(newCardsList);
        setMatchedCards(matchedCardsList);

        if (newCardsList.length === 0 && matchedCardsList.length === 0) {
          toast({
            title: 'No cards found',
            description: 'Could not detect any credit cards in the image.',
            variant: 'destructive',
          });
        }
      } else {
        toast({
          title: 'No cards found',
          description: 'Could not detect any credit cards in the image. Try a clearer screenshot.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      console.error('Error analyzing screenshot:', err);
      toast({
        title: 'Analysis failed',
        description: err instanceof Error ? err.message : 'Failed to analyze screenshot',
        variant: 'destructive',
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConfirm = () => {
    // Update existing cards
    if (matchedCards.length > 0) {
      const updates = matchedCards.map((m) => ({
        id: m.existingCard.id,
        currentBalance: m.newBalance,
      }));
      onCardsUpdated(updates);
    }

    // Add new cards
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
    setPreviewUrl(null);
    setNewCards([]);
    setMatchedCards([]);
    setIsAnalyzing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onOpenChange(false);
  };

  const totalCards = newCards.length + matchedCards.length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Screenshot</DialogTitle>
          <DialogDescription>
            Upload a screenshot to add new cards or update balances on existing ones.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Upload Area */}
          {!previewUrl && (
            <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-border rounded-xl cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <ImageIcon className="w-10 h-10 mb-3 text-muted-foreground" />
                <p className="mb-2 text-sm text-muted-foreground">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-muted-foreground">PNG, JPG or WEBP</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/*"
                onChange={handleFileSelect}
              />
            </label>
          )}

          {/* Preview */}
          {previewUrl && (
            <div className="relative">
              <img
                src={previewUrl}
                alt="Screenshot preview"
                className="w-full h-48 object-contain bg-muted rounded-xl"
              />
              {isAnalyzing && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
                    <p className="text-sm text-muted-foreground">Analyzing image...</p>
                  </div>
                </div>
              )}
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
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {newCards.map((card, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-success/10 border border-success/20 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-sm">{card.name}</p>
                      <p className="text-xs text-muted-foreground">
                        •••• {card.lastFiveDigits} | Due: {card.dueDay}th | Balance: ${
                          card.currentBalance?.toLocaleString()
                        }
                      </p>
                    </div>
                    <Check className="w-4 h-4 text-success" />
                  </div>
                ))}
              </div>
            </div>
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
                onClick={() => fileInputRef.current?.click()}
                disabled={isAnalyzing}
                className="flex-1"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    {previewUrl ? 'Try Another' : 'Upload'}
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
