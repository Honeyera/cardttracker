import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, Loader2, ImageIcon, Check, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { CreditCard, CardColor } from '@/types/creditCard';
import { useToast } from '@/hooks/use-toast';

interface UploadScreenshotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCardsFound: (cards: Omit<CreditCard, 'id'>[]) => void;
}

const cardColors: CardColor[] = ['navy', 'teal', 'slate', 'ocean'];

export function UploadScreenshotDialog({
  open,
  onOpenChange,
  onCardsFound,
}: UploadScreenshotDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [foundCards, setFoundCards] = useState<Omit<CreditCard, 'id'>[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Create preview
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
    setFoundCards(null);

    try {
      const { data, error } = await supabase.functions.invoke('analyze-screenshot', {
        body: { imageBase64 },
      });

      if (error) {
        throw new Error(error.message);
      }

      if (data.error) {
        throw new Error(data.error);
      }

      if (data.cards && data.cards.length > 0) {
        // Assign colors to cards
        const cardsWithColors = data.cards.map((card: any, index: number) => ({
          name: card.name || 'Unknown Card',
          lastFiveDigits: String(card.lastFiveDigits || '00000').slice(-5).padStart(5, '0'),
          closingDay: Math.min(31, Math.max(1, parseInt(card.closingDay) || 15)),
          dueDay: Math.min(31, Math.max(1, parseInt(card.dueDay) || 22)),
          color: cardColors[index % cardColors.length],
          currentBalance: parseFloat(card.currentBalance) || 0,
          creditLimit: card.creditLimit ? parseFloat(card.creditLimit) : undefined,
        }));
        setFoundCards(cardsWithColors);
      } else {
        toast({
          title: 'No cards found',
          description: 'Could not detect any credit cards in the image. Try a clearer screenshot.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error analyzing screenshot:', error);
      toast({
        title: 'Analysis failed',
        description: error instanceof Error ? error.message : 'Failed to analyze screenshot',
        variant: 'destructive',
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConfirm = () => {
    if (foundCards) {
      onCardsFound(foundCards);
      toast({
        title: 'Cards added!',
        description: `Successfully added ${foundCards.length} card${foundCards.length > 1 ? 's' : ''}.`,
      });
      handleClose();
    }
  };

  const handleClose = () => {
    setPreviewUrl(null);
    setFoundCards(null);
    setIsAnalyzing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Screenshot</DialogTitle>
          <DialogDescription>
            Upload a screenshot of your credit cards or statements to automatically add them.
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

          {/* Found Cards */}
          {foundCards && foundCards.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                Found {foundCards.length} card{foundCards.length > 1 ? 's' : ''}:
              </p>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {foundCards.map((card, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-muted rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-sm">{card.name}</p>
                      <p className="text-xs text-muted-foreground">
                        •••• {card.lastFiveDigits} | Due: {card.dueDay}th | Balance: ${card.currentBalance?.toLocaleString()}
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
            {foundCards && foundCards.length > 0 ? (
              <Button onClick={handleConfirm} className="flex-1">
                Add {foundCards.length} Card{foundCards.length > 1 ? 's' : ''}
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
