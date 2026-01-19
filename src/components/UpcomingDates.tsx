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
      <div className="flex items-center gap-2 mb-6">
        <Calendar className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">Upcoming Dates</h2>
      </div>

      <div className="space-y-4">
        {events.map((event, index) => {
          const urgency = getUrgencyLevel(event.daysUntil);
          const closingUrgency = getUrgencyLevel(event.daysUntilClosing);
          const dueUrgency = getUrgencyLevel(event.daysUntilDue);
          
          return (
            <div
              key={`${event.cardName}-${event.type}-${index}`}
              className={cn(
                'rounded-xl p-4 border transition-all',
                urgency === 'urgent' && 'bg-destructive/10 border-destructive/30',
                urgency === 'warning' && 'bg-warning/10 border-warning/30',
                urgency === 'normal' && 'bg-muted/50 border-border'
              )}
            >
              {/* Header: Card Info */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold text-card-foreground">
                      {event.cardName}
                    </h3>
                    <span className="text-sm text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded">
                      •••{event.lastFiveDigits}
                    </span>
                  </div>
                  {(event.companyName || event.ownerName) && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {event.companyName}{event.companyName && event.ownerName && ' • '}{event.ownerName}
                    </p>
                  )}
                </div>
                {event.currentBalance !== undefined && event.currentBalance > 0 && (
                  <div className="text-right ml-3">
                    <p className="text-xs text-muted-foreground">Balance</p>
                    <p className="text-base font-bold text-card-foreground">
                      ${event.currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                )}
              </div>

              {/* Primary Event Badge */}
              <div className={cn(
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg mb-3',
                urgency === 'urgent' && 'bg-destructive text-destructive-foreground',
                urgency === 'warning' && 'bg-warning text-warning-foreground',
                urgency === 'normal' && 'bg-primary text-primary-foreground'
              )}>
                <span className="text-sm font-medium capitalize">{event.type} Date</span>
                <span className="text-sm font-bold">
                  {event.daysUntil === 0 ? 'Today!' : `in ${event.daysUntil} days`}
                </span>
              </div>

              {/* Date Details Grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className={cn(
                  'rounded-lg p-3 border',
                  closingUrgency === 'urgent' && 'bg-destructive/10 border-destructive/30',
                  closingUrgency === 'warning' && 'bg-warning/10 border-warning/30',
                  closingUrgency === 'normal' && 'bg-background border-border'
                )}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <div className={cn(
                      'w-2 h-2 rounded-full',
                      closingUrgency === 'urgent' && 'bg-destructive',
                      closingUrgency === 'warning' && 'bg-warning',
                      closingUrgency === 'normal' && 'bg-success'
                    )} />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Closing
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-card-foreground">
                    {formatDate(event.closingDate)}
                  </p>
                  <p className={cn(
                    'text-xs font-medium',
                    closingUrgency === 'urgent' && 'text-destructive',
                    closingUrgency === 'warning' && 'text-warning',
                    closingUrgency === 'normal' && 'text-muted-foreground'
                  )}>
                    {event.daysUntilClosing === 0 ? 'Today!' : `${event.daysUntilClosing} days`}
                  </p>
                </div>

                <div className={cn(
                  'rounded-lg p-3 border',
                  dueUrgency === 'urgent' && 'bg-destructive/10 border-destructive/30',
                  dueUrgency === 'warning' && 'bg-warning/10 border-warning/30',
                  dueUrgency === 'normal' && 'bg-background border-border'
                )}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <div className={cn(
                      'w-2 h-2 rounded-full',
                      dueUrgency === 'urgent' && 'bg-destructive',
                      dueUrgency === 'warning' && 'bg-warning',
                      dueUrgency === 'normal' && 'bg-success'
                    )} />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Due
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-card-foreground">
                    {formatDate(event.dueDate)}
                  </p>
                  <p className={cn(
                    'text-xs font-medium',
                    dueUrgency === 'urgent' && 'text-destructive',
                    dueUrgency === 'warning' && 'text-warning',
                    dueUrgency === 'normal' && 'text-muted-foreground'
                  )}>
                    {event.daysUntilDue === 0 ? 'Today!' : `${event.daysUntilDue} days`}
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
