import { useState, useEffect } from 'react';
import { CreditCard } from '@/types/creditCard';

const STORAGE_KEY = 'credit-cards';

const defaultCards: CreditCard[] = [
  {
    id: '1',
    name: 'Chase Sapphire',
    lastFiveDigits: '84521',
    closingDay: 15,
    dueDay: 22,
    color: 'navy',
    creditLimit: 10000,
    currentBalance: 2450,
  },
  {
    id: '2',
    name: 'Amex Gold',
    lastFiveDigits: '93782',
    closingDay: 5,
    dueDay: 12,
    color: 'teal',
    creditLimit: 15000,
    currentBalance: 890,
  },
];

export function useCreditCards() {
  const [cards, setCards] = useState<CreditCard[]>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Migrate old cards with lastFourDigits to lastFiveDigits
      return parsed.map((card: any) => ({
        ...card,
        lastFiveDigits: card.lastFiveDigits || card.lastFourDigits || '00000',
      }));
    }
    return defaultCards;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  }, [cards]);

  const addCard = (card: Omit<CreditCard, 'id'>) => {
    const newCard: CreditCard = {
      ...card,
      id: Date.now().toString(),
    };
    setCards((prev) => [...prev, newCard]);
  };

  const updateCard = (id: string, updates: Partial<CreditCard>) => {
    setCards((prev) =>
      prev.map((card) => (card.id === id ? { ...card, ...updates } : card))
    );
  };

  const deleteCard = (id: string) => {
    setCards((prev) => prev.filter((card) => card.id !== id));
  };

  return { cards, addCard, updateCard, deleteCard };
}
