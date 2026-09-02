import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NewPointEntry } from '@/hooks/useCreditCardPoints';
import { CreditCard } from '@/types/creditCard';

const PEOPLE = ['Tomer', 'Leo'] as const;

interface AddPointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (entry: NewPointEntry) => void;
  cards: CreditCard[];
  availablePoints?: { card_id: string; available_points: number }[];
}

export function AddPointDialog({
  open,
  onOpenChange,
  onSave,
  cards,
  availablePoints = [],
}: AddPointDialogProps) {
  const [person, setPerson] = useState<string>('Tomer');
  const [cardId, setCardId] = useState('');
  const [pointsRedeemed, setPointsRedeemed] = useState('');
  const [redemptionDate, setRedemptionDate] = useState('');
  const [notes, setNotes] = useState('');

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  useEffect(() => {
    resetForm();
  }, [open]);

  const resetForm = () => {
    setPerson('Tomer');
    setCardId('');
    setPointsRedeemed('');
    setRedemptionDate(today);
    setNotes('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    const selectedCard = cards.find((c) => c.id === cardId);
    if (!selectedCard) return;

    const entry: NewPointEntry = {
      person,
      card_id: selectedCard.id,
      card_name: selectedCard.name,
      points_redeemed: parseInt(pointsRedeemed) || 0,
      redemption_date: redemptionDate || null,
      notes: notes.trim() || null,
    };

    onSave(entry);

    onOpenChange(false);
    resetForm();
  };

  const selectedCardPoints = useMemo(() => {
    if (!cardId) return null;
    const entry = availablePoints.find((ap) => ap.card_id === cardId);
    return entry?.available_points ?? null;
  }, [cardId, availablePoints]);

  const enteredPoints = parseInt(pointsRedeemed) || 0;
  const exceedsAvailable = selectedCardPoints !== null && enteredPoints > selectedCardPoints && enteredPoints > 0;

  const isValid = person && cardId && pointsRedeemed && enteredPoints > 0 && !exceedsAvailable;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Points Entry</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="person">Person</Label>
            <Select value={person} onValueChange={setPerson}>
              <SelectTrigger id="person">
                <SelectValue placeholder="Select person" />
              </SelectTrigger>
              <SelectContent>
                {PEOPLE.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cardName">Card</Label>
            <Select value={cardId} onValueChange={setCardId}>
              <SelectTrigger id="cardName">
                <SelectValue placeholder="Select a card" />
              </SelectTrigger>
              <SelectContent>
                {cards.map((card) => (
                  <SelectItem key={card.id} value={card.id}>
                    <span className="font-medium">{card.name}</span>
                    <span className="text-muted-foreground ml-2 font-mono text-xs">
                      •••• {card.lastFiveDigits}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedCardPoints !== null && (
            <p className="text-xs text-muted-foreground -mt-1">
              Available:{' '}
              <span className="font-semibold text-primary">
                {selectedCardPoints.toLocaleString()} pts
              </span>
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="points">Points Redeemed</Label>
            <Input
              id="points"
              type="number"
              min={1}
              placeholder="e.g., 50000"
              value={pointsRedeemed}
              onChange={(e) => setPointsRedeemed(e.target.value)}
              className={exceedsAvailable ? 'border-destructive focus-visible:ring-destructive' : ''}
            />
            {exceedsAvailable && (
              <p className="text-xs text-destructive">
                Exceeds available balance by {(enteredPoints - selectedCardPoints!).toLocaleString()} pts
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="date">Redemption Date</Label>
            <Input
              id="date"
              type="date"
              value={redemptionDate}
              onChange={(e) => setRedemptionDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              rows={2}
              placeholder="Optional notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={!isValid}>
              Add Entry
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
