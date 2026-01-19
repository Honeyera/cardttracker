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

      <div className="space-y-3">
        {events.map((event, index) => {
          const urgency = getUrgencyLevel(event.daysUntil);
          return (
            <div
              key={`${event.cardName}-${event.type}-${index}`}
              className="flex items-center justify-between py-2 border-b border-border last:border-0"
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    'w-2 h-2 rounded-full flex-shrink-0',
                    urgency === 'urgent' && 'bg-destructive',
                    urgency === 'warning' && 'bg-warning',
                    urgency === 'normal' && 'bg-success'
                  )}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-card-foreground truncate">
                      {event.cardName}
                    </p>
                    <span className="text-xs text-muted-foreground font-mono flex-shrink-0">
                      •••{event.lastFiveDigits}
                    </span>
                  </div>
                  {event.companyName && (
                    <p className="text-xs text-muted-foreground truncate">{event.companyName}</p>
                  )}
                  {event.ownerName && (
                    <p className="text-xs text-muted-foreground/70 truncate">{event.ownerName}</p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-xs text-muted-foreground capitalize">
                      {event.type} Date
                    </p>
                    {event.currentBalance !== undefined && event.currentBalance > 0 && (
                      <span className="text-xs font-medium text-primary">
                        ${event.currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-medium text-card-foreground">
                  {formatDate(event.date)}
                </p>
                <p
                  className={cn(
                    'text-xs',
                    urgency === 'urgent' && 'text-destructive font-medium',
                    urgency === 'warning' && 'text-warning font-medium',
                    urgency === 'normal' && 'text-muted-foreground'
                  )}
                >
                  {event.daysUntil === 0 ? 'Today!' : `in ${event.daysUntil} days`}
                </p>
                <div className="mt-1 pt-1 border-t border-border/50">
                  <p className="text-[10px] text-muted-foreground">
                    Close: {formatDate(event.closingDate)} ({event.daysUntilClosing}d)
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Due: {formatDate(event.dueDate)} ({event.daysUntilDue}d)
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
