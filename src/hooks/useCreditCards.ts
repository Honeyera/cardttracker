import { useEffect, useMemo, useState } from 'react';
import { CreditCard } from '@/types/creditCard';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

const LEGACY_STORAGE_KEY = 'credit-cards';
const MIGRATED_FLAG_PREFIX = 'credit-cards-migrated:';

type DbCard = {
  id: string;
  name: string;
  owner_name: string | null;
  last_four: string | null;
  network: string | null;
  statement_date: number | null;
  due_date: number | null;
  credit_limit: number | null;
  current_balance: number | null;
  created_at: string;
};

function dbToModel(card: DbCard): CreditCard {
  return {
    id: card.id,
    name: card.name,
    ownerName: card.owner_name ?? undefined,
    lastFiveDigits: card.last_four || '00000',
    closingDay: card.statement_date || 1,
    dueDay: card.due_date || 15,
    // We store the theme color in `network` for now.
    color: (card.network as CreditCard['color']) || 'navy',
    creditLimit: Number(card.credit_limit) || 0,
    currentBalance: Number(card.current_balance) || 0,
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

      // 1) Fetch current cards from database
      const { data, error } = await supabase
        .from('credit_cards')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching cards:', error);
        toast.error('Failed to load cards');
        setCards([]);
        setLoading(false);
        return;
      }

      const dbCards = (data || []) as unknown as DbCard[];
      setCards(dbCards.map(dbToModel));

      // 2) One-time import from legacy localStorage (cards saved before login/sync existed)
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
            const toImport = legacyCards
              .filter((c) => {
                const key = getLegacyCardKey(c);
                return key !== '|' && !existingKeys.has(key);
              })
              .map((c) => ({
                user_id: user.id,
                name: String(c?.name ?? '').trim() || 'Untitled Card',
                owner_name: String(c?.ownerName ?? '').trim(),
                last_four: String(c?.lastFiveDigits ?? c?.lastFourDigits ?? '').trim() || '00000',
                network: (c?.color as string) || 'navy',
                statement_date: Number(c?.closingDay ?? 1) || 1,
                due_date: Number(c?.dueDay ?? 15) || 15,
                credit_limit: Number(c?.creditLimit ?? 0) || 0,
                current_balance: Number(c?.currentBalance ?? 0) || 0,
              }));

            if (toImport.length > 0) {
              const { error: insertError } = await supabase
                .from('credit_cards')
                .insert(toImport);

              if (!insertError) {
                toast.success(`Imported ${toImport.length} card(s) from this device`);
                // Re-fetch to show imported cards
                const { data: refreshed } = await supabase
                  .from('credit_cards')
                  .select('*')
                  .order('created_at', { ascending: false });
                setCards(((refreshed || []) as unknown as DbCard[]).map(dbToModel));
              } else {
                console.error('Error importing legacy cards:', insertError);
                toast.error('Could not import older cards from this device');
              }
            }

            // Mark as migrated even if nothing to import, to prevent repeated attempts.
            localStorage.setItem(migratedFlagKey, '1');
          }
        }
      } catch {
        // If legacy storage is malformed, just skip it.
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
      setCards((prev) => [dbToModel(data as unknown as DbCard), ...prev]);
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

    const { error } = await supabase.from('credit_cards').update(dbUpdates).eq('id', id);

    if (error) {
      console.error('Error updating card:', error);
      toast.error('Failed to update card');
    } else {
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
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

  return { cards, loading, addCard, updateCard, deleteCard };
}

