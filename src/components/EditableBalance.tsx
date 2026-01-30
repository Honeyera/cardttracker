import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface EditableBalanceProps {
  value: number;
  onSave: (newValue: number) => void;
  className?: string;
  labelClassName?: string;
}

export function EditableBalance({ value, onSave, className, labelClassName }: EditableBalanceProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(value.toFixed(2));
    setIsEditing(true);
  };

  const handleBlur = () => {
    saveValue();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveValue();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  const saveValue = () => {
    const numValue = parseFloat(editValue.replace(/[^0-9.-]/g, ''));
    if (!isNaN(numValue) && numValue >= 0) {
      onSave(numValue);
    }
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'bg-background/90 text-foreground rounded px-2 py-1 text-sm font-semibold w-28 outline-none ring-2 ring-primary',
          className
        )}
      />
    );
  }

  return (
    <span
      onClick={handleClick}
      className={cn(
        'cursor-pointer hover:bg-white/20 rounded px-1 -mx-1 transition-colors',
        labelClassName
      )}
      title="Click to edit"
    >
      ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}
