import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CreditCard } from '@/types/creditCard';
import { CreditCardItem } from './CreditCardItem';
import { GripVertical } from 'lucide-react';

interface SortableCardItemProps {
  card: CreditCard;
  onEdit: (card: CreditCard) => void;
  onDelete: (id: string) => void;
  onUpdateBalance?: (id: string, field: 'currentBalance' | 'totalBalance', value: number) => void;
}

export function SortableCardItem({ card, onEdit, onDelete, onUpdateBalance }: SortableCardItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group">
      {/* Drag Handle */}
      <button
        {...attributes}
        {...listeners}
        className="absolute -left-2 top-1/2 -translate-y-1/2 z-20 p-1.5 rounded-lg bg-card/90 border border-border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing hover:bg-muted"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-4 h-4 text-muted-foreground" />
      </button>
      
      <CreditCardItem
        card={card}
        onEdit={onEdit}
        onDelete={onDelete}
        onUpdateBalance={onUpdateBalance}
      />
    </div>
  );
}
