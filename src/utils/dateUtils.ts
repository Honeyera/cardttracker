import { format, addMonths, setDate, differenceInDays, isBefore, isToday } from 'date-fns';

export function getNextOccurrence(dayOfMonth: number): Date {
  const today = new Date();
  let nextDate = setDate(today, dayOfMonth);
  
  // If the date has passed this month, get next month's occurrence
  if (isBefore(nextDate, today) && !isToday(nextDate)) {
    nextDate = setDate(addMonths(today, 1), dayOfMonth);
  }
  
  return nextDate;
}

export function getDaysUntil(dayOfMonth: number): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nextDate = getNextOccurrence(dayOfMonth);
  nextDate.setHours(0, 0, 0, 0);
  return differenceInDays(nextDate, today);
}

export function formatDate(date: Date): string {
  return format(date, 'MMM d');
}

export function getUrgencyLevel(daysUntil: number): 'urgent' | 'warning' | 'normal' {
  if (daysUntil <= 3) return 'urgent';
  if (daysUntil <= 7) return 'warning';
  return 'normal';
}
