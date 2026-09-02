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
import { CheckCircle, ImageIcon, Loader2, Plus, RefreshCw, Upload, X } from 'lucide-react';

interface UploadScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingCards: CreditCard[];
  onCardsFound: (newCards: Omit<CreditCard, 'id'>[]) => void;
  onCardsUpdated: (updates: { id: string; currentBalance: number; totalBalance?: number; paymentStatus?: string | null }[]) => void;
}

interface MatchedCard {
  existingCard: CreditCard;
  newBalance: number;
  newTotalBalance?: number;
  // null means the screenshot showed no payment-status text, so clear any stored status.
  newPaymentStatus?: string | null;
}

interface ParsedCard {
  name: string;
  lastFiveDigits: string;
  closingDay: number;
  dueDay: number;
  color: CardColor;
  currentBalance: number; // Remaining statement balance
  totalBalance?: number; // Total balance on card
  creditLimit?: number;
  paymentStatus?: string;
}

const cardColors: CardColor[] = ['navy', 'teal', 'slate', 'ocean', 'gold', 'rose', 'purple', 'emerald'];

function normalizeLastFiveDigits(value: unknown): string {
  // Handles values like: 81008, "81008", "•••• 81008", "x81008\n", etc.
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '');
  const digitsOnly = raw.replace(/\D/g, '');
  if (!digitsOnly) return '00000';
  return digitsOnly.slice(-5).padStart(5, '0');
}

