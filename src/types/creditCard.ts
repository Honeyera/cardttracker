export interface CreditCard {
  id: string;
  name: string;
  lastFourDigits: string;
  closingDay: number; // Day of month (1-31)
  dueDay: number; // Day of month (1-31)
  color: 'navy' | 'teal' | 'slate' | 'ocean';
  creditLimit?: number;
}

export type CardColor = CreditCard['color'];

export const cardColorClasses: Record<CardColor, string> = {
  navy: 'from-[hsl(220,70%,25%)] to-[hsl(220,60%,35%)]',
  teal: 'from-[hsl(174,60%,35%)] to-[hsl(174,50%,45%)]',
  slate: 'from-[hsl(220,20%,35%)] to-[hsl(220,15%,45%)]',
  ocean: 'from-[hsl(200,70%,30%)] to-[hsl(200,60%,40%)]',
};
