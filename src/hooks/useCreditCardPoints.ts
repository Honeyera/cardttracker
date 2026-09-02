import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export type PointEntry = {
  id: string;
  user_id: string;
  card_id: string | null;
  person: string;
  card_name: string;
  points_redeemed: number;
  redemption_date: string | null;
  notes: string | null;
  created_at: string;
};

export type NewPointEntry = Omit<PointEntry, 'id' | 'user_id' | 'created_at'>;

export function useCreditCardPoints() {
  const [points, setPoints] = useState<PointEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    if (!user) {
      setPoints([]);
      setLoading(false);
      return;
    }

    const fetchPoints = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('credit_card_points')
        .select('*')
        .order('redemption_date', { ascending: false });

      if (error) {
        console.error('Error fetching points:', error);
        toast.error('Failed to load points');
        setPoints([]);
      } else {
        setPoints((data || []) as PointEntry[]);
      }
      setLoading(false);
    };

    fetchPoints();
  }, [user]);

  const addPoint = async (entry: NewPointEntry) => {
    if (!user) {
      toast.error('Please sign in to add entries');
      return;
    }

    const { data, error } = await supabase
      .from('credit_card_points')
      .insert({ ...entry })
      .select()
      .single();

    if (error) {
      console.error('Error adding point entry:', error);
      toast.error('Failed to add entry');
    } else if (data) {
      setPoints((prev) => [data as PointEntry, ...prev].sort((a, b) => {
        const da = a.redemption_date || '';
        const db = b.redemption_date || '';
        return db.localeCompare(da);
      }));
      toast.success('Entry added');
    }
  };

  const updatePoint = async (id: string, updates: Partial<NewPointEntry>) => {
    if (!user) {
      toast.error('Please sign in to update entries');
      return;
    }

    const { data, error } = await supabase
      .from('credit_card_points')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating point entry:', error);
      toast.error('Failed to update entry');
    } else if (data) {
      setPoints((prev) =>
        prev
          .map((p) => (p.id === id ? (data as PointEntry) : p))
          .sort((a, b) => {
            const da = a.redemption_date || '';
            const db = b.redemption_date || '';
            return db.localeCompare(da);
          })
      );
      toast.success('Entry updated');
    }
  };

  const deletePoint = async (id: string) => {
    if (!user) {
      toast.error('Please sign in to delete entries');
      return;
    }

    const { error } = await supabase.from('credit_card_points').delete().eq('id', id);

    if (error) {
      console.error('Error deleting point entry:', error);
      toast.error('Failed to delete entry');
    } else {
      setPoints((prev) => prev.filter((p) => p.id !== id));
      toast.success('Entry deleted');
    }
  };

  return { points, loading, addPoint, updatePoint, deletePoint };
}
