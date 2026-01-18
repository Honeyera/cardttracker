import { useState, useEffect } from 'react';
import { CreditCard } from '@/types/creditCard';

const STORAGE_KEY = 'credit-cards';

const defaultCards: CreditCard[] = [
  {
    id: '1',
    name: 'Chase Sapphire',
    lastFourDigits: '4521',
    closingDay: 15,
    dueDay: 22,
    color: 'navy',
    creditLimit: 10000,
    currentBalance: 2450,
  },
  {
    id: '2',
    name: 'Amex Gold',
    lastFourDigits: '3782',
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
    return stored ? JSON.parse(stored) : defaultCards;
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
