import { useState, useEffect } from 'react';
import { CreditCard } from '@/types/creditCard';

const STORAGE_KEY = 'credit-cards';

// Generate unique ID
const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const defaultCards: CreditCard[] = [
  {
    id: generateId(),
    name: 'Chase Sapphire',
    lastFiveDigits: '84521',
    closingDay: 15,
    dueDay: 22,
    color: 'navy',
    creditLimit: 10000,
    currentBalance: 2450,
  },
  {
    id: generateId(),
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
      // Track seen IDs to detect duplicates
      const seenIds = new Set<string>();
      
      // Migrate old cards and ensure unique IDs
      return parsed.map((card: any) => {
        let cardId = card.id;
        
        // If ID is missing or duplicate, generate a new one
        if (!cardId || seenIds.has(cardId)) {
          cardId = generateId();
        }
        seenIds.add(cardId);
        
        return {
          ...card,
          id: cardId,
          lastFiveDigits: card.lastFiveDigits || card.lastFourDigits || '00000',
        };
      });
    }
    return defaultCards;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  }, [cards]);

  const addCard = (card: Omit<CreditCard, 'id'>) => {
    const newCard: CreditCard = {
      ...card,
      id: generateId(),
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
