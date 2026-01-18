import { CreditCard } from '@/types/creditCard';
import { getDaysUntil } from '@/utils/dateUtils';
import { CreditCard as CardIcon, AlertTriangle, DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DashboardStatsProps {
  cards: CreditCard[];
}

export function DashboardStats({ cards }: DashboardStatsProps) {
  const totalCards = cards.length;
  
  const cardsDueThisWeek = cards.filter((card) => {
    const daysUntil = getDaysUntil(card.dueDay);
    return daysUntil <= 7;
  });
  
  const totalBalance = cards.reduce((sum, card) => sum + (card.currentBalance || 0), 0);

  const stats = [
    {
      label: 'Total Cards',
      value: totalCards.toString(),
      icon: CardIcon,
      color: 'primary' as const,
      subtext: totalCards === 1 ? 'credit card' : 'credit cards',
    },
    {
      label: 'Due This Week',
      value: cardsDueThisWeek.length.toString(),
      icon: AlertTriangle,
      color: cardsDueThisWeek.length > 0 ? 'warning' as const : 'success' as const,
      subtext: cardsDueThisWeek.length > 0 
        ? cardsDueThisWeek.map(c => c.name).join(', ')
        : 'No payments due',
    },
    {
      label: 'Total Balance',
      value: `$${totalBalance.toLocaleString()}`,
      icon: DollarSign,
      color: 'accent' as const,
      subtext: 'across all cards',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {stats.map((stat) => (
        <StatTile key={stat.label} {...stat} />
      ))}
    </div>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  color: 'primary' | 'warning' | 'success' | 'accent';
  subtext: string;
}

function StatTile({ label, value, icon: Icon, color, subtext }: StatTileProps) {
  return (
    <div className="bg-card rounded-2xl p-5 shadow-sm border border-border">
      <div className="flex items-start justify-between mb-3">
        <div
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center',
            color === 'primary' && 'bg-primary/10 text-primary',
            color === 'warning' && 'bg-warning/10 text-warning',
            color === 'success' && 'bg-success/10 text-success',
            color === 'accent' && 'bg-accent/10 text-accent'
          )}
        >
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <p className="text-2xl font-bold text-card-foreground mb-1">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground mt-1 truncate" title={subtext}>
        {subtext}
      </p>
    </div>
  );
}
