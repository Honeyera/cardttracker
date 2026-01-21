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

        {/* Balance or Payment Status */}
        <div className="mb-3">
          {card.paymentStatus ? (
            <>
              <p className="text-xs opacity-70 mb-0.5">Payment Status</p>
              <p className="text-sm font-semibold text-emerald-200 bg-emerald-500/30 rounded-lg px-2 py-1 inline-block">
                ✓ {card.paymentStatus}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs opacity-70 mb-0.5">Current Balance</p>
              <p className="text-xl font-bold">
                ${(card.currentBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </>
          )}
        </div>

        {/* Wait to Purchase Indicator */}
        {closingUrgency !== 'normal' && (
          <div className="flex items-center justify-center gap-2 bg-amber-500 rounded-lg px-3 py-2 mb-3 shadow-lg animate-pulse">
            <AlertCircle className="w-4 h-4 text-amber-950" />
            <span className="text-xs font-bold text-amber-950">
              Closing soon — consider waiting to purchase
            </span>
          </div>
        )}

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
            highlightOnUrgent={true}
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
  highlightOnUrgent?: boolean;
}

function DateBadge({ label, date, daysUntil, urgency, highlightOnUrgent = false }: DateBadgeProps) {
  const shouldHighlight = highlightOnUrgent && urgency !== 'normal';
  
  return (
    <div className={cn(
      'backdrop-blur-sm rounded-lg p-2 transition-all',
      shouldHighlight && urgency === 'urgent' && 'bg-red-500 shadow-lg',
      shouldHighlight && urgency === 'warning' && 'bg-orange-500 shadow-md',
      !shouldHighlight && 'bg-blue-500/30'
    )}>
      <div className="flex items-center gap-1 mb-0.5">
        {urgency === 'urgent' && (
          <AlertCircle className={cn('w-3 h-3', shouldHighlight ? 'text-white' : 'text-red-300')} />
        )}
        {urgency === 'warning' && shouldHighlight && (
          <AlertCircle className="w-3 h-3 text-white" />
        )}
        <span className={cn('text-[10px]', shouldHighlight ? 'text-white/90 font-medium' : 'opacity-70')}>{label}</span>
      </div>
      <p className={cn('text-xs font-medium', shouldHighlight && 'text-white')}>{formatDate(date)}</p>
      <p
        className={cn(
          'text-[10px] mt-0.5',
          shouldHighlight && 'text-white font-bold',
          !shouldHighlight && urgency === 'urgent' && 'text-red-300 font-medium',
          !shouldHighlight && urgency === 'warning' && 'text-amber-300 font-medium',
          !shouldHighlight && urgency === 'normal' && 'opacity-70'
        )}
      >
        {daysUntil === 0 ? 'Today!' : `${daysUntil} days`}
      </p>
    </div>
  );
}
