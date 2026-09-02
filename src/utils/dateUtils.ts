import { format, addMonths, differenceInDays, isBefore, isToday, getDaysInMonth, getDay } from 'date-fns';

/**
 * Clamp the day to the last valid day of the given month,
 * then if it falls on a weekend, move it to the previous Friday.
 */
function resolveDay(year: number, month: number, dayOfMonth: number): Date {
  const maxDay = getDaysInMonth(new Date(year, month));
  const clampedDay = Math.min(dayOfMonth, maxDay);
  const date = new Date(year, month, clampedDay);

  // If Saturday (6) → Friday; if Sunday (0) → Friday
  const dow = getDay(date);
  if (dow === 6) date.setDate(clampedDay - 1); // Sat → Fri
  if (dow === 0) date.setDate(clampedDay - 2); // Sun → Fri

  return date;
}

export function getNextOccurrence(dayOfMonth: number): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let nextDate = resolveDay(today.getFullYear(), today.getMonth(), dayOfMonth);

  // If the resolved date has already passed this month, try next month
  if (isBefore(nextDate, today) && !isToday(nextDate)) {
    const next = addMonths(today, 1);
    nextDate = resolveDay(next.getFullYear(), next.getMonth(), dayOfMonth);
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
