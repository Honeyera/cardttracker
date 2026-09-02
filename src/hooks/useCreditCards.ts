import { useEffect, useMemo, useState, useCallback } from 'react';
import { CreditCard } from '@/types/creditCard';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

const LEGACY_STORAGE_KEY = 'credit-cards';
const MIGRATED_FLAG_PREFIX = 'credit-cards-migrated:';

type DbCard = {
  id: string;
  name: string;
  company_name: string | null;
  owner_name: string | null;
  last_four: string | null;
  network: string | null;
  statement_date: number | null;
  due_date: number | null;
  credit_limit: number | null;
  current_balance: number | null;
  total_balance: number | null;
  display_order: number | null;
  created_at: string;
  team_id: string | null;
  payment_status: string | null;
  updated_at: string | null;
};

function dbToModel(card: DbCard): CreditCard {
  return {
    id: card.id,
    name: card.name,
    companyName: card.company_name ?? undefined,
    ownerName: card.owner_name ?? undefined,
    lastFiveDigits: card.last_four || '00000',
    closingDay: card.statement_date || 1,
    dueDay: card.due_date || 15,
    color: (card.network as CreditCard['color']) || 'navy',
    creditLimit: Number(card.credit_limit) || 0,
    currentBalance: Number(card.current_balance) || 0,
    totalBalance: Number(card.total_balance) || 0,
    teamId: card.team_id ?? undefined,
    paymentStatus: card.payment_status ?? undefined,
    updatedAt: card.updated_at ?? undefined,
  };
}

function getLegacyCardKey(card: any) {
  const name = String(card?.name ?? '').trim();
  const digits = String(card?.lastFiveDigits ?? card?.lastFourDigits ?? '').trim();
  return `${name}|${digits}`;
}

function getDbCardKey(card: DbCard) {
  const name = String(card?.name ?? '').trim();
  const digits = String(card?.last_four ?? '').trim();
  return `${name}|${digits}`;
}

