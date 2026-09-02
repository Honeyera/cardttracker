import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { useCreditCards } from '@/hooks/useCreditCards';
import { useAuth } from '@/contexts/AuthContext';
import { SortableCardItem } from '@/components/SortableCardItem';
import { AddCardDialog } from '@/components/AddCardDialog';
import { UploadScreenshotDialog } from '@/components/UploadScreenshotDialog';
import { PasteTextDialog } from '@/components/PasteTextDialog';
import { UpcomingDates } from '@/components/UpcomingDates';
import { CreditCardTable } from '@/components/CreditCardTable';
import { ChargeRecommendation } from '@/components/ChargeRecommendation';
import { DashboardStats } from '@/components/DashboardStats';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, CreditCard, Wallet, Upload, Loader2, LayoutGrid, Table, ClipboardPaste, Search, Building2, Trophy, LayoutDashboard } from 'lucide-react';
import { Link } from 'react-router-dom';
import { UserMenu } from '@/components/UserMenu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CreditCard as CreditCardType } from '@/types/creditCard';

const Index = () => {
  const { cards, loading: cardsLoading, addCard, updateCard, deleteCard, reorderCards } = useCreditCards();
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [pasteDialogOpen, setPasteDialogOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCompany, setSelectedCompany] = useState<string>('all');

  const companies = useMemo(() => {
    const names = new Set<string>();
    cards.forEach(card => {
      if (card.companyName) names.add(card.companyName);
    });
    return Array.from(names).sort();
  }, [cards]);

  const companyFilteredCards = useMemo(() => {
    if (selectedCompany === 'all') return cards;
    return cards.filter(card => card.companyName === selectedCompany);
  }, [cards, selectedCompany]);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8,
    },
  });
  
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  
  const sensors = useSensors(pointerSensor, keyboardSensor);
  
  const filteredCards = useMemo(() => {
    if (!searchQuery.trim()) return companyFilteredCards;
    const q = searchQuery.toLowerCase();
    return companyFilteredCards.filter(
      (card) =>
        card.lastFiveDigits.includes(q) ||
        card.name.toLowerCase().includes(q) ||
        card.ownerName?.toLowerCase().includes(q) ||
        card.companyName?.toLowerCase().includes(q)
    );
  }, [companyFilteredCards, searchQuery]);

  const cardIds = useMemo(() => filteredCards.map((card) => card.id), [filteredCards]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  const handleEdit = (card: CreditCardType) => {
    setEditingCard(card);
    setDialogOpen(true);
  };

  const handleDialogClose = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditingCard(null);
    }
  };

  const handleCardsFromScreenshot = (newCards: Omit<CreditCardType, 'id'>[]) => {
    newCards.forEach((card) => addCard(card));
  };

  const handleCardsUpdated = (updates: { id: string; currentBalance: number; totalBalance?: number; paymentStatus?: string | null }[]) => {
    updates.forEach(({ id, currentBalance, totalBalance, paymentStatus }) => {
      updateCard(id, { currentBalance, totalBalance, paymentStatus });
    });
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  const handleBalanceUpdate = (id: string, field: 'currentBalance' | 'totalBalance', value: number) => {
    updateCard(id, { [field]: value });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = cards.findIndex((card) => card.id === active.id);
      const newIndex = cards.findIndex((card) => card.id === over.id);
      const reordered = arrayMove(cards, oldIndex, newIndex);
      reorderCards(reordered);
    }
  };

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
            <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
              <Wallet className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">CardTrack</h1>
              <p className="text-xs text-muted-foreground">
                Never miss a payment
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/dashboard">
                <LayoutDashboard className="w-4 h-4 mr-1" />
                Dashboard
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/points">
                <Trophy className="w-4 h-4 mr-1" />
                Points
              </Link>
            </Button>
            <Button onClick={() => setUploadDialogOpen(true)} size="sm" variant="outline">
              <Upload className="w-4 h-4 mr-1" />
              Screenshot
            </Button>
            <Button onClick={() => setPasteDialogOpen(true)} size="sm" variant="outline">
              <ClipboardPaste className="w-4 h-4 mr-1" />
              Paste Text
            </Button>
            <Button onClick={() => setDialogOpen(true)} size="sm">
              <Plus className="w-4 h-4 mr-1" />
              Add Card
            </Button>
            <UserMenu userEmail={user?.email || ''} onSignOut={handleSignOut} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Company Filter */}
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Company:</span>
          <Select value={selectedCompany} onValueChange={setSelectedCompany}>
            <SelectTrigger className="w-[200px] h-9 text-sm">
              <SelectValue placeholder="All Companies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Companies</SelectItem>
              {companies.map(company => (
                <SelectItem key={company} value={company}>{company}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Active Company Banner */}
        {selectedCompany !== 'all' && (
          <div className="flex items-center justify-between bg-primary/10 border border-primary/20 rounded-xl px-5 py-3">
            <div className="flex items-center gap-3">
              <Building2 className="w-5 h-5 text-primary" />
              <span className="text-lg font-bold text-primary">{selectedCompany}</span>
              <span className="text-sm text-muted-foreground">
                — {companyFilteredCards.length} {companyFilteredCards.length === 1 ? 'card' : 'cards'}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSelectedCompany('all')} className="text-muted-foreground">
              Show All
            </Button>
          </div>
        )}

        {/* Dashboard Stats */}
        <DashboardStats cards={companyFilteredCards} />

        {/* Smart Charge Advisor */}
        {companyFilteredCards.length > 0 && <ChargeRecommendation cards={companyFilteredCards} />}

        {/* Cards Section with Tabs */}
        <Tabs defaultValue="cards" className="w-full">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">Your Cards</h2>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by card # or name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 w-48 h-8 text-sm"
                />
              </div>
            <TabsList>
              <TabsTrigger value="cards" className="gap-1.5">
                <LayoutGrid className="w-4 h-4" />
                Cards
              </TabsTrigger>
              <TabsTrigger value="table" className="gap-1.5">
                <Table className="w-4 h-4" />
                Table
              </TabsTrigger>
            </TabsList>
            </div>
          </div>

          <TabsContent value="cards" className="mt-0">
            {cardsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
              </div>
            ) : filteredCards.length === 0 ? (
              <div className="bg-card rounded-2xl p-12 text-center border border-dashed border-border">
                <CreditCard className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                {searchQuery.trim() ? (
                  <>
                    <h3 className="text-lg font-medium text-foreground mb-2">No matching cards</h3>
                    <p className="text-muted-foreground mb-4">No cards match "{searchQuery}"</p>
                    <Button variant="outline" onClick={() => setSearchQuery('')}>Clear Search</Button>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-medium text-foreground mb-2">No cards yet</h3>
                    <p className="text-muted-foreground mb-4">Add your first credit card to start tracking dates</p>
                    <Button onClick={() => setDialogOpen(true)}>
                      <Plus className="w-4 h-4 mr-2" />
                      Add Your First Card
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <>
                {filteredCards.length > 1 && (
                  <p className="text-xs text-muted-foreground mb-3">(drag to reorder)</p>
                )}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={cardIds}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {filteredCards.map((card) => (
                        <SortableCardItem
                          key={card.id}
                          card={card}
                          onEdit={handleEdit}
                          onDelete={deleteCard}
                          onUpdateBalance={handleBalanceUpdate}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </>
            )}
          </TabsContent>

          <TabsContent value="table" className="mt-0">
            <CreditCardTable cards={filteredCards} onEdit={handleEdit} onUpdateBalance={handleBalanceUpdate} />
          </TabsContent>
        </Tabs>

        {/* Upcoming Dates Section */}
        <UpcomingDates cards={companyFilteredCards} />
      </main>

      {/* Add/Edit Card Dialog */}
      <AddCardDialog
        open={dialogOpen}
        onOpenChange={handleDialogClose}
        onSave={addCard}
        onUpdate={updateCard}
        onDelete={deleteCard}
        editCard={editingCard}
      />

      {/* Upload Screenshot Dialog */}
      <UploadScreenshotDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        existingCards={cards}
        onCardsFound={handleCardsFromScreenshot}
        onCardsUpdated={handleCardsUpdated}
      />

      {/* Paste Text Dialog */}
      <PasteTextDialog
        open={pasteDialogOpen}
        onOpenChange={setPasteDialogOpen}
        existingCards={cards}
        onCardsFound={handleCardsFromScreenshot}
        onCardsUpdated={handleCardsUpdated}
      />
    </div>
  );
};

export default Index;
