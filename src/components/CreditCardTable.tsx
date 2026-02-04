import { useState, useMemo } from 'react';
import { CreditCard, cardColorClasses } from '@/types/creditCard';
import { getDaysUntil, getNextOccurrence, formatDate, getUrgencyLevel } from '@/utils/dateUtils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { LayoutList, CheckCircle, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { EditableBalance } from '@/components/EditableBalance';

type SortField = 'name' | 'owner' | 'company' | 'currentBalance' | 'totalBalance' | 'closing' | 'due';
type SortDirection = 'asc' | 'desc';

interface CreditCardTableProps {
  cards: CreditCard[];
  onEdit: (card: CreditCard) => void;
  onUpdateBalance?: (id: string, field: 'currentBalance' | 'totalBalance', value: number) => void;
}

export function CreditCardTable({ cards, onEdit, onUpdateBalance }: CreditCardTableProps) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedCards = useMemo(() => {
    if (!sortField) return cards;

    return [...cards].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'owner':
          comparison = (a.ownerName || '').localeCompare(b.ownerName || '');
          break;
        case 'company':
          comparison = (a.companyName || '').localeCompare(b.companyName || '');
          break;
        case 'currentBalance':
          comparison = (a.currentBalance || 0) - (b.currentBalance || 0);
          break;
        case 'totalBalance':
          comparison = (a.totalBalance || 0) - (b.totalBalance || 0);
          break;
        case 'closing':
          comparison = getDaysUntil(a.closingDay) - getDaysUntil(b.closingDay);
          break;
        case 'due':
          comparison = getDaysUntil(a.dueDay) - getDaysUntil(b.dueDay);
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [cards, sortField, sortDirection]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3.5 h-3.5 ml-1 opacity-50" />;
    }
    return sortDirection === 'asc' 
      ? <ArrowUp className="w-3.5 h-3.5 ml-1" />
      : <ArrowDown className="w-3.5 h-3.5 ml-1" />;
  };

  const SortableHeader = ({ field, children, className }: { field: SortField; children: React.ReactNode; className?: string }) => (
    <TableHead 
      className={cn("cursor-pointer hover:bg-muted/50 transition-colors select-none", className)}
      onClick={() => handleSort(field)}
    >
      <div className="flex items-center">
        {children}
        <SortIcon field={field} />
      </div>
    </TableHead>
  );

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
              <SortableHeader field="name" className="w-[200px]">Card</SortableHeader>
              <SortableHeader field="owner">Owner</SortableHeader>
              <SortableHeader field="company">Company</SortableHeader>
              <SortableHeader field="currentBalance" className="text-right">Remaining Statement</SortableHeader>
              <SortableHeader field="totalBalance" className="text-right">Total Balance</SortableHeader>
              <SortableHeader field="closing" className="text-center">Closing</SortableHeader>
              <SortableHeader field="due" className="text-center">Due</SortableHeader>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedCards.map((card) => {
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
                        {onUpdateBalance ? (
                          <EditableBalance
                            value={card.currentBalance || 0}
                            onSave={(value) => onUpdateBalance(card.id, 'currentBalance', value)}
                            labelClassName="hover:bg-muted"
                          />
                        ) : (
                          `$${(card.currentBalance || 0).toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}`
                        )}
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
                      {onUpdateBalance ? (
                        <EditableBalance
                          value={card.totalBalance || 0}
                          onSave={(value) => onUpdateBalance(card.id, 'totalBalance', value)}
                          labelClassName="hover:bg-muted"
                        />
                      ) : (
                        `$${(card.totalBalance || 0).toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}`
                      )}
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
                        {formatDate(closingDate)}
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
                        {formatDate(dueDate)}
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
