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
        'relative overflow-hidden rounded-xl p-4 text-primary-foreground bg-gradient-to-br shadow-md transition-all duration-300 hover:shadow-lg hover:scale-[1.02] cursor-pointer',
        cardColorClasses[card.color]
      )}
      onClick={() => onEdit(card)}
    >
      {/* Card Pattern Overlay */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-3 right-3 w-16 h-16 rounded-full border-2 border-current" />
        <div className="absolute top-6 right-6 w-10 h-10 rounded-full border-2 border-current" />
      </div>

      {/* Card Content */}
      <div className="relative z-10">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold mb-0.5">{card.name}</h3>
            {card.companyName && (
              <p className="text-xs opacity-90 mb-0.5">{card.companyName}</p>
            )}
            {card.ownerName && (
              <p className="text-xs opacity-80 mb-0.5">{card.ownerName}</p>
            )}
            <p className="text-xs opacity-70">•••• {card.lastFiveDigits || '•••••'}</p>
          </div>
          <CreditCardIcon className="w-6 h-6 opacity-80" />
        </div>

        {/* Balance */}
        <div className="mb-3">
          <p className="text-xs opacity-70 mb-0.5">Current Balance</p>
          <p className="text-xl font-bold">
            ${(card.currentBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
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
    <div className="bg-blue-500/30 backdrop-blur-sm rounded-lg p-2">
      <div className="flex items-center gap-1 mb-0.5">
        {urgency === 'urgent' && (
          <AlertCircle className="w-3 h-3 text-red-300" />
        )}
        <span className="text-[10px] opacity-70">{label}</span>
      </div>
      <p className="text-xs font-medium">{formatDate(date)}</p>
      <p
        className={cn(
          'text-[10px] mt-0.5',
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
