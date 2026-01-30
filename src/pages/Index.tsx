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
import { UpcomingDates } from '@/components/UpcomingDates';
import { CreditCardTable } from '@/components/CreditCardTable';
import { DashboardStats } from '@/components/DashboardStats';
import { TeamManagement } from '@/components/TeamManagement';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, CreditCard, Wallet, Upload, LogOut, Loader2, Users, LayoutGrid, Table } from 'lucide-react';
import { CreditCard as CreditCardType } from '@/types/creditCard';

const Index = () => {
  const { cards, loading: cardsLoading, addCard, updateCard, deleteCard, reorderCards } = useCreditCards();
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardType | null>(null);
  const [showTeamPanel, setShowTeamPanel] = useState(false);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8,
    },
  });
  
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  
  const sensors = useSensors(pointerSensor, keyboardSensor);
  
  const cardIds = useMemo(() => cards.map((card) => card.id), [cards]);

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

  const handleCardsUpdated = (updates: { id: string; currentBalance: number; totalBalance?: number; paymentStatus?: string }[]) => {
    updates.forEach(({ id, currentBalance, totalBalance, paymentStatus }) => {
      updateCard(id, { currentBalance, totalBalance, paymentStatus });
    });
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
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
            <Button onClick={() => setShowTeamPanel(!showTeamPanel)} size="sm" variant="outline">
              <Users className="w-4 h-4 mr-1" />
              Team
            </Button>
            <Button onClick={() => setUploadDialogOpen(true)} size="sm" variant="outline">
              <Upload className="w-4 h-4 mr-1" />
              Upload Screenshot
            </Button>
            <Button onClick={() => setDialogOpen(true)} size="sm">
              <Plus className="w-4 h-4 mr-1" />
              Add Card
            </Button>
            <Button onClick={handleSignOut} size="sm" variant="ghost">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Team Management Panel */}
        {showTeamPanel && <TeamManagement />}

        {/* Dashboard Stats */}
        <DashboardStats cards={cards} />

        {/* Cards Section with Tabs */}
        <Tabs defaultValue="cards" className="w-full">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">Your Cards</h2>
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

          <TabsContent value="cards" className="mt-0">
            {cardsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
              </div>
            ) : cards.length === 0 ? (
              <div className="bg-card rounded-2xl p-12 text-center border border-dashed border-border">
                <CreditCard className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">
                  No cards yet
                </h3>
                <p className="text-muted-foreground mb-4">
                  Add your first credit card to start tracking dates
                </p>
                <Button onClick={() => setDialogOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Your First Card
                </Button>
              </div>
            ) : (
              <>
                {cards.length > 1 && (
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
                      {cards.map((card) => (
                        <SortableCardItem
                          key={card.id}
                          card={card}
                          onEdit={handleEdit}
                          onDelete={deleteCard}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </>
            )}
          </TabsContent>

          <TabsContent value="table" className="mt-0">
            <CreditCardTable cards={cards} onEdit={handleEdit} />
          </TabsContent>
        </Tabs>

        {/* Upcoming Dates Section */}
        <UpcomingDates cards={cards} />
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
    </div>
  );
};

export default Index;