// Parse a numeric balance, preserving 0 as a valid value.
// Returns undefined only when the value is truly missing/unparseable.
function parseBalance(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function UploadScreenshotDialog({
  open,
  onOpenChange,
  existingCards,
  onCardsFound,
  onCardsUpdated,
}: UploadScreenshotDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzingProgress, setAnalyzingProgress] = useState<{ done: number; total: number } | null>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [newCards, setNewCards] = useState<ParsedCard[]>([]);
  const [matchedCards, setMatchedCards] = useState<MatchedCard[]>([]);
  const [unchangedCount, setUnchangedCount] = useState(0);
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

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target?.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset the input immediately so the same file can be re-selected later if needed
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (files.length === 0) return;

    setIsAnalyzing(true);
    setAnalyzingProgress({ done: 0, total: files.length });

    let totalDetected = 0;
    let missingDigitsAcrossBatch = 0;

    for (let i = 0; i < files.length; i++) {
      try {
        const base64 = await readFileAsDataUrl(files[i]);
        setPreviewUrls((prev) => [...prev, base64]);
        const result = await analyzeImage(base64);
        totalDetected += result.parsedCount;
        missingDigitsAcrossBatch += result.missingDigitsCount;
      } catch (err) {
        console.error('Error processing file:', err);
        toast({
          title: `Failed to analyze ${files[i].name}`,
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setAnalyzingProgress((p) => (p ? { done: p.done + 1, total: p.total } : null));
      }
    }

    setIsAnalyzing(false);
    setAnalyzingProgress(null);

    if (missingDigitsAcrossBatch > 0) {
      toast({
        title: 'Some card digits could not be read',
        description:
          'We could not detect the last 5 digits for some cards, so they will be treated as new to avoid updating the wrong card.',
        variant: 'destructive',
      });
    }

    if (totalDetected === 0) {
      toast({
        title: 'No cards found',
        description: 'Could not detect any credit cards in the uploaded screenshots.',
        variant: 'destructive',
      });
    }
  };

  // Analyzes one screenshot and merges its results into the running state.
  // Returns counts for the caller to aggregate toasts across the batch.
  const analyzeImage = async (
    imageBase64: string,
  ): Promise<{ parsedCount: number; missingDigitsCount: number }> => {
    const { data, error } = await supabase.functions.invoke('analyze-screenshot', {
      body: { imageBase64 },
    });

    if (error) {
      let errorMessage = error.message;
      if ('context' in error && error.context instanceof Response) {
        try {
          const body = await error.context.json();
          errorMessage = body?.error || errorMessage;
        } catch {
          // Fall back to generic message
        }
      }
      throw new Error(errorMessage);
    }
    if (data?.error) throw new Error(data.error);

    if (!data?.cards || data.cards.length === 0) {
      return { parsedCount: 0, missingDigitsCount: 0 };
    }

    const parsedCards: ParsedCard[] = data.cards.map((card: any, index: number) => {
      const remaining = parseBalance(card?.remainingStatementBalance);
      const fallbackCurrent = parseBalance(card?.currentBalance);
      const total = parseBalance(card?.totalBalance);
      return {
        name: card?.name || 'Unknown Card',
        lastFiveDigits: normalizeLastFiveDigits(card?.lastFiveDigits),
        closingDay: Math.min(31, Math.max(1, parseInt(card?.closingDay) || 15)),
        dueDay: Math.min(31, Math.max(1, parseInt(card?.dueDay) || 22)),
        color: cardColors[index % cardColors.length],
        currentBalance: remaining ?? fallbackCurrent ?? 0,
        totalBalance: total,
        creditLimit: parseBalance(card?.creditLimit),
        paymentStatus: card?.paymentStatus || undefined,
      };
    });

    const missingDigitsCount = parsedCards.filter((c) => c.lastFiveDigits === '00000').length;

    const newFromThis: ParsedCard[] = [];
    const matchedFromThis: MatchedCard[] = [];
    let unchangedDelta = 0;

    parsedCards.forEach((parsedCard) => {
      const existing = findExistingCard(parsedCard);
      if (existing) {
        const existingBalance = existing.currentBalance ?? 0;
        const newBalance = parsedCard.currentBalance ?? 0;
        const balanceChanged = Math.abs(existingBalance - newBalance) >= 0.01;
        const totalChanged =
          parsedCard.totalBalance !== undefined &&
          Math.abs((existing.totalBalance ?? 0) - parsedCard.totalBalance) >= 0.01;
        const statusChanged = parsedCard.paymentStatus !== existing.paymentStatus;

        if (balanceChanged || totalChanged || statusChanged) {
          matchedFromThis.push({
            existingCard: existing,
            newBalance: parsedCard.currentBalance,
            newTotalBalance: parsedCard.totalBalance,
            // Fall back to null (not undefined) so updateCard actively clears a
            // stale "Payment not required" when the new screenshot omits it.
            newPaymentStatus: parsedCard.paymentStatus ?? null,
          });
        } else {
          unchangedDelta++;
        }
      } else {
        newFromThis.push(parsedCard);
      }
    });

    // Merge matched: last-uploaded value wins for any existing card seen twice.
    setMatchedCards((prev) => {
      const byId = new Map(prev.map((m) => [m.existingCard.id, m]));
      matchedFromThis.forEach((m) => byId.set(m.existingCard.id, m));
      return Array.from(byId.values());
    });

    // Merge new: dedupe by digits+name so the same unknown card across
    // screenshots only appears once.
    setNewCards((prev) => {
      const seen = new Set(prev.map((c) => `${c.lastFiveDigits}|${c.name.toLowerCase()}`));
      const additions = newFromThis.filter(
        (c) => !seen.has(`${c.lastFiveDigits}|${c.name.toLowerCase()}`),
      );
      return [...prev, ...additions];
    });

    setUnchangedCount((prev) => prev + unchangedDelta);

    return { parsedCount: parsedCards.length, missingDigitsCount };
  };

  const handleConfirm = () => {
    // Update existing cards
    if (matchedCards.length > 0) {
      const updates = matchedCards.map((m) => ({
        id: m.existingCard.id,
        currentBalance: m.newBalance,
        totalBalance: m.newTotalBalance,
        paymentStatus: m.newPaymentStatus,
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
    setPreviewUrls([]);
    setNewCards([]);
    setMatchedCards([]);
    setUnchangedCount(0);
    setIsAnalyzing(false);
    setAnalyzingProgress(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onOpenChange(false);
  };

  const totalCards = newCards.length + matchedCards.length;
  const hasPreviews = previewUrls.length > 0;

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
          {/* Hidden file input — supports multi-select */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
          />

          {/* Upload prompt (only before any screenshots are added) */}
          {!hasPreviews && (
            <label
              className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-border rounded-xl cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={(e) => {
                e.preventDefault();
                fileInputRef.current?.click();
              }}
            >
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <ImageIcon className="w-10 h-10 mb-3 text-muted-foreground" />
                <p className="mb-2 text-sm text-muted-foreground">
                  <span className="font-semibold">Click to upload</span> one or more screenshots
                </p>
                <p className="text-xs text-muted-foreground">PNG, JPG or WEBP — select multiple at once</p>
              </div>
            </label>
          )}

          {/* Thumbnail grid of uploaded screenshots */}
          {hasPreviews && (
            <div className="relative">
              <div className="grid grid-cols-3 gap-2">
                {previewUrls.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt={`Screenshot ${i + 1}`}
                    className="w-full h-24 object-cover bg-muted rounded-lg border border-border"
                  />
                ))}
                {!isAnalyzing && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-border rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                    title="Add more screenshots"
                  >
                    <Plus className="w-5 h-5 mb-1" />
                    <span className="text-xs">Add more</span>
                  </button>
                )}
              </div>

              {isAnalyzing && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
                    <p className="text-sm text-muted-foreground">
                      {analyzingProgress
                        ? `Analyzing image (${analyzingProgress.done}/${analyzingProgress.total})...`
                        : 'Analyzing image...'}
                    </p>
                  </div>
                </div>
              )}
              {/* No Changes Overlay - shown when nothing to update */}
              {!isAnalyzing && unchangedCount > 0 && newCards.length === 0 && matchedCards.length === 0 && (
                <div className="absolute inset-0 bg-background/90 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <div className="text-center px-4">
                    <CheckCircle className="w-12 h-12 mx-auto mb-3 text-primary" />
                    <p className="text-lg font-semibold text-foreground">All up to date!</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {unchangedCount} card{unchangedCount > 1 ? 's' : ''} found — balances unchanged.
                    </p>
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
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {matchedCards.map((match, index) => {
                  const oldStatement = match.existingCard.currentBalance ?? 0;
                  const oldTotal = match.existingCard.totalBalance ?? 0;
                  const totalProvided = match.newTotalBalance !== undefined;
                  const fmt = (n: number) =>
                    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                  return (
                    <div
                      key={index}
                      className="p-3 bg-accent/10 border border-accent/20 rounded-lg"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="min-w-0">
                          <p className="font-medium text-sm">{match.existingCard.name}</p>
                          <p className="text-xs text-muted-foreground">
                            •••• {match.existingCard.lastFiveDigits}
                          </p>
                        </div>
                        <RefreshCw className="w-4 h-4 text-accent flex-shrink-0 ml-2" />
                      </div>
                      <div className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-xs">
                        <span className="text-muted-foreground"></span>
                        <span className="text-muted-foreground font-medium">Previous</span>
                        <span className="text-muted-foreground font-medium">New</span>

                        <span className="text-muted-foreground">Statement</span>
                        <span className="text-foreground">{fmt(oldStatement)}</span>
                        <span className="text-foreground font-medium">{fmt(match.newBalance)}</span>

                        <span className="text-muted-foreground">Total</span>
                        <span className="text-foreground">{fmt(oldTotal)}</span>
                        <span className="text-foreground font-medium">
                          {totalProvided ? (
                            fmt(match.newTotalBalance ?? 0)
                          ) : (
                            <span className="italic text-muted-foreground">not read</span>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
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
                        •••• {card.lastFiveDigits} | Due: {card.dueDay}th
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Statement: ${card.currentBalance.toLocaleString()}
                        {' | '}
                        Total: {card.totalBalance !== undefined
                          ? `$${card.totalBalance.toLocaleString()}`
                          : <span className="italic">not read</span>}
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


          {/* Unchanged count info when there are other changes */}
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
                    {hasPreviews ? 'Add More' : 'Upload'}
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
