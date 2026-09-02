import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export type CardAvailablePoints = {
  id: string;
  card_id: string;
  available_points: number;
  updated_at: string;
};

export type PointsChangeSource = 'screenshot' | 'manual' | 'redemption' | 'restore';

export function useCardAvailablePoints() {
  const [availablePoints, setAvailablePoints] = useState<CardAvailablePoints[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    if (!user) {
      setAvailablePoints([]);
      setLoading(false);
      return;
    }

    const fetchAvailablePoints = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('card_available_points')
        .select('*');

      if (error) {
        console.error('Error fetching available points:', error);
        setAvailablePoints([]);
      } else {
        setAvailablePoints((data || []) as CardAvailablePoints[]);
      }
      setLoading(false);
    };

    fetchAvailablePoints();
  }, [user]);

  const upsertPoints = async (cardId: string, points: number, silent = false, source: PointsChangeSource = 'manual') => {
    if (!user) return;

    const existing = availablePoints.find((p) => p.card_id === cardId);
    const oldPoints = existing?.available_points ?? 0;

    // Use explicit update-or-insert to avoid upsert conflicts with legacy user_id rows
    let data: CardAvailablePoints | null = null;
    let error: unknown = null;

    if (existing?.id) {
      const result = await supabase
        .from('card_available_points')
        .update({ available_points: points, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      data = result.data as CardAvailablePoints | null;
      error = result.error;
    } else {
      const result = await supabase
        .from('card_available_points')
        .insert({ card_id: cardId, available_points: points, updated_at: new Date().toISOString() })
        .select()
        .single();
      data = result.data as CardAvailablePoints | null;
      error = result.error;
    }

    if (error) {
      console.error('Error updating available points:', error);
      toast.error('Failed to update points');
    } else if (data) {
      setAvailablePoints((prev) => {
        const exists = prev.find((p) => p.card_id === cardId);
        if (exists) {
          return prev.map((p) => (p.card_id === cardId ? (data as CardAvailablePoints) : p));
        }
        return [...prev, data as CardAvailablePoints];
      });
      if (!silent) toast.success('Available points updated');

      if (oldPoints !== points) {
        const { error: logError } = await (supabase as any)
          .from('points_change_log')
          .insert({ card_id: cardId, old_points: oldPoints, new_points: points, source });
        if (logError) {
          console.error('Error writing points change log:', logError);
        }
      }
    }
  };

  return { availablePoints, loading, upsertPoints };
}
