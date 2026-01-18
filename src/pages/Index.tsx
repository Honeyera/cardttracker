import { useState } from 'react';
import { useCreditCards } from '@/hooks/useCreditCards';
import { CreditCardItem } from '@/components/CreditCardItem';
import { AddCardDialog } from '@/components/AddCardDialog';
import { UploadScreenshotDialog } from '@/components/UploadScreenshotDialog';
import { UpcomingDates } from '@/components/UpcomingDates';
import { DashboardStats } from '@/components/DashboardStats';
import { Button } from '@/components/ui/button';
import { Plus, CreditCard, Wallet, Upload } from 'lucide-react';
import { CreditCard as CreditCardType } from '@/types/creditCard';

const Index = () => {
  const { cards, addCard, updateCard, deleteCard } = useCreditCards();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCardType | null>(null);

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

  const handleCardsUpdated = (updates: { id: string; currentBalance: number }[]) => {
    updates.forEach(({ id, currentBalance }) => {
      updateCard(id, { currentBalance });
    });
  };

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
            <Button onClick={() => setUploadDialogOpen(true)} size="sm" variant="outline">
              <Upload className="w-4 h-4 mr-1" />
              Upload Screenshot
            </Button>
            <Button onClick={() => setDialogOpen(true)} size="sm">
              <Plus className="w-4 h-4 mr-1" />
              Add Card
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Dashboard Stats */}
        <DashboardStats cards={cards} />

        {/* Upcoming Dates Section */}
        <UpcomingDates cards={cards} />

        {/* Cards Section */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <CreditCard className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">Your Cards</h2>
          </div>

          {cards.length === 0 ? (
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => (
                <CreditCardItem
                  key={card.id}
                  card={card}
                  onEdit={handleEdit}
                  onDelete={deleteCard}
                />
              ))}
            </div>
          )}
        </div>
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
