import { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useCreditCardPoints, PointEntry } from '@/hooks/useCreditCardPoints';
import { useCreditCards } from '@/hooks/useCreditCards';
import { useCardAvailablePoints } from '@/hooks/useCardAvailablePoints';
import { usePointsChangeLog } from '@/hooks/usePointsChangeLog';
import { AddPointDialog } from '@/components/AddPointDialog';
import { UploadPointsScreenshotDialog } from '@/components/UploadPointsScreenshotDialog';
import { UserMenu } from '@/components/UserMenu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Trophy,
  Plus,
  Loader2,
  Search,
  Trash2,
  Pencil,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Wallet,
  Sparkles,
  Upload,
  History,
  TrendingUp,
  TrendingDown,
  Scale,
  CheckCircle2,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const PEOPLE = ['Tomer', 'Leo'] as const;

function AvailablePointsTile({
  cardName,
  lastFive,
  points,
  updatedAt,
  onSave,
}: {
  cardName: string;
  lastFive: string;
  points: number;
  updatedAt: string | null;
  onSave: (val: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(points.toString());
    setEditing(true);
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const val = parseInt(draft.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(val) && val >= 0) onSave(val);
    setEditing(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') setEditing(false);
  };

  return (
    <div className="bg-background rounded-xl border border-border p-4 flex flex-col gap-1">
      <p className="text-sm font-semibold text-foreground leading-tight truncate">{cardName}</p>
      <p className="text-xs text-muted-foreground font-mono mb-2">•••• {lastFive}</p>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          className="w-full text-lg font-bold bg-muted rounded px-2 py-1 outline-none ring-2 ring-primary text-foreground"
        />
      ) : (
        <button
          onClick={startEdit}
          className="text-left text-lg font-bold text-primary hover:text-primary/80 transition-colors"
          title="Click to update available points"
        >
          {formatPoints(points)}
          <span className="text-xs font-normal text-muted-foreground ml-1">pts</span>
        </button>
      )}
      {updatedAt && (
        <p className="text-xs text-muted-foreground mt-1">
          Updated {new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      )}
    </div>
  );
}

type SortField = 'person' | 'card_name' | 'points_redeemed' | 'redemption_date' | 'notes';
type SortDirection = 'asc' | 'desc';

function formatPoints(n: number) {
  return n.toLocaleString('en-US');
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Points() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { points, loading, addPoint, updatePoint, deletePoint } = useCreditCardPoints();
  const { cards } = useCreditCards();
  const { availablePoints, upsertPoints } = useCardAvailablePoints();
  const { changeLog, loading: changeLogLoading, refresh: refreshChangeLog } = usePointsChangeLog();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PointEntry | null>(null);
  const [editingCardEntryId, setEditingCardEntryId] = useState<string | null>(null);
  const [editingCardValue, setEditingCardValue] = useState<string>('');
  const [personFilter, setPersonFilter] = useState<'All' | 'Tomer' | 'Leo'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('redemption_date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [uploadPointsOpen, setUploadPointsOpen] = useState(false);
  const [changeLogOpen, setChangeLogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  const handleAddPoint = async (entry: Parameters<typeof addPoint>[0]) => {
    await addPoint(entry);
    const card = entry.card_id
      ? cards.find((c) => c.id === entry.card_id)
      : cards.find((c) => c.name === entry.card_name);
    if (card) {
      const current = availablePoints.find((ap) => ap.card_id === card.id);
      const newPts = Math.max(0, (current?.available_points ?? 0) - entry.points_redeemed);
      await upsertPoints(card.id, newPts, true, 'redemption');
    }
    refreshChangeLog();

    // Fire-and-forget email with full card details
    const emailCard = entry.card_id
      ? cards.find((c) => c.id === entry.card_id)
      : cards.find((c) => c.name === entry.card_name);

    // Compute new totals including the entry just added (state may not yet reflect it)
    const newTomerTotal = tomerTotal + (entry.person === 'Tomer' ? entry.points_redeemed : 0);
    const newLeoTotal = leoTotal + (entry.person === 'Leo' ? entry.points_redeemed : 0);

    console.log('Sending email for:', entry.card_name, 'digits:', emailCard?.lastFiveDigits);
    supabase.functions.invoke('send-points-email', {
      body: {
        person: entry.person,
        card_name: entry.card_name,
        last_five_digits: emailCard?.lastFiveDigits ?? null,
        points_redeemed: entry.points_redeemed,
        redemption_date: entry.redemption_date,
        notes: entry.notes,
        tomer_total: newTomerTotal,
        leo_total: newLeoTotal,
      },
    }).then(({ data, error }) => {
      if (error) {
        console.error('Email notification failed:', error);
        toast.error('Email failed: ' + (error.message ?? JSON.stringify(error)));
      } else {
        console.log('Email sent:', data);
      }
    }).catch((err) => {
      console.error('Email error:', err);
      toast.error('Email error: ' + String(err));
    });
  };

  const handleDeletePoint = async (entry: PointEntry) => {
    const cardId = entry.card_id ?? cards.find((c) => c.name === entry.card_name)?.id;
    await deletePoint(entry.id);
    if (cardId) {
      const current = availablePoints.find((ap) => ap.card_id === cardId);
      const newPts = (current?.available_points ?? 0) + entry.points_redeemed;
      await upsertPoints(cardId, newPts, true, 'restore');
    }
    refreshChangeLog();
  };

  const startEditCard = (entry: PointEntry) => {
    setEditingCardEntryId(entry.id);
    // Store the current card's ID; fall back to first name match for old entries
    const currentId = entry.card_id ?? cards.find((c) => c.name === entry.card_name)?.id ?? '';
    setEditingCardValue(currentId);
  };

  const saveEditCard = async (entry: PointEntry) => {
    const newCardId = editingCardValue;
    const newCard = cards.find((c) => c.id === newCardId);
    if (!newCard) {
      setEditingCardEntryId(null);
      return;
    }
    if (newCardId === entry.card_id) {
      setEditingCardEntryId(null);
      return;
    }
    // Restore points to old card
    const oldCardId = entry.card_id ?? cards.find((c) => c.name === entry.card_name)?.id;
    if (oldCardId) {
      const oldCurrent = availablePoints.find((ap) => ap.card_id === oldCardId);
      await upsertPoints(oldCardId, (oldCurrent?.available_points ?? 0) + entry.points_redeemed, true, 'restore');
    }
    // Deduct points from new card
    const newCurrent = availablePoints.find((ap) => ap.card_id === newCard.id);
    await upsertPoints(newCard.id, Math.max(0, (newCurrent?.available_points ?? 0) - entry.points_redeemed), true, 'redemption');
    await updatePoint(entry.id, { card_name: newCard.name, card_id: newCard.id });
    setEditingCardEntryId(null);
    refreshChangeLog();
  };

  const handleUpdatePointsFromScreenshot = async (cardId: string, points: number) => {
    await upsertPoints(cardId, points, false, 'screenshot');
    refreshChangeLog();
  };

  const handleDialogClose = (open: boolean) => {
    setDialogOpen(open);
  };


  // Filter by person
  const personFilteredPoints = useMemo(() => {
    if (personFilter === 'All') return points;
    return points.filter((p) => p.person === personFilter);
  }, [points, personFilter]);

  // Filter by search
  const filteredPoints = useMemo(() => {
    if (!searchQuery.trim()) return personFilteredPoints;
    const q = searchQuery.toLowerCase();
    return personFilteredPoints.filter(
      (p) =>
        p.card_name.toLowerCase().includes(q) ||
        p.person.toLowerCase().includes(q) ||
        (p.notes || '').toLowerCase().includes(q)
    );
  }, [personFilteredPoints, searchQuery]);

  // Sort
  const sortedPoints = useMemo(() => {
    return [...filteredPoints].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'person':
          cmp = a.person.localeCompare(b.person);
          break;
        case 'card_name':
          cmp = a.card_name.localeCompare(b.card_name);
          break;
        case 'points_redeemed':
          cmp = a.points_redeemed - b.points_redeemed;
          break;
        case 'redemption_date':
          cmp = (a.redemption_date || '').localeCompare(b.redemption_date || '');
          break;
        case 'notes':
          cmp = (a.notes || '').localeCompare(b.notes || '');
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [filteredPoints, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection(field === 'redemption_date' ? 'desc' : 'asc');
    }
  };

  // Summary stats (respect person filter)
  const totalPoints = useMemo(
    () => personFilteredPoints.reduce((sum, p) => sum + p.points_redeemed, 0),
    [personFilteredPoints]
  );
  const tomerTotal = useMemo(
    () => points.filter((p) => p.person === 'Tomer').reduce((sum, p) => sum + p.points_redeemed, 0),
    [points]
  );
  const leoTotal = useMemo(
    () => points.filter((p) => p.person === 'Leo').reduce((sum, p) => sum + p.points_redeemed, 0),
    [points]
  );

  // Balances are calculated independently per card type. Tomer & Leo should
  // each take an equal amount within each type — Gold/Amex and Chase points
  // are not interchangeable, so they don't net against each other.
  const balanceByCategory = useMemo(() => {
    const goldIds = new Set(cards.filter((c) => c.color === 'gold').map((c) => c.id));
    const chaseIds = new Set(
      cards
        .filter((c) => {
          const haystack = `${c.companyName ?? ''} ${c.name ?? ''}`.toLowerCase();
          return haystack.includes('chase');
        })
        .map((c) => c.id)
    );

    const categorize = (p: PointEntry): 'gold' | 'chase' | null => {
      const cardId = p.card_id ?? cards.find((c) => c.name === p.card_name)?.id;
      if (cardId && goldIds.has(cardId)) return 'gold';
      if (cardId && chaseIds.has(cardId)) return 'chase';
      const name = (p.card_name ?? '').toLowerCase();
      if (name.includes('gold')) return 'gold';
      if (name.includes('chase')) return 'chase';
      return null;
    };

    let tomerGold = 0, leoGold = 0, tomerChase = 0, leoChase = 0;
    points.forEach((p) => {
      const cat = categorize(p);
      if (cat === 'gold') {
        if (p.person === 'Tomer') tomerGold += p.points_redeemed;
        else if (p.person === 'Leo') leoGold += p.points_redeemed;
      } else if (cat === 'chase') {
        if (p.person === 'Tomer') tomerChase += p.points_redeemed;
        else if (p.person === 'Leo') leoChase += p.points_redeemed;
      }
    });

    const balanceFor = (tomer: number, leo: number) => {
      const d = tomer - leo;
      if (d === 0) {
        return { tomer, leo, even: true as const, amount: 0, owed: null as null | 'Tomer' | 'Leo', taker: null as null | 'Tomer' | 'Leo' };
      }
      return d > 0
        ? { tomer, leo, even: false as const, amount: d, owed: 'Leo' as const, taker: 'Tomer' as const }
        : { tomer, leo, even: false as const, amount: -d, owed: 'Tomer' as const, taker: 'Leo' as const };
    };

    return {
      gold: balanceFor(tomerGold, leoGold),
      chase: balanceFor(tomerChase, leoChase),
    };
  }, [points, cards]);

  // Available-points totals by category
  const goldCardsTotal = useMemo(() => {
    const goldIds = new Set(cards.filter((c) => c.color === 'gold').map((c) => c.id));
    return availablePoints
      .filter((ap) => goldIds.has(ap.card_id))
      .reduce((sum, ap) => sum + (ap.available_points ?? 0), 0);
  }, [cards, availablePoints]);

  const chaseCardsTotal = useMemo(() => {
    const chaseIds = new Set(
      cards
        .filter((c) => {
          const haystack = `${c.companyName ?? ''} ${c.name ?? ''}`.toLowerCase();
          return haystack.includes('chase');
        })
        .map((c) => c.id)
    );
    return availablePoints
      .filter((ap) => chaseIds.has(ap.card_id))
      .reduce((sum, ap) => sum + (ap.available_points ?? 0), 0);
  }, [cards, availablePoints]);

  // Summary by card (all entries, ignores person filter)
  const summaryByCard = useMemo(() => {
    const map = new Map<string, { total: number; tomer: number; leo: number; entries: number }>();
    points.forEach((p) => {
      const existing = map.get(p.card_name) || { total: 0, tomer: 0, leo: 0, entries: 0 };
      existing.total += p.points_redeemed;
      existing.entries += 1;
      if (p.person === 'Tomer') existing.tomer += p.points_redeemed;
      else if (p.person === 'Leo') existing.leo += p.points_redeemed;
      map.set(p.card_name, existing);
    });
    return Array.from(map.entries())
      .map(([cardName, stats]) => ({ cardName, ...stats }))
      .sort((a, b) => b.total - a.total);
  }, [points]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3.5 h-3.5 ml-1 opacity-50" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 ml-1" />
      : <ArrowDown className="w-3.5 h-3.5 ml-1" />;
  };

  const SortableHeader = ({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) => (
    <TableHead
      className={cn('cursor-pointer hover:bg-muted/50 transition-colors select-none', className)}
      onClick={() => handleSort(field)}
    >
      <div className="flex items-center">
        {children}
        <SortIcon field={field} />
      </div>
    </TableHead>
  );

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-3 group">
              <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
                <Trophy className="w-5 h-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">CardTrack Points</h1>
                <p className="text-xs text-muted-foreground">Track reward points redeemed</p>
              </div>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/">
                <Wallet className="w-4 h-4 mr-1" />
                Dashboard
              </Link>
            </Button>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-1" />
              Add Entry
            </Button>
            <UserMenu userEmail={user?.email || ''} onSignOut={handleSignOut} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Person Filter Pills */}
        <div className="flex items-center gap-2">
          {(['All', ...PEOPLE] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPersonFilter(p)}
              className={cn(
                'px-4 py-1.5 rounded-full text-sm font-medium transition-colors border',
                personFilter === p
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border hover:bg-muted'
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="rounded-2xl p-5 border border-border shadow-sm bg-gradient-to-br from-[hsl(45,80%,40%)] to-[hsl(35,70%,50%)] text-white">
            <p className="text-xs font-medium opacity-90 mb-1">Gold Cards Total</p>
            <p className="text-2xl font-bold">
              {formatPoints(goldCardsTotal)}
              <span className="text-xs font-normal opacity-90 ml-1">pts</span>
            </p>
          </div>
          <div className="rounded-2xl p-5 border border-border shadow-sm bg-gradient-to-br from-[hsl(220,70%,25%)] to-[hsl(220,60%,35%)] text-white">
            <p className="text-xs font-medium opacity-90 mb-1">CHASE Cards Total</p>
            <p className="text-2xl font-bold">
              {formatPoints(chaseCardsTotal)}
              <span className="text-xs font-normal opacity-90 ml-1">pts</span>
            </p>
          </div>
          <div className="bg-card rounded-2xl p-5 border border-border shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">Total Points Redeemed</p>
            <p className="text-2xl font-bold text-foreground">{formatPoints(totalPoints)}</p>
            {personFilter !== 'All' && (
              <p className="text-xs text-muted-foreground mt-1">{personFilter} only</p>
            )}
          </div>
          <div className="bg-card rounded-2xl p-5 border border-border shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">Tomer's Total</p>
            <p className="text-2xl font-bold text-blue-600">{formatPoints(tomerTotal)}</p>
          </div>
          <div className="bg-card rounded-2xl p-5 border border-border shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">Leo's Total</p>
            <p className="text-2xl font-bold text-teal-600">{formatPoints(leoTotal)}</p>
          </div>
          <div className="bg-card rounded-2xl p-5 border border-border shadow-sm">
            <p className="text-xs text-muted-foreground mb-1">Total Entries</p>
            <p className="text-2xl font-bold text-foreground">{personFilteredPoints.length}</p>
          </div>
        </div>

        {/* Points Balance — separate per card type (Gold/Amex and Chase points are not interchangeable) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(['gold', 'chase'] as const).map((cat) => {
            const b = balanceByCategory[cat];
            const label = cat === 'gold' ? 'Gold (Amex) Balance' : 'Chase Balance';
            const dot = cat === 'gold' ? 'bg-[hsl(40,75%,50%)]' : 'bg-[hsl(220,65%,30%)]';
            return (
              <div
                key={cat}
                className={cn(
                  'rounded-2xl p-6 border shadow-sm',
                  b.even
                    ? 'bg-gradient-to-br from-emerald-50 to-emerald-100 border-emerald-200 dark:from-emerald-950/40 dark:to-emerald-900/30 dark:border-emerald-800/50'
                    : 'bg-gradient-to-br from-amber-50 to-amber-100 border-amber-200 dark:from-amber-950/40 dark:to-amber-900/30 dark:border-amber-800/50'
                )}
              >
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'w-11 h-11 rounded-xl flex items-center justify-center',
                        b.even
                          ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                          : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                      )}
                    >
                      {b.even ? <CheckCircle2 className="w-5 h-5" /> : <Scale className="w-5 h-5" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={cn('w-2.5 h-2.5 rounded-full', dot)} />
                        <p className="text-sm font-medium text-muted-foreground">{label}</p>
                      </div>
                      {b.even ? (
                        <p className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">
                          {b.tomer === 0 && b.leo === 0
                            ? 'No points taken yet'
                            : 'All even'}
                        </p>
                      ) : (
                        <p className="text-lg font-semibold text-foreground">
                          <span
                            className={cn(
                              b.owed === 'Tomer' ? 'text-blue-600' : 'text-teal-600'
                            )}
                          >
                            {b.owed}
                          </span>{' '}
                          is owed{' '}
                          <span className="font-mono tabular-nums">{formatPoints(b.amount)}</span> pts
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-6 text-sm mt-4 pt-4 border-t border-border/40">
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Tomer took</p>
                    <p className="font-mono tabular-nums font-semibold text-blue-600">
                      {formatPoints(b.tomer)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Leo took</p>
                    <p className="font-mono tabular-nums font-semibold text-teal-600">
                      {formatPoints(b.leo)}
                    </p>
                  </div>
                  {!b.even && (
                    <div className="text-right border-l border-border pl-6 ml-auto">
                      <p className="text-xs text-muted-foreground">{b.taker} took more by</p>
                      <p className="font-mono tabular-nums font-bold text-amber-700 dark:text-amber-300">
                        {formatPoints(b.amount)}
                      </p>
                    </div>
                  )}
                </div>
                {!b.even && (
                  <p className="text-xs text-muted-foreground mt-3">
                    {b.owed} should take {formatPoints(b.amount)} more {cat === 'gold' ? 'Gold/Amex' : 'Chase'} points to even out.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Available Points Tiles */}
        {cards.length > 0 && (
          <div className="bg-card rounded-2xl p-6 border border-border shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold text-foreground">Available Points</h2>
                <span className="text-xs text-muted-foreground">(click a value to edit)</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => setUploadPointsOpen(true)}>
                <Upload className="w-4 h-4 mr-1" />
                Upload Screenshot
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {cards.map((card) => {
                const entry = availablePoints.find((ap) => ap.card_id === card.id);
                const pts = entry?.available_points ?? 0;
                return (
                  <AvailablePointsTile
                    key={card.id}
                    cardName={card.name}
                    lastFive={card.lastFiveDigits}
                    points={pts}
                    updatedAt={entry?.updated_at ?? null}
                    onSave={(val) => upsertPoints(card.id, val, false, 'manual').then(refreshChangeLog)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Table Section */}
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">Points History</h2>
              <span className="text-sm text-muted-foreground">({filteredPoints.length})</span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by card, person, notes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 w-56 h-8 text-sm"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : sortedPoints.length === 0 ? (
            <div className="bg-card rounded-2xl p-12 text-center border border-dashed border-border">
              <Trophy className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              {searchQuery.trim() ? (
                <>
                  <h3 className="text-lg font-medium text-foreground mb-2">No matching entries</h3>
                  <p className="text-muted-foreground mb-4">No entries match "{searchQuery}"</p>
                  <Button variant="outline" onClick={() => setSearchQuery('')}>
                    Clear Search
                  </Button>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-medium text-foreground mb-2">No points tracked yet</h3>
                  <p className="text-muted-foreground mb-4">Add your first entry to start tracking</p>
                  <Button onClick={() => setDialogOpen(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add Your First Entry
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader field="person">Person</SortableHeader>
                    <SortableHeader field="card_name">Card Name</SortableHeader>
                    <SortableHeader field="points_redeemed" className="text-right">
                      Points Redeemed
                    </SortableHeader>
                    <SortableHeader field="redemption_date">Date</SortableHeader>
                    <SortableHeader field="notes">Notes</SortableHeader>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedPoints.map((entry) => (
                    <TableRow key={entry.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <span
                          className={cn(
                            'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                            entry.person === 'Tomer'
                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                              : 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'
                          )}
                        >
                          {entry.person}
                        </span>
                      </TableCell>
                      <TableCell className="font-medium">
                        {editingCardEntryId === entry.id ? (
                          <div className="flex items-center gap-1.5">
                            <Select
                              value={editingCardValue}
                              onValueChange={setEditingCardValue}
                            >
                              <SelectTrigger className="h-7 text-sm w-52">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {cards.map((card) => (
                                  <SelectItem key={card.id} value={card.id}>
                                    <span className="font-medium">{card.name}</span>
                                    <span className="text-muted-foreground font-mono text-xs ml-1.5">
                                      •••• {card.lastFiveDigits}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => saveEditCard(entry)}
                            >
                              Save
                            </Button>
                          </div>
                        ) : (
                          <>
                            {entry.card_name}
                            {(() => {
                              const card = entry.card_id
                                ? cards.find((c) => c.id === entry.card_id)
                                : cards.find((c) => c.name === entry.card_name);
                              return card ? (
                                <span className="text-xs text-muted-foreground font-mono font-normal ml-1.5">
                                  •••• {card.lastFiveDigits}
                                </span>
                              ) : null;
                            })()}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums font-semibold">
                        {formatPoints(entry.points_redeemed)}
                      </TableCell>
                      <TableCell className="text-sm">{formatDate(entry.redemption_date)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {entry.notes || <span className="opacity-40">—</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {editingCardEntryId === entry.id ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={() => setEditingCardEntryId(null)}
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => startEditCard(entry)}
                              title="Edit card"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(entry)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Summary by Card */}
        {summaryByCard.length > 0 && (
          <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-6 py-4 hover:bg-muted/50 transition-colors"
              onClick={() => setSummaryOpen((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-primary" />
                <span className="text-lg font-semibold text-foreground">Summary by Card</span>
              </div>
              {summaryOpen ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </button>

            {summaryOpen && (
              <div className="px-6 pb-6">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Card Name</TableHead>
                        <TableHead className="text-right">Total Points</TableHead>
                        <TableHead className="text-right">Tomer</TableHead>
                        <TableHead className="text-right">Leo</TableHead>
                        <TableHead className="text-right">Entries</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summaryByCard.map(({ cardName, total, tomer, leo, entries }) => (
                        <TableRow key={cardName} className="hover:bg-muted/50 transition-colors">
                          <TableCell className="font-medium">{cardName}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums font-semibold">
                            {formatPoints(total)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-blue-600">
                            {tomer > 0 ? formatPoints(tomer) : <span className="text-muted-foreground/40">—</span>}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-teal-600">
                            {leo > 0 ? formatPoints(leo) : <span className="text-muted-foreground/40">—</span>}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">{entries}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Points Change Log */}
        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-muted/50 transition-colors"
            onClick={() => setChangeLogOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <History className="w-5 h-5 text-primary" />
              <span className="text-lg font-semibold text-foreground">Points Change Log</span>
              {changeLog.length > 0 && (
                <span className="text-xs text-muted-foreground">({changeLog.length})</span>
              )}
            </div>
            {changeLogOpen ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </button>

          {changeLogOpen && (
            <div className="px-6 pb-6">
              {changeLogLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : changeLog.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No changes recorded yet. Upload a screenshot or edit points to start logging.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Card</TableHead>
                        <TableHead className="text-right">Before</TableHead>
                        <TableHead className="text-right">After</TableHead>
                        <TableHead className="text-right">Change</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {changeLog.map((entry) => {
                        const card = cards.find((c) => c.id === entry.card_id);
                        const diff = entry.new_points - entry.old_points;
                        const gained = diff > 0;
                        const sourceLabels: Record<string, string> = {
                          screenshot: 'Screenshot',
                          manual: 'Manual Edit',
                          redemption: 'Redemption',
                          restore: 'Restored',
                        };
                        return (
                          <TableRow key={entry.id} className="hover:bg-muted/50 transition-colors">
                            <TableCell className="font-medium">
                              {card ? (
                                <>
                                  {card.name}
                                  <span className="text-xs text-muted-foreground font-mono font-normal ml-1.5">
                                    •••• {card.lastFiveDigits}
                                  </span>
                                </>
                              ) : (
                                <span className="text-muted-foreground text-xs">Unknown card</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                              {formatPoints(entry.old_points)}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums font-semibold">
                              {formatPoints(entry.new_points)}
                            </TableCell>
                            <TableCell className="text-right">
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 font-mono tabular-nums text-sm font-semibold',
                                  gained ? 'text-emerald-600' : 'text-destructive'
                                )}
                              >
                                {gained ? (
                                  <TrendingUp className="w-3.5 h-3.5" />
                                ) : (
                                  <TrendingDown className="w-3.5 h-3.5" />
                                )}
                                {gained ? '+' : ''}{formatPoints(diff)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                                {sourceLabels[entry.source] ?? entry.source}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {new Date(entry.changed_at).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}{' '}
                              <span className="text-xs">
                                {new Date(entry.changed_at).toLocaleTimeString('en-US', {
                                  hour: 'numeric',
                                  minute: '2-digit',
                                })}
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <AddPointDialog
        open={dialogOpen}
        onOpenChange={handleDialogClose}
        onSave={handleAddPoint}
        cards={cards}
        availablePoints={availablePoints}
      />

      <UploadPointsScreenshotDialog
        open={uploadPointsOpen}
        onOpenChange={setUploadPointsOpen}
        existingCards={cards}
        currentAvailablePoints={availablePoints}
        pointsLog={points}
        onUpdatePoints={handleUpdatePointsFromScreenshot}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this points entry for{' '}
              <strong>{deleteTarget?.card_name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) handleDeletePoint(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
