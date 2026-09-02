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
import { CreditCard } from '@/types/creditCard';
import { AlertTriangle, CheckCircle, ImageIcon, Loader2, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

interface ParsedPointsCard {
  name: string;
  lastFiveDigits: string;
  availablePoints: number;
}

interface MatchedPointsCard {
  existingCard: CreditCard;
  oldPoints: number;
  newPoints: number;
}

interface UnmatchedPointsCard extends ParsedPointsCard {
  // Stable key so React can dedupe across multiple uploads
  key: string;
}

interface UploadPointsScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingCards: CreditCard[];
  currentAvailablePoints: { card_id: string; available_points: number }[];
  // Redemptions the user has logged in Points History.
  pointsLog: { card_id: string | null; card_name: string; points_redeemed: number }[];
  onUpdatePoints: (cardId: string, points: number) => Promise<void>;
}

function normalizeDigits(value: unknown): string {
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '');
  const digitsOnly = raw.replace(/\D/g, '');
  if (!digitsOnly) return '00000';
  return digitsOnly.slice(-5).padStart(5, '0');
}

export function UploadPointsScreenshotDialog({
  open,
  onOpenChange,
  existingCards,
  currentAvailablePoints,
  pointsLog,
  onUpdatePoints,
}: UploadPointsScreenshotDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzingProgress, setAnalyzingProgress] = useState<{ done: number; total: number } | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [matched, setMatched] = useState<MatchedPointsCard[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedPointsCard[]>([]);
  const [unchangedCount, setUnchangedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const findCard = (parsed: ParsedPointsCard): CreditCard | null => {
    const digits = normalizeDigits(parsed.lastFiveDigits);
    if (digits !== '00000') {
      const byDigits = existingCards.find(
        (c) => normalizeDigits(c.lastFiveDigits) === digits
      );
      if (byDigits) return byDigits;
    }
    // Fallback: fuzzy name match
    const nameLower = parsed.name.toLowerCase();
    return existingCards.find((c) => c.name.toLowerCase().includes(nameLower) || nameLower.includes(c.name.toLowerCase())) ?? null;
  };

  // A screenshot showing fewer points than we have stored is only worth
  // warning about if there's no record of where the points went. If the user
  // logged redemptions for this card in Points History (who took them, when),
  // the drop is accounted for — don't cry "untracked".
  const reconcileDrop = (card: CreditCard, oldPts: number, newPts: number) => {
    const drop = oldPts - newPts;
    if (drop <= 0) return { tracked: false, unexplained: 0, covered: 0 };

    // Total redemptions recorded in Points History for this exact card. Match
    // by card_id only — several cards share the name "Business Gold Card", so
    // a name fallback would wrongly pool redemptions across all of them.
    const totalLogged = pointsLog
      .filter((e) => e.card_id === card.id)
      .reduce((s, e) => s + (e.points_redeemed || 0), 0);

    const covered = Math.min(drop, totalLogged);
    const unexplained = drop - covered;
    // Allow a little slack for posted amounts differing from round logged figures.
    const tolerance = Math.max(100, Math.round(drop * 0.02));
    return { tracked: unexplained <= tolerance, unexplained, covered };
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

    let totalParsedCards = 0;
    let totalErrors = 0;

    for (let i = 0; i < files.length; i++) {
      try {
        const base64 = await readFileAsDataUrl(files[i]);
        setPreviewUrls((prev) => [...prev, base64]);
        const parsedCount = await analyzeImage(base64);
        totalParsedCards += parsedCount;
      } catch (err) {
        totalErrors++;
        console.error('Error processing file:', err);
        toast.error(`Failed to analyze ${files[i].name}`, {
          description: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        setAnalyzingProgress((p) => (p ? { done: p.done + 1, total: p.total } : null));
      }
    }

    setIsAnalyzing(false);
    setAnalyzingProgress(null);

    if (totalParsedCards === 0 && totalErrors === 0) {
      toast.error('No points data found', {
        description: 'Could not detect any reward points in the uploaded screenshots.',
      });
    }
  };

  // Analyzes one screenshot and merges its results into the running state.
  // Returns the number of cards parsed (regardless of match status).
  const analyzeImage = async (imageBase64: string): Promise<number> => {
    const { data, error } = await supabase.functions.invoke('analyze-points-screenshot', {
      body: { imageBase64 },
    });

    if (error) {
      let msg = error.message;
      if ('context' in error && error.context instanceof Response) {
        try { const b = await error.context.json(); msg = b?.error || msg; } catch {}
      }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);

    const cards: ParsedPointsCard[] = (data?.cards || []).map((c: any) => ({
      name: c?.name || 'Unknown Card',
      lastFiveDigits: normalizeDigits(c?.lastFiveDigits),
      availablePoints: Math.round(parseFloat(c?.availablePoints) || 0),
    }));

    if (cards.length === 0) return 0;

    // Build incremental changes from this screenshot
    const newMatches: MatchedPointsCard[] = [];
    const newUnmatched: UnmatchedPointsCard[] = [];
    let unchangedDelta = 0;

    cards.forEach((parsed, idx) => {
      const card = findCard(parsed);
      if (card) {
        const existing = currentAvailablePoints.find((ap) => ap.card_id === card.id);
        const oldPts = existing?.available_points ?? 0;
        if (oldPts !== parsed.availablePoints) {
          newMatches.push({ existingCard: card, oldPoints: oldPts, newPoints: parsed.availablePoints });
        } else {
          unchangedDelta++;
        }
      } else {
        newUnmatched.push({
          ...parsed,
          key: `${Date.now()}-${idx}-${parsed.lastFiveDigits}-${parsed.name}`,
        });
      }
    });

    // Merge matches: last-uploaded value wins for any card seen twice.
    setMatched((prev) => {
      const byId = new Map(prev.map((m) => [m.existingCard.id, m]));
      newMatches.forEach((m) => byId.set(m.existingCard.id, m));
      return Array.from(byId.values());
    });

    // Merge unmatched: dedupe by digits+name so the same card across screenshots
    // only appears once.
    setUnmatched((prev) => {
      const seen = new Set(prev.map((u) => `${u.lastFiveDigits}|${u.name.toLowerCase()}`));
      const additions = newUnmatched.filter(
        (u) => !seen.has(`${u.lastFiveDigits}|${u.name.toLowerCase()}`)
      );
      return [...prev, ...additions];
    });

    setUnchangedCount((prev) => prev + unchangedDelta);
    return cards.length;
  };

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      await Promise.all(matched.map((m) => onUpdatePoints(m.existingCard.id, m.newPoints)));
      toast.success(`Updated ${matched.length} card${matched.length > 1 ? 's' : ''}`);
      handleClose();
    } finally {
      setIsConfirming(false);
    }
  };

  const handleClose = () => {
    setPreviewUrls([]);
    setMatched([]);
    setUnmatched([]);
    setUnchangedCount(0);
    setIsAnalyzing(false);
    setAnalyzingProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    onOpenChange(false);
  };

  const hasPreviews = previewUrls.length > 0;
  const allUpToDate = !isAnalyzing && hasPreviews && matched.length === 0 && unchangedCount > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Points Screenshot</DialogTitle>
          <DialogDescription>
            Upload a screenshot showing reward point balances — we'll match them to your cards and update the totals.
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
                        ? `Reading points (${analyzingProgress.done}/${analyzingProgress.total})...`
                        : 'Reading points...'}
                    </p>
                  </div>
                </div>
              )}
              {allUpToDate && (
                <div className="absolute inset-0 bg-background/90 backdrop-blur-sm rounded-xl flex items-center justify-center">
                  <div className="text-center px-4">
                    <CheckCircle className="w-12 h-12 mx-auto mb-3 text-primary" />
                    <p className="text-lg font-semibold text-foreground">All up to date!</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {unchangedCount} card{unchangedCount > 1 ? 's' : ''} found — points unchanged.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Matched cards — will be updated */}
          {matched.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-primary" />
                Updating {matched.length} card{matched.length > 1 ? 's' : ''}:
              </p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {matched.map((m, i) => {
                  const isDrop = m.newPoints < m.oldPoints;
                  const recon = isDrop
                    ? reconcileDrop(m.existingCard, m.oldPoints, m.newPoints)
                    : { tracked: false, unexplained: 0, covered: 0 };
                  const untracked = isDrop && !recon.tracked;
                  const trackedDrop = isDrop && recon.tracked;
                  return (
                    <div
                      key={i}
                      className={`flex items-center justify-between p-3 rounded-lg border ${
                        untracked
                          ? 'bg-destructive/5 border-destructive/30'
                          : 'bg-primary/5 border-primary/20'
                      }`}
                    >
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-sm">{m.existingCard.name}</p>
                          {untracked && (
                            <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                          )}
                          {trackedDrop && (
                            <CheckCircle className="w-3.5 h-3.5 text-primary" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono">
                          •••• {m.existingCard.lastFiveDigits}
                        </p>
                        {untracked && (
                          <p className="text-xs text-destructive font-medium mt-0.5">
                            {recon.covered > 0
                              ? `${recon.unexplained.toLocaleString()} pts dropped with no matching redemption logged`
                              : 'Points taken without tracking'}
                          </p>
                        )}
                        {trackedDrop && (
                          <p className="text-xs text-primary font-medium mt-0.5">
                            Matches a logged redemption
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground line-through">
                          {m.oldPoints.toLocaleString()} pts
                        </p>
                        <p className={`text-sm font-bold ${untracked ? 'text-destructive' : 'text-primary'}`}>
                          {m.newPoints.toLocaleString()} pts
                        </p>
                        {isDrop && (
                          <p className={`text-xs ${untracked ? 'text-destructive' : 'text-muted-foreground'}`}>
                            −{(m.oldPoints - m.newPoints).toLocaleString()} pts
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Unmatched cards — couldn't identify */}
          {unmatched.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <X className="w-4 h-4" />
                {unmatched.length} card{unmatched.length > 1 ? 's' : ''} not recognised:
              </p>
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {unmatched.map((c) => (
                  <div key={c.key} className="px-3 py-2 bg-muted rounded-lg text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{c.name}</span>
                    {c.lastFiveDigits !== '00000' && (
                      <span className="font-mono ml-2">•••• {c.lastFiveDigits}</span>
                    )}
                    <span className="ml-2">{c.availablePoints.toLocaleString()} pts</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Make sure these cards are added to your dashboard first.
              </p>
            </div>
          )}

          {unchangedCount > 0 && matched.length > 0 && (
            <p className="text-xs text-muted-foreground text-center">
              {unchangedCount} card{unchangedCount > 1 ? 's' : ''} skipped (points unchanged)
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={handleClose} className="flex-1">
              Cancel
            </Button>
            {matched.length > 0 ? (
              <Button onClick={handleConfirm} className="flex-1" disabled={isConfirming}>
                {isConfirming ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</>
                ) : (
                  `Update ${matched.length} Card${matched.length > 1 ? 's' : ''}`
                )}
              </Button>
            ) : (
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={isAnalyzing}
                className="flex-1"
              >
                {isAnalyzing ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Analyzing...</>
                ) : (
                  <><Upload className="w-4 h-4 mr-2" />{hasPreviews ? 'Add More' : 'Upload'}</>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
