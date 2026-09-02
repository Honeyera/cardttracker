import { CreditCard } from '@/types/creditCard';
import { getDaysUntil, getNextOccurrence, formatDate, getUrgencyLevel } from '@/utils/dateUtils';
import { Calendar } from 'lucide-react';
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
              {/* Responsive layout: dates wrap onto their own line on small screens */}
              <div className="flex flex-wrap items-center gap-3">
                {/* Days Badge */}
                <div className="flex-shrink-0 w-12">
                  <div
                    className={cn(
                      'px-2 py-1 rounded text-xs font-bold uppercase text-center',
                      urgency === 'urgent' && 'bg-destructive text-destructive-foreground',
                      urgency === 'warning' && 'bg-warning text-warning-foreground',
                      urgency === 'normal' && 'bg-primary text-primary-foreground'
                    )}
                  >
                    {event.daysUntil === 0 ? 'Now' : `${event.daysUntil}d`}
                  </div>
                </div>

                {/* Card Name & Owner */}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-card-foreground truncate">{event.cardName}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{event.ownerName}</span>
                    <span className="text-xs text-muted-foreground font-mono">•••{event.lastFiveDigits}</span>
                  </div>
                </div>

                {/* Type Badge */}
                <div className="flex-shrink-0">
                  <span
                    className={cn(
                      'text-xs font-medium px-2 py-1 rounded capitalize inline-block',
                      event.type === 'closing' && 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
                      event.type === 'due' && 'bg-orange-500/20 text-orange-700 dark:text-orange-300'
                    )}
                  >
                    {event.type}
                  </span>
                </div>

                {/* Right side: balance + dates (wraps to next line on small) */}
                <div className="w-full sm:w-auto sm:ml-auto flex items-center justify-between sm:justify-end gap-3">
                  {/* Balance (hide on very small screens to keep dates visible) */}
                  <div className="hidden md:block w-24 text-right">
                    {event.currentBalance !== undefined && event.currentBalance > 0 ? (
                      <p className="text-sm font-semibold text-card-foreground">
                        ${event.currentBalance.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground/50">—</p>
                    )}
                  </div>

                  {/* Closing Date */}
                  <div className="flex-shrink-0 w-20 text-center">
                    <p className="text-[10px] text-muted-foreground uppercase">Close</p>
                    <p
                      className={cn(
                        'text-sm font-medium',
                        closingUrgency === 'urgent' && 'text-destructive',
                        closingUrgency === 'warning' && 'text-warning',
                        closingUrgency === 'normal' && 'text-card-foreground'
                      )}
                    >
                      {formatDate(event.closingDate)}
                    </p>
                  </div>

                  {/* Due Date */}
                  <div className="flex-shrink-0 w-20 text-center">
                    <p className="text-[10px] text-muted-foreground uppercase">Due</p>
                    <p
                      className={cn(
                        'text-sm font-medium',
                        dueUrgency === 'urgent' && 'text-destructive',
                        dueUrgency === 'warning' && 'text-warning',
                        dueUrgency === 'normal' && 'text-card-foreground'
                      )}
                    >
                      {formatDate(event.dueDate)}
                    </p>
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
