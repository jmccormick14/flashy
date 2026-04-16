export type ReviewRating = "again" | "hard" | "good" | "easy";

export type Flashcard = {
  id: string;
  title: string;
  front: string;
  back: string;
  category?: string;
  tags: string[];
  notes?: string;
  sourceRow: number;
  createdAt: string;
  updatedAt: string;
};

export type Deck = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  cards: Flashcard[];
};

export type CardProgress = {
  cardId: string;
  dueAt: string;
  intervalDays: number;
  streak: number;
  totalReviews: number;
  lapseCount: number;
  lastReviewedAt?: string;
  lastRating?: ReviewRating;
};

export type DeckProgress = {
  deckId: string;
  cardProgress: Record<string, CardProgress>;
  starredCardIds: string[];
  recentCardIds: string[];
  sessionReviewedIds: string[];
};

export type ImportFieldKey =
  | "title"
  | "front"
  | "back"
  | "category"
  | "tags"
  | "notes"
  | "ignore";

export type ParsedImport = {
  headers: string[];
  rows: string[][];
  suggestedName: string;
};
