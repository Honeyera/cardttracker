import { CreditCard } from '@/types/creditCard';
import { getDaysUntil, getNextOccurrence, formatDate, getUrgencyLevel } from '@/utils/dateUtils';
import { Calendar, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UpcomingDatesProps {
  cards: CreditCard[];
}

interface DateEvent {
  cardName: string;
  lastFiveDigits: string;
  type: 'closing' | 'due';
  date: Date;
  daysUntil: number;
}

export function UpcomingDates({ cards }: UpcomingDatesProps) {
  const events: DateEvent[] = cards
    .flatMap((card) => [
      {
        cardName: card.name,
        lastFiveDigits: card.lastFiveDigits,
        type: 'closing' as const,
        date: getNextOccurrence(card.closingDay),
        daysUntil: getDaysUntil(card.closingDay),
      },
      {
        cardName: card.name,
        lastFiveDigits: card.lastFiveDigits,
        type: 'due' as const,
        date: getNextOccurrence(card.dueDay),
        daysUntil: getDaysUntil(card.dueDay),
      },
    ])
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
                    'w-2 h-2 rounded-full',
                    urgency === 'urgent' && 'bg-destructive',
                    urgency === 'warning' && 'bg-warning',
                    urgency === 'normal' && 'bg-success'
                  )}
                />
                <div>
                  <p className="text-sm font-medium text-card-foreground">
                    {event.cardName}
                    <span className="ml-2 text-xs text-muted-foreground font-mono">
                      •••{event.lastFiveDigits}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {event.type} Date
                  </p>
                </div>
              </div>
              <div className="text-right">
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
