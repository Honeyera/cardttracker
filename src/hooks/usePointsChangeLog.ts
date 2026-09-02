import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export type PointsChangeLogEntry = {
  id: string;
  card_id: string;
  old_points: number;
  new_points: number;
  changed_at: string;
  source: string;
};

export function usePointsChangeLog() {
  const [changeLog, setChangeLog] = useState<PointsChangeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  const fetchChangeLog = useCallback(async () => {
    if (!user) {
      setChangeLog([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from('points_change_log')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Error fetching points change log:', error);
      setChangeLog([]);
    } else {
      setChangeLog((data || []) as PointsChangeLogEntry[]);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchChangeLog();
  }, [fetchChangeLog]);

  return { changeLog, loading, refresh: fetchChangeLog };
}
