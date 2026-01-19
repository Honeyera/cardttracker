import { CreditCard } from '@/types/creditCard';
import { getDaysUntil, getNextOccurrence, formatDate, getUrgencyLevel } from '@/utils/dateUtils';
import { Calendar, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UpcomingDatesProps {
  cards: CreditCard[];
}

interface DateEvent {
  cardName: string;
  companyName?: string;
  ownerName?: string;
  lastFiveDigits: string;
  currentBalance?: number;
  type: 'closing' | 'due';
  date: Date;
  daysUntil: number;
  closingDate: Date;
  dueDate: Date;
  daysUntilClosing: number;
  daysUntilDue: number;
}

export function UpcomingDates({ cards }: UpcomingDatesProps) {
  const events: DateEvent[] = cards
    .flatMap((card) => {
      const closingDate = getNextOccurrence(card.closingDay);
      const dueDate = getNextOccurrence(card.dueDay);
      const daysUntilClosing = getDaysUntil(card.closingDay);
      const daysUntilDue = getDaysUntil(card.dueDay);
      
      return [
        {
          cardName: card.name,
          companyName: card.companyName,
          ownerName: card.ownerName,
          lastFiveDigits: card.lastFiveDigits,
          currentBalance: card.currentBalance,
          type: 'closing' as const,
          date: closingDate,
          daysUntil: daysUntilClosing,
          closingDate,
          dueDate,
          daysUntilClosing,
          daysUntilDue,
        },
        {
          cardName: card.name,
          companyName: card.companyName,
          ownerName: card.ownerName,
          lastFiveDigits: card.lastFiveDigits,
          currentBalance: card.currentBalance,
          type: 'due' as const,
          date: dueDate,
          daysUntil: daysUntilDue,
          closingDate,
          dueDate,
          daysUntilClosing,
          daysUntilDue,
        },
      ];
    })
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 5);

  if (events.length === 0) {
    return null;
  }

  return (
    <div className="bg-card rounded-2xl p-6 shadow-sm border border-border">
      <div className="flex items-center gap-2 mb-4">
        <Calendar className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">Upcoming Dates</h2>
      </div>

      <div className="space-y-2">
        {events.map((event, index) => {
          const urgency = getUrgencyLevel(event.daysUntil);
          const closingUrgency = getUrgencyLevel(event.daysUntilClosing);
          const dueUrgency = getUrgencyLevel(event.daysUntilDue);
          
          return (
            <div
              key={`${event.cardName}-${event.type}-${index}`}
              className={cn(
                'rounded-lg p-3 border transition-all',
                urgency === 'urgent' && 'bg-destructive/10 border-destructive/30',
                urgency === 'warning' && 'bg-warning/10 border-warning/30',
                urgency === 'normal' && 'bg-muted/30 border-border'
              )}
            >
              {/* Single Row Layout */}
              <div className="flex items-center gap-3">
                {/* Urgency Badge */}
                <div className={cn(
                  'flex-shrink-0 px-2 py-1 rounded text-xs font-bold uppercase',
                  urgency === 'urgent' && 'bg-destructive text-destructive-foreground',
                  urgency === 'warning' && 'bg-warning text-warning-foreground',
                  urgency === 'normal' && 'bg-primary text-primary-foreground'
                )}>
                  {event.daysUntil === 0 ? 'Today' : `${event.daysUntil}d`}
                </div>

                {/* Card Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-card-foreground truncate">
                      {event.cardName}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      •••{event.lastFiveDigits}
                    </span>
                    <span className={cn(
                      'text-xs font-medium px-1.5 py-0.5 rounded capitalize',
                      event.type === 'closing' && 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
                      event.type === 'due' && 'bg-orange-500/20 text-orange-700 dark:text-orange-300'
                    )}>
                      {event.type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    {(event.companyName || event.ownerName) && (
                      <span className="truncate">
                        {event.companyName}{event.companyName && event.ownerName && ' • '}{event.ownerName}
                      </span>
                    )}
                    {event.currentBalance !== undefined && event.currentBalance > 0 && (
                      <span className="font-medium text-card-foreground">
                        ${event.currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Date Info */}
                <div className="flex-shrink-0 flex items-center gap-2 text-xs">
                  <div className="text-center px-2 py-1 rounded bg-background border border-border">
                    <div className={cn(
                      'font-medium',
                      closingUrgency === 'urgent' && 'text-destructive',
                      closingUrgency === 'warning' && 'text-warning',
                      closingUrgency === 'normal' && 'text-muted-foreground'
                    )}>
                      <span className="text-muted-foreground/70">C:</span> {formatDate(event.closingDate).slice(0, -6)}
                    </div>
                  </div>
                  <div className="text-center px-2 py-1 rounded bg-background border border-border">
                    <div className={cn(
                      'font-medium',
                      dueUrgency === 'urgent' && 'text-destructive',
                      dueUrgency === 'warning' && 'text-warning',
                      dueUrgency === 'normal' && 'text-muted-foreground'
                    )}>
                      <span className="text-muted-foreground/70">D:</span> {formatDate(event.dueDate).slice(0, -6)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
