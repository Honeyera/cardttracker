import { CreditCard, cardColorClasses } from '@/types/creditCard';
import { getDaysUntil, getNextOccurrence, formatDate, getUrgencyLevel } from '@/utils/dateUtils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { LayoutList, CheckCircle } from 'lucide-react';

interface CreditCardTableProps {
  cards: CreditCard[];
  onEdit: (card: CreditCard) => void;
}

export function CreditCardTable({ cards, onEdit }: CreditCardTableProps) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="bg-card rounded-2xl p-6 shadow-sm border border-border">
      <div className="flex items-center gap-2 mb-4">
        <LayoutList className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold text-card-foreground">All Cards</h2>
        <span className="text-sm text-muted-foreground">({cards.length})</span>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">Card</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Company</TableHead>
              <TableHead className="text-right">Statement Balance</TableHead>
              <TableHead className="text-right">Total Balance</TableHead>
              <TableHead className="text-center">Closing</TableHead>
              <TableHead className="text-center">Due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cards.map((card) => {
              const daysUntilDue = getDaysUntil(card.dueDay);
              const daysUntilClosing = getDaysUntil(card.closingDay);
              const dueDate = getNextOccurrence(card.dueDay);
              const closingDate = getNextOccurrence(card.closingDay);
              const dueUrgency = getUrgencyLevel(daysUntilDue);
              const closingUrgency = getUrgencyLevel(daysUntilClosing);

              return (
                <TableRow
                  key={card.id}
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => onEdit(card)}
                >
                  {/* Card Name & Last 5 */}
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'w-3 h-8 rounded-full flex-shrink-0',
                          cardColorClasses[card.color]
                        )}
                      />
                      <div>
                        <p className="font-medium text-card-foreground">{card.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          •••• {card.lastFiveDigits || '•••••'}
                        </p>
                      </div>
                    </div>
                  </TableCell>

                  {/* Owner */}
                  <TableCell>
                    {card.ownerName ? (
                      <span className="text-sm text-card-foreground">{card.ownerName}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </TableCell>

                  {/* Company */}
                  <TableCell>
                    {card.companyName ? (
                      <span className="text-sm text-card-foreground">{card.companyName}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </TableCell>

                  {/* Remaining Statement Balance */}
                  <TableCell className="text-right">
                    <div>
                      <span className="font-semibold text-card-foreground">
                        ${(card.currentBalance || 0).toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      {card.paymentStatus && (
                        <div className="flex items-center justify-end gap-1 text-emerald-600 mt-0.5">
                          <CheckCircle className="w-3 h-3" />
                          <span className="text-xs">Payment not required</span>
                        </div>
                      )}
                    </div>
                  </TableCell>

                  {/* Total Balance */}
                  <TableCell className="text-right">
                    <span className="font-semibold text-card-foreground">
                      ${(card.totalBalance || 0).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </TableCell>

                  {/* Closing Date */}
                  <TableCell className="text-center">
                    <div>
                      <p
                        className={cn(
                          'text-sm font-medium',
                          closingUrgency === 'urgent' && 'text-destructive',
                          closingUrgency === 'warning' && 'text-warning',
                          closingUrgency === 'normal' && 'text-card-foreground'
                        )}
                      >
                        {formatDate(closingDate).slice(0, -6)}
                      </p>
                      <p
                        className={cn(
                          'text-xs',
                          closingUrgency === 'urgent' && 'text-destructive font-medium',
                          closingUrgency === 'warning' && 'text-warning font-medium',
                          closingUrgency === 'normal' && 'text-muted-foreground'
                        )}
                      >
                        {daysUntilClosing === 0 ? 'Today!' : `${daysUntilClosing} days`}
                      </p>
                    </div>
                  </TableCell>

                  {/* Due Date */}
                  <TableCell className="text-center">
                    <div>
                      <p
                        className={cn(
                          'text-sm font-medium',
                          dueUrgency === 'urgent' && 'text-destructive',
                          dueUrgency === 'warning' && 'text-warning',
                          dueUrgency === 'normal' && 'text-card-foreground'
                        )}
                      >
                        {formatDate(dueDate).slice(0, -6)}
                      </p>
                      <p
                        className={cn(
                          'text-xs',
                          dueUrgency === 'urgent' && 'text-destructive font-medium',
                          dueUrgency === 'warning' && 'text-warning font-medium',
                          dueUrgency === 'normal' && 'text-muted-foreground'
                        )}
                      >
                        {daysUntilDue === 0 ? 'Today!' : `${daysUntilDue} days`}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
