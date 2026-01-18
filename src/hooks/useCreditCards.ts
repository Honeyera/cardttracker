import { useState, useEffect } from 'react';
import { CreditCard } from '@/types/creditCard';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export function useCreditCards() {
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  // Fetch cards from Supabase
  useEffect(() => {
    if (!user) {
      setCards([]);
      setLoading(false);
      return;
    }

    const fetchCards = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('credit_cards')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching cards:', error);
        toast.error('Failed to load cards');
      } else {
        // Map database fields to frontend model
        const mappedCards: CreditCard[] = (data || []).map((card) => ({
          id: card.id,
          name: card.name,
          ownerName: card.owner_name,
          lastFiveDigits: card.last_four || '00000',
          closingDay: card.statement_date || 1,
          dueDay: card.due_date || 15,
          color: (card.network as CreditCard['color']) || 'navy',
          creditLimit: Number(card.credit_limit) || 0,
          currentBalance: Number(card.current_balance) || 0,
        }));
        setCards(mappedCards);
      }
      setLoading(false);
    };

    fetchCards();
  }, [user]);

  const addCard = async (card: Omit<CreditCard, 'id'>) => {
    if (!user) {
      toast.error('Please sign in to add cards');
      return;
    }

    const { data, error } = await supabase
      .from('credit_cards')
      .insert({
        user_id: user.id,
        name: card.name,
        owner_name: card.ownerName || '',
        last_four: card.lastFiveDigits,
        network: card.color,
        statement_date: card.closingDay,
        due_date: card.dueDay,
        credit_limit: card.creditLimit || 0,
        current_balance: card.currentBalance || 0,
      })
      .select()
      .single();

    if (error) {
      console.error('Error adding card:', error);
      toast.error('Failed to add card');
    } else if (data) {
      const newCard: CreditCard = {
        id: data.id,
        name: data.name,
        ownerName: data.owner_name,
        lastFiveDigits: data.last_four || '00000',
        closingDay: data.statement_date || 1,
        dueDay: data.due_date || 15,
        color: (data.network as CreditCard['color']) || 'navy',
        creditLimit: Number(data.credit_limit) || 0,
        currentBalance: Number(data.current_balance) || 0,
      };
      setCards((prev) => [newCard, ...prev]);
      toast.success('Card added successfully');
    }
  };

  const updateCard = async (id: string, updates: Partial<CreditCard>) => {
    if (!user) {
      toast.error('Please sign in to update cards');
      return;
    }

    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.ownerName !== undefined) dbUpdates.owner_name = updates.ownerName;
    if (updates.lastFiveDigits !== undefined) dbUpdates.last_four = updates.lastFiveDigits;
    if (updates.color !== undefined) dbUpdates.network = updates.color;
    if (updates.closingDay !== undefined) dbUpdates.statement_date = updates.closingDay;
    if (updates.dueDay !== undefined) dbUpdates.due_date = updates.dueDay;
    if (updates.creditLimit !== undefined) dbUpdates.credit_limit = updates.creditLimit;
    if (updates.currentBalance !== undefined) dbUpdates.current_balance = updates.currentBalance;

    const { error } = await supabase
      .from('credit_cards')
      .update(dbUpdates)
      .eq('id', id);

    if (error) {
      console.error('Error updating card:', error);
      toast.error('Failed to update card');
    } else {
      setCards((prev) =>
        prev.map((card) => (card.id === id ? { ...card, ...updates } : card))
      );
    }
  };

  const deleteCard = async (id: string) => {
    if (!user) {
      toast.error('Please sign in to delete cards');
      return;
    }

    const { error } = await supabase
      .from('credit_cards')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting card:', error);
      toast.error('Failed to delete card');
    } else {
      setCards((prev) => prev.filter((card) => card.id !== id));
      toast.success('Card deleted');
    }
  };

  return { cards, loading, addCard, updateCard, deleteCard };
}
