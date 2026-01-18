import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CreditCard, CardColor, cardColorClasses } from '@/types/creditCard';
import { cn } from '@/lib/utils';
import { Trash2 } from 'lucide-react';

interface AddCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (card: Omit<CreditCard, 'id'>) => void;
  onUpdate?: (id: string, card: Partial<CreditCard>) => void;
  onDelete?: (id: string) => void;
  editCard?: CreditCard | null;
}

const colorOptions: { value: CardColor; label: string }[] = [
  { value: 'navy', label: 'Navy' },
  { value: 'teal', label: 'Teal' },
  { value: 'slate', label: 'Slate' },
  { value: 'ocean', label: 'Ocean' },
];

export function AddCardDialog({
  open,
  onOpenChange,
  onSave,
  onUpdate,
  onDelete,
  editCard,
}: AddCardDialogProps) {
  const [name, setName] = useState('');
  const [lastFiveDigits, setLastFiveDigits] = useState('');
  const [closingDay, setClosingDay] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [color, setColor] = useState<CardColor>('navy');
  const [creditLimit, setCreditLimit] = useState('');
  const [currentBalance, setCurrentBalance] = useState('');

  useEffect(() => {
    if (editCard) {
      setName(editCard.name);
      setLastFiveDigits(editCard.lastFiveDigits || '');
      setClosingDay(editCard.closingDay.toString());
      setDueDay(editCard.dueDay.toString());
      setColor(editCard.color);
      setCreditLimit(editCard.creditLimit?.toString() || '');
      setCurrentBalance(editCard.currentBalance?.toString() || '');
    } else {
      resetForm();
    }
  }, [editCard, open]);

  const resetForm = () => {
    setName('');
    setLastFiveDigits('');
    setClosingDay('');
    setDueDay('');
    setColor('navy');
    setCreditLimit('');
    setCurrentBalance('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const cardData = {
      name,
      lastFiveDigits,
      closingDay: parseInt(closingDay),
      dueDay: parseInt(dueDay),
      color,
      creditLimit: creditLimit ? parseFloat(creditLimit) : undefined,
      currentBalance: currentBalance ? parseFloat(currentBalance) : undefined,
    };

    if (editCard && onUpdate) {
      onUpdate(editCard.id, cardData);
    } else {
      onSave(cardData);
    }

    onOpenChange(false);
    resetForm();
  };

  const handleDelete = () => {
    if (editCard && onDelete) {
      onDelete(editCard.id);
      onOpenChange(false);
      resetForm();
    }
  };

  const isValid =
    name &&
    lastFiveDigits.length === 5 &&
    closingDay &&
    dueDay &&
    parseInt(closingDay) >= 1 &&
    parseInt(closingDay) <= 31 &&
    parseInt(dueDay) >= 1 &&
    parseInt(dueDay) <= 31;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editCard ? 'Edit Credit Card' : 'Add Credit Card'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Card Name</Label>
            <Input
              id="name"
              placeholder="e.g., Chase Sapphire"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="digits">Last 5 Digits</Label>
            <Input
              id="digits"
              placeholder="12345"
              maxLength={5}
              value={lastFiveDigits}
              onChange={(e) =>
                setLastFiveDigits(e.target.value.replace(/\D/g, ''))
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="closing">Closing Day</Label>
              <Input
                id="closing"
                type="number"
                min={1}
                max={31}
                placeholder="15"
                value={closingDay}
                onChange={(e) => setClosingDay(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="due">Due Day</Label>
              <Input
                id="due"
                type="number"
                min={1}
                max={31}
                placeholder="22"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="balance">Current Balance</Label>
              <Input
                id="balance"
                type="number"
                step="0.01"
                placeholder="0.00"
                value={currentBalance}
                onChange={(e) => setCurrentBalance(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="limit">Credit Limit</Label>
              <Input
                id="limit"
                type="number"
                placeholder="10000"
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Card Color</Label>
            <div className="flex gap-2">
              {colorOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setColor(option.value)}
                  className={cn(
                    'w-10 h-10 rounded-lg bg-gradient-to-br transition-all',
                    cardColorClasses[option.value],
                    color === option.value
                      ? 'ring-2 ring-offset-2 ring-primary scale-110'
                      : 'opacity-70 hover:opacity-100'
                  )}
                  title={option.label}
                />
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-4">
            {editCard && onDelete && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                onClick={handleDelete}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
            <Button type="submit" className="flex-1" disabled={!isValid}>
              {editCard ? 'Save Changes' : 'Add Card'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
