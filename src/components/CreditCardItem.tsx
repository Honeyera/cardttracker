import { CreditCard, cardColorClasses } from '@/types/creditCard';
import { getDaysUntil, getNextOccurrence, formatDate, getUrgencyLevel } from '@/utils/dateUtils';
import { CreditCard as CreditCardIcon, Calendar, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CreditCardItemProps {
  card: CreditCard;
  onEdit: (card: CreditCard) => void;
  onDelete: (id: string) => void;
}

export function CreditCardItem({ card, onEdit, onDelete }: CreditCardItemProps) {
  const daysUntilDue = getDaysUntil(card.dueDay);
  const daysUntilClosing = getDaysUntil(card.closingDay);
  const dueDate = getNextOccurrence(card.dueDay);
  const closingDate = getNextOccurrence(card.closingDay);
  const dueUrgency = getUrgencyLevel(daysUntilDue);
  const closingUrgency = getUrgencyLevel(daysUntilClosing);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl p-6 text-primary-foreground bg-gradient-to-br shadow-lg transition-all duration-300 hover:shadow-xl hover:scale-[1.02] cursor-pointer',
        cardColorClasses[card.color]
      )}
      onClick={() => onEdit(card)}
    >
      {/* Card Pattern Overlay */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-4 right-4 w-24 h-24 rounded-full border-2 border-current" />
        <div className="absolute top-8 right-8 w-16 h-16 rounded-full border-2 border-current" />
      </div>

      {/* Card Content */}
      <div className="relative z-10">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold mb-1">{card.name}</h3>
            <p className="text-sm opacity-80">•••• {card.lastFiveDigits || '•••••'}</p>
          </div>
          <CreditCardIcon className="w-8 h-8 opacity-80" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <DateBadge
            label="Closing Date"
            date={closingDate}
            daysUntil={daysUntilClosing}
            urgency={closingUrgency}
          />
          <DateBadge
            label="Due Date"
            date={dueDate}
            daysUntil={daysUntilDue}
            urgency={dueUrgency}
          />
        </div>
      </div>
    </div>
  );
}

interface DateBadgeProps {
  label: string;
  date: Date;
  daysUntil: number;
  urgency: 'urgent' | 'warning' | 'normal';
}

function DateBadge({ label, date, daysUntil, urgency }: DateBadgeProps) {
  return (
    <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3">
      <div className="flex items-center gap-1.5 mb-1">
        {urgency === 'urgent' && (
          <AlertCircle className="w-3.5 h-3.5 text-red-300" />
        )}
        <span className="text-xs opacity-70">{label}</span>
      </div>
      <p className="text-sm font-medium">{formatDate(date)}</p>
      <p
        className={cn(
          'text-xs mt-0.5',
          urgency === 'urgent' && 'text-red-300 font-medium',
          urgency === 'warning' && 'text-amber-300 font-medium',
          urgency === 'normal' && 'opacity-70'
        )}
      >
        {daysUntil === 0 ? 'Today!' : `${daysUntil} days`}
      </p>
    </div>
  );
}
