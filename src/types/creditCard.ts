export interface CreditCard {
  id: string;
  name: string;
  companyName?: string;
  ownerName?: string;
  lastFiveDigits: string;
  closingDay: number; // Day of month (1-31)
  dueDay: number; // Day of month (1-31)
  color: 'navy' | 'teal' | 'slate' | 'ocean' | 'gold' | 'rose' | 'purple' | 'emerald';
  creditLimit?: number;
  currentBalance?: number;
}

export type CardColor = CreditCard['color'];

export const cardColorClasses: Record<CardColor, string> = {
  navy: 'from-[hsl(220,70%,25%)] to-[hsl(220,60%,35%)]',
  teal: 'from-[hsl(174,60%,35%)] to-[hsl(174,50%,45%)]',
  slate: 'from-[hsl(220,20%,35%)] to-[hsl(220,15%,45%)]',
  ocean: 'from-[hsl(200,70%,30%)] to-[hsl(200,60%,40%)]',
  gold: 'from-[hsl(45,80%,40%)] to-[hsl(35,70%,50%)]',
  rose: 'from-[hsl(350,60%,45%)] to-[hsl(340,50%,55%)]',
  purple: 'from-[hsl(270,50%,40%)] to-[hsl(280,45%,50%)]',
  emerald: 'from-[hsl(160,60%,30%)] to-[hsl(150,50%,40%)]',
};