export function useCreditCards() {
  const [cards, setCards] = useState<CreditCard[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  const migratedFlagKey = useMemo(
    () => (user ? `${MIGRATED_FLAG_PREFIX}${user.id}` : ''),
    [user]
  );

  useEffect(() => {
    if (!user) {
      setCards([]);
      setLoading(false);
      return;
    }

    const loadAndMaybeMigrate = async () => {
      setLoading(true);

      // Fetch current cards from database, ordered by display_order
      const { data, error } = await supabase
        .from('credit_cards')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) {
        console.error('Error fetching cards:', error);
        toast.error('Failed to load cards');
        setCards([]);
        setLoading(false);
        return;
      }

      const dbCards = (data || []) as unknown as DbCard[];
      setCards(dbCards.map(dbToModel));

      // One-time import from legacy localStorage
      try {
        const alreadyMigrated = migratedFlagKey
          ? localStorage.getItem(migratedFlagKey) === '1'
          : true;

        if (!alreadyMigrated) {
          const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
          if (legacyRaw) {
            const parsed = JSON.parse(legacyRaw);
            const legacyCards: any[] = Array.isArray(parsed) ? parsed : [];

            const existingKeys = new Set(dbCards.map(getDbCardKey));
            const maxOrder = dbCards.reduce((max, c) => Math.max(max, c.display_order || 0), 0);
            
            const toImport = legacyCards
              .filter((c) => {
                const key = getLegacyCardKey(c);
                return key !== '|' && !existingKeys.has(key);
              })
              .map((c, idx) => ({
                user_id: user.id,
                name: String(c?.name ?? '').trim() || 'Untitled Card',
                owner_name: String(c?.ownerName ?? '').trim(),
                last_four: String(c?.lastFiveDigits ?? c?.lastFourDigits ?? '').trim() || '00000',
                network: (c?.color as string) || 'navy',
                statement_date: Number(c?.closingDay ?? 1) || 1,
                due_date: Number(c?.dueDay ?? 15) || 15,
                credit_limit: Number(c?.creditLimit ?? 0) || 0,
                current_balance: Number(c?.currentBalance ?? 0) || 0,
                display_order: maxOrder + idx + 1,
              }));

            if (toImport.length > 0) {
              const { error: insertError } = await supabase
                .from('credit_cards')
                .insert(toImport);

              if (!insertError) {
                toast.success(`Imported ${toImport.length} card(s) from this device`);
                const { data: refreshed } = await supabase
                  .from('credit_cards')
                  .select('*')
                  .order('display_order', { ascending: true });
                setCards(((refreshed || []) as unknown as DbCard[]).map(dbToModel));
              } else {
                console.error('Error importing legacy cards:', insertError);
                toast.error('Could not import older cards from this device');
              }
            }

            localStorage.setItem(migratedFlagKey, '1');
          }
        }
      } catch {
        if (migratedFlagKey) localStorage.setItem(migratedFlagKey, '1');
      }

      setLoading(false);
    };

    loadAndMaybeMigrate();
  }, [user, migratedFlagKey]);

  const addCard = async (card: Omit<CreditCard, 'id'>) => {
    if (!user) {
      toast.error('Please sign in to add cards');
      return;
    }

    // Get max display_order to add new card at the end
    const maxOrder = cards.length;

    const { data, error } = await supabase
      .from('credit_cards')
      .insert({
        user_id: user.id,
        name: card.name,
        company_name: card.companyName || '',
        owner_name: card.ownerName || '',
        last_four: card.lastFiveDigits,
        network: card.color,
        statement_date: card.closingDay,
        due_date: card.dueDay,
        credit_limit: card.creditLimit || 0,
        current_balance: card.currentBalance || 0,
        display_order: maxOrder + 1,
      })
      .select()
      .single();

    if (error) {
      console.error('Error adding card:', error);
      toast.error('Failed to add card');
    } else if (data) {
      setCards((prev) => [...prev, dbToModel(data as unknown as DbCard)]);
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
    if (updates.companyName !== undefined) dbUpdates.company_name = updates.companyName;
    if (updates.ownerName !== undefined) dbUpdates.owner_name = updates.ownerName;
    if (updates.lastFiveDigits !== undefined) dbUpdates.last_four = updates.lastFiveDigits;
    if (updates.color !== undefined) dbUpdates.network = updates.color;
    if (updates.closingDay !== undefined) dbUpdates.statement_date = updates.closingDay;
    if (updates.dueDay !== undefined) dbUpdates.due_date = updates.dueDay;
    if (updates.creditLimit !== undefined) dbUpdates.credit_limit = updates.creditLimit;
    if (updates.currentBalance !== undefined) dbUpdates.current_balance = updates.currentBalance;
    if (updates.totalBalance !== undefined) dbUpdates.total_balance = updates.totalBalance;
    if (updates.paymentStatus !== undefined) dbUpdates.payment_status = updates.paymentStatus;

    const { data, error } = await supabase
      .from('credit_cards')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating card:', error);
      toast.error('Failed to update card');
    } else if (data) {
      setCards((prev) => prev.map((c) => (c.id === id ? dbToModel(data as unknown as DbCard) : c)));
    }
  };

  const deleteCard = async (id: string) => {
    if (!user) {
      toast.error('Please sign in to delete cards');
      return;
    }

    const { error } = await supabase.from('credit_cards').delete().eq('id', id);

    if (error) {
      console.error('Error deleting card:', error);
      toast.error('Failed to delete card');
    } else {
      setCards((prev) => prev.filter((card) => card.id !== id));
      toast.success('Card deleted');
    }
  };

  const reorderCards = async (reorderedCards: CreditCard[]) => {
    if (!user) return;

    // Optimistically update the UI
    setCards(reorderedCards);

    // Update the display_order for each card in the database
    const updates = reorderedCards.map((card, index) => ({
      id: card.id,
      display_order: index,
    }));

    // Update each card's display_order
    for (const update of updates) {
      const { error } = await supabase
        .from('credit_cards')
        .update({ display_order: update.display_order })
        .eq('id', update.id);

      if (error) {
        console.error('Error updating card order:', error);
        // Refetch to restore correct order on error
        const { data } = await supabase
          .from('credit_cards')
          .select('*')
          .order('display_order', { ascending: true });
        if (data) {
          setCards((data as unknown as DbCard[]).map(dbToModel));
        }
        toast.error('Failed to save card order');
        return;
      }
    }
  };

  return { cards, loading, addCard, updateCard, deleteCard, reorderCards };
}
