import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  buildDeckFromImport,
  parseImportText,
  suggestFieldMapping
} from "./lib/importer";
import { createId } from "./lib/ids";
import {
  deleteDeck,
  ensureSeedDeck,
  getDecks,
  getProgress,
  saveDeck,
  saveProgress
} from "./lib/storage";
import type {
  CardProgress,
  Deck,
  DeckProgress,
  Flashcard,
  ImportFieldKey,
  ParsedImport,
  ReviewRating
} from "./types";

const importOptions: ImportFieldKey[] = ["title", "front", "back", "category", "tags", "notes", "ignore"];

type ViewMode = "study" | "browse";
type StudyFilter = "due" | "new" | "all" | "starred" | "hard";
type StudyMode = "flash" | "write" | "quiz";

type ManualDeckDraft = {
  name: string;
  description: string;
};

type ManualCardDraft = {
  title: string;
  front: string;
  back: string;
  category: string;
  tags: string;
  notes: string;
};

type CardEditDraft = ManualCardDraft;

type DeckBackup = {
  version: 1;
  exportedAt: string;
  deck: Deck;
  progress: DeckProgress | null;
};

function normalizeList(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeRichTextHtml(value: string): string {
  if (typeof window === "undefined" || !/[<>]/.test(value)) {
    return value.replace(/\n/g, "<br />");
  }

  const allowedTags = new Set(["STRONG", "B", "EM", "I", "BR", "P", "UL", "OL", "LI", "CODE"]);
  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${value}</div>`, "text/html");

  const sanitizeNode = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;

      if (!allowedTags.has(element.tagName)) {
        const fragment = document.createDocumentFragment();
        while (element.firstChild) {
          fragment.appendChild(element.firstChild);
        }
        element.replaceWith(fragment);
        Array.from(fragment.childNodes).forEach(sanitizeNode);
        return;
      }

      Array.from(element.attributes).forEach((attribute) => {
        element.removeAttribute(attribute.name);
      });
    }

    Array.from(node.childNodes).forEach(sanitizeNode);
  };

  const root = document.body.firstElementChild;
  if (!root) {
    return value;
  }

  Array.from(root.childNodes).forEach(sanitizeNode);
  return root.innerHTML.replace(/\n/g, "<br />");
}

function slugifyFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "flashy-deck";
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, "\n");
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  return normalized;
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildEmptyDeck(draft: ManualDeckDraft): Deck {
  const now = new Date().toISOString();

  return {
    id: createId("deck"),
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    cards: []
  };
}

function buildCardFromDraft(draft: ManualCardDraft, sourceRow: number): Flashcard {
  const now = new Date().toISOString();

  return {
    id: createId("card"),
    title: draft.title.trim() || draft.front.trim().slice(0, 64),
    front: draft.front.trim(),
    back: draft.back.trim(),
    category: draft.category.trim() || undefined,
    tags: normalizeList(draft.tags),
    notes: draft.notes.trim() || undefined,
    sourceRow,
    createdAt: now,
    updatedAt: now
  };
}

function emptyCardDraft(): ManualCardDraft {
  return {
    title: "",
    front: "",
    back: "",
    category: "",
    tags: "",
    notes: ""
  };
}

function getCardProgress(progress: DeckProgress | null, cardId: string): CardProgress | undefined {
  return progress?.cardProgress[cardId];
}

function isDue(cardProgress: CardProgress | undefined, now: number): boolean {
  if (!cardProgress) {
    return false;
  }

  return new Date(cardProgress.dueAt).getTime() <= now;
}

function isWeakCard(cardProgress: CardProgress | undefined): boolean {
  if (!cardProgress) {
    return false;
  }

  return cardProgress.lapseCount > 0 || cardProgress.lastRating === "again" || cardProgress.lastRating === "hard";
}

function formatNextReview(cardProgress: CardProgress | undefined): string {
  if (!cardProgress) {
    return "New";
  }

  const due = new Date(cardProgress.dueAt);
  const now = Date.now();
  if (due.getTime() <= now) {
    return "Due now";
  }

  return due.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getCardSearchText(card: Flashcard): string {
  return [card.title, card.front, card.back, card.category ?? "", card.tags.join(" "), card.notes ?? ""]
    .join(" ")
    .toLowerCase();
}

function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAnswerPreview(value: string): string {
  const stripped = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length <= 88) {
    return stripped;
  }

  return `${stripped.slice(0, 85).trim()}...`;
}

function buildQuizOptions(cards: Flashcard[], currentCard: Flashcard): string[] {
  const distractors = cards
    .filter((card) => card.id !== currentCard.id)
    .map((card) => card.back)
    .filter((answer, index, values) => values.indexOf(answer) === index)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  return [currentCard.back, ...distractors].sort(() => Math.random() - 0.5);
}

function getReviewOrder(cards: Flashcard[], progress: DeckProgress | null): Flashcard[] {
  const now = Date.now();

  return [...cards].sort((left, right) => {
    const leftProgress = getCardProgress(progress, left.id);
    const rightProgress = getCardProgress(progress, right.id);
    const leftDue = isDue(leftProgress, now);
    const rightDue = isDue(rightProgress, now);

    if (leftDue !== rightDue) {
      return Number(rightDue) - Number(leftDue);
    }

    const leftNew = Number(!leftProgress);
    const rightNew = Number(!rightProgress);
    if (leftNew !== rightNew) {
      return rightNew - leftNew;
    }

    const leftDueTime = leftProgress ? new Date(leftProgress.dueAt).getTime() : Number.MIN_SAFE_INTEGER;
    const rightDueTime = rightProgress ? new Date(rightProgress.dueAt).getTime() : Number.MIN_SAFE_INTEGER;
    if (leftDueTime !== rightDueTime) {
      return leftDueTime - rightDueTime;
    }

    return (left.title || left.front).localeCompare(right.title || right.front);
  });
}

function buildUpdatedProgress(
  progress: DeckProgress,
  cardId: string,
  rating: ReviewRating
): DeckProgress {
  const now = new Date();
  const current = progress.cardProgress[cardId];
  const currentInterval = current?.intervalDays ?? 0;

  let intervalDays = 0;
  let nextDue = new Date(now);
  let streak = current?.streak ?? 0;
  let lapseCount = current?.lapseCount ?? 0;

  if (rating === "again") {
    intervalDays = 0;
    nextDue = new Date(now.getTime() + 10 * 60 * 1000);
    streak = 0;
    lapseCount += 1;
  } else if (rating === "hard") {
    intervalDays = Math.max(1, currentInterval > 0 ? Math.ceil(currentInterval * 1.2) : 1);
    nextDue = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
    streak = Math.max(1, streak);
  } else if (rating === "good") {
    intervalDays = currentInterval > 0 ? Math.max(1, Math.ceil(currentInterval * 2)) : 1;
    nextDue = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
    streak += 1;
  } else {
    intervalDays = currentInterval > 0 ? Math.max(3, Math.ceil(currentInterval * 3)) : 3;
    nextDue = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
    streak += 1;
  }

  return {
    ...progress,
    cardProgress: {
      ...progress.cardProgress,
      [cardId]: {
        cardId,
        dueAt: nextDue.toISOString(),
        intervalDays,
        streak,
        lapseCount,
        totalReviews: (current?.totalReviews ?? 0) + 1,
        lastReviewedAt: now.toISOString(),
        lastRating: rating
      }
    },
    recentCardIds: [cardId, ...progress.recentCardIds.filter((id) => id !== cardId)].slice(0, 12),
    sessionReviewedIds: Array.from(new Set([cardId, ...progress.sessionReviewedIds]))
  };
}

function isDeckBackup(value: unknown): value is DeckBackup {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeBackup = value as Partial<DeckBackup>;
  return maybeBackup.version === 1 && Boolean(maybeBackup.deck && typeof maybeBackup.exportedAt === "string");
}

export function App() {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [activeDeckId, setActiveDeckId] = useState("");
  const [progress, setProgress] = useState<DeckProgress | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("study");
  const [studyFilter, setStudyFilter] = useState<StudyFilter>("due");
  const [studyMode, setStudyMode] = useState<StudyMode>("flash");
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isCardFlipped, setIsCardFlipped] = useState(false);
  const [writeGuess, setWriteGuess] = useState("");
  const [writeReveal, setWriteReveal] = useState(false);
  const [quizOptions, setQuizOptions] = useState<string[]>([]);
  const [selectedQuizAnswer, setSelectedQuizAnswer] = useState("");
  const [browseSearch, setBrowseSearch] = useState("");
  const [selectedCardId, setSelectedCardId] = useState("");
  const [toast, setToast] = useState("");
  const [importName, setImportName] = useState("");
  const [importDraft, setImportDraft] = useState("");
  const [parsedImport, setParsedImport] = useState<ParsedImport | null>(null);
  const [fieldMapping, setFieldMapping] = useState<Record<number, ImportFieldKey>>({});
  const [manualDeckDraft, setManualDeckDraft] = useState<ManualDeckDraft>({ name: "", description: "" });
  const [manualCardDraft, setManualCardDraft] = useState<ManualCardDraft>(emptyCardDraft());
  const [isEditingCard, setIsEditingCard] = useState(false);
  const [cardEditDraft, setCardEditDraft] = useState<CardEditDraft | null>(null);
  const browseSearchRef = useRef<HTMLInputElement | null>(null);
  const deferredBrowseSearch = useDeferredValue(browseSearch);

  const activeDeck = useMemo(
    () => decks.find((deck) => deck.id === activeDeckId) ?? decks[0] ?? null,
    [activeDeckId, decks]
  );

  const activeCards = activeDeck?.cards ?? [];

  const deckCounts = useMemo(() => {
    const now = Date.now();
    let due = 0;
    let learned = 0;
    let weak = 0;

    activeCards.forEach((card) => {
      const cardProgress = getCardProgress(progress, card.id);
      if (cardProgress) {
        learned += 1;
      }
      if (isDue(cardProgress, now)) {
        due += 1;
      }
      if (isWeakCard(cardProgress)) {
        weak += 1;
      }
    });

    return {
      total: activeCards.length,
      due,
      learned,
      new: activeCards.length - learned,
      weak,
      starred: progress?.starredCardIds.length ?? 0,
      reviewed: progress?.sessionReviewedIds.length ?? 0
    };
  }, [activeCards, progress]);

  const studyCards = useMemo(() => {
    const now = Date.now();
    const ordered = getReviewOrder(activeCards, progress);

    return ordered.filter((card) => {
      const cardProgress = getCardProgress(progress, card.id);

      if (studyFilter === "due") {
        return isDue(cardProgress, now) || !cardProgress;
      }

      if (studyFilter === "new") {
        return !cardProgress;
      }

      if (studyFilter === "starred") {
        return progress?.starredCardIds.includes(card.id) ?? false;
      }

      if (studyFilter === "hard") {
        return isWeakCard(cardProgress);
      }

      return true;
    });
  }, [activeCards, progress, studyFilter]);

  const currentCard = studyCards[currentCardIndex] ?? null;
  const currentCardProgress = currentCard ? getCardProgress(progress, currentCard.id) : undefined;
  const currentCardBackHtml = currentCard ? sanitizeRichTextHtml(currentCard.back) : "";
  const normalizedWriteGuess = normalizeAnswer(writeGuess);
  const normalizedCurrentAnswer = normalizeAnswer(currentCard?.back ?? "");
  const writeGuessLooksCorrect =
    Boolean(normalizedWriteGuess) &&
    Boolean(normalizedCurrentAnswer) &&
    (normalizedCurrentAnswer.includes(normalizedWriteGuess) ||
      normalizedWriteGuess.includes(normalizedCurrentAnswer));

  const browseCards = useMemo(() => {
    const search = deferredBrowseSearch.trim().toLowerCase();
    const cards = [...activeCards].sort((left, right) =>
      (left.title || left.front).localeCompare(right.title || right.front)
    );

    if (!search) {
      return cards;
    }

    const prefixMatches = cards.filter((card) => {
      const label = (card.title || card.front).toLowerCase();
      return label.startsWith(search);
    });

    if (prefixMatches.length > 0) {
      return prefixMatches;
    }

    return cards.filter((card) => getCardSearchText(card).includes(search));
  }, [activeCards, deferredBrowseSearch]);

  const selectedCard = useMemo(
    () => activeDeck?.cards.find((card) => card.id === selectedCardId) ?? browseCards[0] ?? null,
    [activeDeck, browseCards, selectedCardId]
  );

  useEffect(() => {
    void (async () => {
      await ensureSeedDeck();
      const storedDecks = await getDecks();
      setDecks(storedDecks);
      if (storedDecks[0]) {
        setActiveDeckId(storedDecks[0].id);
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeDeck) {
      setProgress(null);
      return;
    }

    void getProgress(activeDeck.id).then((storedProgress) => {
      setProgress(storedProgress);
      setCurrentCardIndex(0);
      setIsCardFlipped(false);
      setWriteGuess("");
      setWriteReveal(false);
      setSelectedQuizAnswer("");
      setSelectedCardId(activeDeck.cards[0]?.id ?? "");
      setIsEditingCard(false);
      setCardEditDraft(null);
    });
  }, [activeDeck]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (currentCardIndex >= studyCards.length) {
      setCurrentCardIndex(0);
    }
  }, [currentCardIndex, studyCards.length]);

  useEffect(() => {
    if (browseCards.length === 0) {
      setSelectedCardId("");
      return;
    }

    if (!browseCards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(browseCards[0].id);
    }
  }, [browseCards, selectedCardId]);

  useEffect(() => {
    const handler = () => setToast("Update available. Reload when convenient.");
    window.addEventListener("pwa-update-available", handler);
    return () => window.removeEventListener("pwa-update-available", handler);
  }, []);

  useEffect(() => {
    setIsCardFlipped(false);
    setWriteGuess("");
    setWriteReveal(false);
    setSelectedQuizAnswer("");

    if (currentCard) {
      setQuizOptions(buildQuizOptions(studyCards, currentCard));
    } else {
      setQuizOptions([]);
    }
  }, [currentCard, studyCards, studyMode]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "/" && viewMode === "browse") {
        event.preventDefault();
        browseSearchRef.current?.focus();
        return;
      }

      if (viewMode !== "study" || !currentCard) {
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setStudyMode("flash");
        return;
      }

      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        setStudyMode("write");
        return;
      }

      if (event.key.toLowerCase() === "q") {
        event.preventDefault();
        setStudyMode("quiz");
        return;
      }

      if (event.key === " ") {
        if (studyMode !== "flash") {
          return;
        }
        event.preventDefault();
        setIsCardFlipped((value) => !value);
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setCurrentCardIndex((index) => Math.max(index - 1, 0));
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        setCurrentCardIndex((index) => Math.min(index + 1, Math.max(studyCards.length - 1, 0)));
        return;
      }

      const canRate =
        studyMode === "flash" ? isCardFlipped : studyMode === "write" ? writeReveal : Boolean(selectedQuizAnswer);

      if (!canRate) {
        return;
      }

      if (event.key === "1") {
        event.preventDefault();
        void reviewCard("again");
      } else if (event.key === "2") {
        event.preventDefault();
        void reviewCard("hard");
      } else if (event.key === "3") {
        event.preventDefault();
        void reviewCard("good");
      } else if (event.key === "4") {
        event.preventDefault();
        void reviewCard("easy");
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentCard, isCardFlipped, selectedQuizAnswer, studyCards.length, studyMode, viewMode, writeReveal]);

  async function reloadDecks(nextDeckId?: string) {
    const storedDecks = await getDecks();
    setDecks(storedDecks);
    setActiveDeckId(nextDeckId ?? storedDecks[0]?.id ?? "");
  }

  async function updateProgress(updater: (current: DeckProgress) => DeckProgress): Promise<void> {
    if (!progress) {
      return;
    }

    const nextProgress = updater(progress);
    setProgress(nextProgress);
    await saveProgress(nextProgress);
  }

  async function persistDeck(updater: (deck: Deck) => Deck): Promise<Deck | null> {
    if (!activeDeck) {
      return null;
    }

    const updatedDeck = updater({
      ...activeDeck,
      updatedAt: new Date().toISOString()
    });

    await saveDeck(updatedDeck);
    setDecks((current) =>
      current
        .map((deck) => (deck.id === updatedDeck.id ? updatedDeck : deck))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    );

    return updatedDeck;
  }

  async function createDeck() {
    const name = manualDeckDraft.name.trim();
    if (!name) {
      setToast("Enter a deck name first.");
      return;
    }

    const deck = buildEmptyDeck(manualDeckDraft);
    await saveDeck(deck);
    await reloadDecks(deck.id);
    setManualDeckDraft({ name: "", description: "" });
    setToast(`Created ${deck.name}.`);
  }

  async function addManualCard() {
    if (!activeDeck) {
      setToast("Create or select a deck first.");
      return;
    }

    if (!manualCardDraft.front.trim() || !manualCardDraft.back.trim()) {
      setToast("Front and back are required.");
      return;
    }

    const createdCard = buildCardFromDraft(manualCardDraft, activeDeck.cards.length + 1);
    const updatedDeck = await persistDeck((deck) => ({
      ...deck,
      cards: [createdCard, ...deck.cards]
    }));

    if (!updatedDeck) {
      return;
    }

    setManualCardDraft(emptyCardDraft());
    setSelectedCardId(createdCard.id);
    setViewMode("browse");
    setToast("Card added.");
  }

  function startEditCard(card: Flashcard | null) {
    if (!card) {
      return;
    }

    setCardEditDraft({
      title: card.title,
      front: card.front,
      back: card.back,
      category: card.category ?? "",
      tags: card.tags.join(", "),
      notes: card.notes ?? ""
    });
    setSelectedCardId(card.id);
    setIsEditingCard(true);
  }

  async function saveCardEdit() {
    if (!activeDeck || !selectedCard || !cardEditDraft) {
      return;
    }

    if (!cardEditDraft.front.trim() || !cardEditDraft.back.trim()) {
      setToast("Front and back are required.");
      return;
    }

    await persistDeck((deck) => ({
      ...deck,
      cards: deck.cards.map((card) =>
        card.id === selectedCard.id
          ? {
              ...card,
              title: cardEditDraft.title.trim() || cardEditDraft.front.trim().slice(0, 64),
              front: cardEditDraft.front.trim(),
              back: cardEditDraft.back.trim(),
              category: cardEditDraft.category.trim() || undefined,
              tags: normalizeList(cardEditDraft.tags),
              notes: cardEditDraft.notes.trim() || undefined,
              updatedAt: new Date().toISOString()
            }
          : card
      )
    }));

    setIsEditingCard(false);
    setCardEditDraft(null);
    setToast("Card updated.");
  }

  async function removeSelectedCard() {
    if (!activeDeck || !selectedCard) {
      return;
    }

    const remainingCards = activeDeck.cards.filter((card) => card.id !== selectedCard.id);
    await persistDeck((deck) => ({
      ...deck,
      cards: remainingCards
    }));

    if (progress) {
      const nextProgress: DeckProgress = {
        ...progress,
        cardProgress: Object.fromEntries(
          Object.entries(progress.cardProgress).filter(([cardId]) => cardId !== selectedCard.id)
        ),
        starredCardIds: progress.starredCardIds.filter((id) => id !== selectedCard.id),
        recentCardIds: progress.recentCardIds.filter((id) => id !== selectedCard.id),
        sessionReviewedIds: progress.sessionReviewedIds.filter((id) => id !== selectedCard.id)
      };
      setProgress(nextProgress);
      await saveProgress(nextProgress);
    }

    setSelectedCardId(remainingCards[0]?.id ?? "");
    setIsEditingCard(false);
    setCardEditDraft(null);
    setToast("Card removed.");
  }

  async function toggleStar(cardId: string) {
    await updateProgress((current) => ({
      ...current,
      starredCardIds: current.starredCardIds.includes(cardId)
        ? current.starredCardIds.filter((id) => id !== cardId)
        : [cardId, ...current.starredCardIds]
    }));
  }

  async function reviewCard(rating: ReviewRating) {
    if (!currentCard || !progress) {
      return;
    }

    const nextProgress = buildUpdatedProgress(progress, currentCard.id, rating);
    setProgress(nextProgress);
    await saveProgress(nextProgress);

    setIsCardFlipped(false);
    setWriteGuess("");
    setWriteReveal(false);
    setSelectedQuizAnswer("");
    setCurrentCardIndex((index) => Math.min(index + 1, Math.max(studyCards.length - 1, 0)));
  }

  async function resetSession() {
    if (!progress) {
      return;
    }

    const nextProgress = {
      ...progress,
      sessionReviewedIds: []
    };
    setProgress(nextProgress);
    await saveProgress(nextProgress);
    setToast("Session count cleared.");
  }

  function backupActiveDeck() {
    if (!activeDeck) {
      setToast("No active deck to back up.");
      return;
    }

    const backup: DeckBackup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      deck: activeDeck,
      progress
    };

    downloadTextFile(
      `${slugifyFileName(activeDeck.name)}-backup.json`,
      JSON.stringify(backup, null, 2),
      "application/json"
    );
    setToast("Backup downloaded.");
  }

  function exportDeckCsv() {
    if (!activeDeck) {
      setToast("No active deck to export.");
      return;
    }

    const headers = ["title", "front", "back", "category", "tags", "notes", "nextReview"];
    const rows = activeDeck.cards.map((card) => [
      card.title,
      card.front,
      card.back,
      card.category ?? "",
      card.tags.join("; "),
      card.notes ?? "",
      formatNextReview(getCardProgress(progress, card.id))
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
      .join("\n");

    downloadTextFile(`${slugifyFileName(activeDeck.name)}.csv`, csv, "text/csv;charset=utf-8");
    setToast("CSV exported.");
  }

  async function saveImportedDeck() {
    if (!parsedImport) {
      setToast("Parse a file or paste content first.");
      return;
    }

    const deck = buildDeckFromImport(importName || parsedImport.suggestedName, parsedImport, fieldMapping);
    if (deck.cards.length === 0) {
      setToast("No valid front/back pairs were found.");
      return;
    }

    await saveDeck(deck);
    await reloadDecks(deck.id);
    setParsedImport(null);
    setImportDraft("");
    setImportName("");
    setFieldMapping({});
    setToast(`Imported ${deck.cards.length} cards.`);
  }

  function parseImportedText(content: string, fileName?: string) {
    const parsed = parseImportText(content, fileName);
    setParsedImport(parsed);
    setImportDraft(content);
    setImportName(parsed.suggestedName);
    setFieldMapping(suggestFieldMapping(parsed.headers));
    setToast(`Parsed ${parsed.rows.length} rows.`);
  }

  async function importContent(content: string, fileName?: string) {
    try {
      const parsedJson = JSON.parse(content) as unknown;
      if (isDeckBackup(parsedJson)) {
        await saveDeck(parsedJson.deck);
        if (parsedJson.progress) {
          await saveProgress(parsedJson.progress);
        }
        await reloadDecks(parsedJson.deck.id);
        setToast(`Restored ${parsedJson.deck.name}.`);
        return;
      }
    } catch {
      // Non-JSON import; continue with standard parsing.
    }

    try {
      parseImportedText(content, fileName);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not parse import.");
    }
  }

  async function importFromFile(file: File | null) {
    if (!file) {
      return;
    }

    const content = await file.text();
    await importContent(content, file.name);
  }

  async function removeActiveDeck() {
    if (!activeDeck) {
      return;
    }

    await deleteDeck(activeDeck.id);
    await reloadDecks();
    setToast("Deck deleted.");
  }

  const canRateCurrentCard =
    studyMode === "flash" ? isCardFlipped : studyMode === "write" ? writeReveal : Boolean(selectedQuizAnswer);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="eyebrow">Flashy</p>
          <h1>Study Cards</h1>
          <p className="lede">
            Offline-first decks, quick card creation, browser search, and confidence-based review.
          </p>
        </div>

        <section className="panel">
          <div className="panel-header">
            <h2>Decks</h2>
          </div>
          <div className="deck-list">
            {decks.map((deck) => (
              <button
                key={deck.id}
                className={deck.id === activeDeck?.id ? "deck-button active" : "deck-button"}
                onClick={() => setActiveDeckId(deck.id)}
              >
                <strong>{deck.name}</strong>
                <small>{deck.cards.length} cards</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Create Deck</h2>
          </div>
          <label className="field-label">
            Deck name
            <input
              value={manualDeckDraft.name}
              onChange={(event) =>
                setManualDeckDraft((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Biology Midterm"
            />
          </label>
          <label className="field-label">
            Description
            <textarea
              rows={3}
              value={manualDeckDraft.description}
              onChange={(event) =>
                setManualDeckDraft((current) => ({ ...current, description: event.target.value }))
              }
              placeholder="Optional note about this deck"
            />
          </label>
          <button className="primary-button" onClick={() => void createDeck()}>
            Create deck
          </button>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Add Card</h2>
          </div>
          <label className="field-label">
            Title
            <input
              value={manualCardDraft.title}
              onChange={(event) =>
                setManualCardDraft((current) => ({ ...current, title: event.target.value }))
              }
              placeholder="Optional short label"
            />
          </label>
          <label className="field-label">
            Front
            <textarea
              rows={3}
              value={manualCardDraft.front}
              onChange={(event) =>
                setManualCardDraft((current) => ({ ...current, front: event.target.value }))
              }
              placeholder="Question or prompt"
            />
          </label>
          <label className="field-label">
            Back
            <textarea
              rows={4}
              value={manualCardDraft.back}
              onChange={(event) =>
                setManualCardDraft((current) => ({ ...current, back: event.target.value }))
              }
              placeholder="Answer or explanation"
            />
          </label>
          <label className="field-label">
            Category
            <input
              value={manualCardDraft.category}
              onChange={(event) =>
                setManualCardDraft((current) => ({ ...current, category: event.target.value }))
              }
            />
          </label>
          <label className="field-label">
            Tags
            <input
              value={manualCardDraft.tags}
              onChange={(event) =>
                setManualCardDraft((current) => ({ ...current, tags: event.target.value }))
              }
              placeholder="exam-1, anatomy"
            />
          </label>
          <label className="field-label">
            Notes
            <textarea
              rows={3}
              value={manualCardDraft.notes}
              onChange={(event) =>
                setManualCardDraft((current) => ({ ...current, notes: event.target.value }))
              }
            />
          </label>
          <button className="primary-button" onClick={() => void addManualCard()}>
            Add card
          </button>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Import</h2>
          </div>
          <label className="field-label">
            Deck name
            <input
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
              placeholder="Imported deck name"
            />
          </label>
          <label className="field-label">
            Upload file
            <input
              className="file-input"
              type="file"
              accept=".csv,.tsv,.txt,.json"
              onChange={(event) => void importFromFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label className="field-label">
            Paste cards
            <textarea
              rows={6}
              value={importDraft}
              onChange={(event) => setImportDraft(event.target.value)}
              placeholder="Paste CSV, TSV, JSON, or blank-line card blocks here"
            />
          </label>
          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => void importContent(importDraft, importName || "pasted.txt")}
            >
              Parse import
            </button>
            <button className="primary-button" onClick={() => void saveImportedDeck()}>
              Save import
            </button>
          </div>
          {parsedImport ? (
            <div className="mapping-grid">
              {parsedImport.headers.map((header, index) => (
                <label key={`${header}-${index}`} className="mapping-row">
                  <span>{header}</span>
                  <select
                    value={fieldMapping[index] ?? "ignore"}
                    onChange={(event) =>
                      setFieldMapping((current) => ({
                        ...current,
                        [index]: event.target.value as ImportFieldKey
                      }))
                    }
                  >
                    {importOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <p className="hint">Review mapping before saving. Flashy expects at least a front and back.</p>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Deck Actions</h2>
          </div>
          <div className="button-stack">
            <button className="secondary-button" onClick={backupActiveDeck}>
              Backup JSON
            </button>
            <button className="secondary-button" onClick={exportDeckCsv}>
              Export CSV
            </button>
            <button className="danger-button" onClick={() => void removeActiveDeck()}>
              Delete deck
            </button>
          </div>
        </section>
      </aside>

      <main className="main-content">
        <header className="topbar panel">
          <div>
            <p className="eyebrow">Deck Overview</p>
            <h2>{activeDeck?.name ?? "No deck selected"}</h2>
            <p className="hint">{activeDeck?.description ?? "Create or import a deck to get started."}</p>
          </div>
          <div className="mode-switch">
            <button className={viewMode === "study" ? "active" : ""} onClick={() => setViewMode("study")}>
              Study
            </button>
            <button className={viewMode === "browse" ? "active" : ""} onClick={() => setViewMode("browse")}>
              Browse
            </button>
          </div>
        </header>

        {viewMode === "study" ? (
          <section className="content-grid">
            <article className="panel hero-panel">
              <div className="panel-header study-header">
                <h2>Review Session</h2>
                <div className="study-toolbar">
                  <div className="pill-row">
                    <button className={studyFilter === "due" ? "pill active" : "pill"} onClick={() => setStudyFilter("due")}>
                      Due
                    </button>
                    <button className={studyFilter === "new" ? "pill active" : "pill"} onClick={() => setStudyFilter("new")}>
                      New
                    </button>
                    <button className={studyFilter === "hard" ? "pill active" : "pill"} onClick={() => setStudyFilter("hard")}>
                      Weak
                    </button>
                    <button
                      className={studyFilter === "starred" ? "pill active" : "pill"}
                      onClick={() => setStudyFilter("starred")}
                    >
                      Starred
                    </button>
                    <button className={studyFilter === "all" ? "pill active" : "pill"} onClick={() => setStudyFilter("all")}>
                      All
                    </button>
                  </div>
                  <div className="pill-row">
                    <button className={studyMode === "flash" ? "pill active" : "pill"} onClick={() => setStudyMode("flash")}>
                      Flash
                    </button>
                    <button className={studyMode === "write" ? "pill active" : "pill"} onClick={() => setStudyMode("write")}>
                      Write
                    </button>
                    <button className={studyMode === "quiz" ? "pill active" : "pill"} onClick={() => setStudyMode("quiz")}>
                      Quiz
                    </button>
                  </div>
                </div>
              </div>

              {currentCard ? (
                <>
                  {studyMode === "flash" ? (
                    <button
                      className={`flashcard ${isCardFlipped ? "flipped" : ""}`}
                      onClick={() => setIsCardFlipped((value) => !value)}
                    >
                      <div className="flashcard-face flashcard-front">
                        <span className="flashcard-label">{currentCard.title || currentCard.category || "Flashcard"}</span>
                        <h3>{currentCard.front}</h3>
                        <p>Space flips the card. Keys 1-4 rate it after you reveal the answer.</p>
                      </div>
                      <div className="flashcard-face flashcard-back">
                        <span className="flashcard-label">{currentCard.category ?? "Answer"}</span>
                        <div
                          className="flashcard-rich-content"
                          dangerouslySetInnerHTML={{ __html: currentCardBackHtml }}
                        />
                        {currentCard.notes ? <p className="card-notes">Notes: {currentCard.notes}</p> : null}
                      </div>
                    </button>
                  ) : studyMode === "write" ? (
                    <div className="study-mode-panel">
                      <span className="flashcard-label">{currentCard.title || currentCard.category || "Write"}</span>
                      <h3>{currentCard.front}</h3>
                      <label className="field-label">
                        Your answer
                        <textarea
                          rows={6}
                          value={writeGuess}
                          onChange={(event) => setWriteGuess(event.target.value)}
                          placeholder="Type your answer before revealing it"
                        />
                      </label>
                      <div className="button-row">
                        <button className="secondary-button" onClick={() => setWriteReveal(true)}>
                          Reveal answer
                        </button>
                        <span className={`answer-check ${writeGuessLooksCorrect ? "match" : ""}`}>
                          {writeGuess
                            ? writeGuessLooksCorrect
                              ? "Your answer is close."
                              : "Check against the official answer."
                            : "Type a guess first."}
                        </span>
                      </div>
                      {writeReveal ? (
                        <div className="reference-card">
                          <h3>Official answer</h3>
                          <div
                            className="flashcard-rich-content"
                            dangerouslySetInnerHTML={{ __html: currentCardBackHtml }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="study-mode-panel">
                      <span className="flashcard-label">{currentCard.title || currentCard.category || "Quiz"}</span>
                      <h3>{currentCard.front}</h3>
                      <div className="quiz-option-grid">
                        {quizOptions.map((option) => {
                          const isCorrect = option === currentCard.back;
                          const isChosen = selectedQuizAnswer === option;
                          const className = [
                            "quiz-option",
                            isChosen ? "selected" : "",
                            selectedQuizAnswer && isCorrect ? "correct" : "",
                            selectedQuizAnswer && isChosen && !isCorrect ? "wrong" : ""
                          ]
                            .filter(Boolean)
                            .join(" ");

                          return (
                            <button
                              key={option}
                              className={className}
                              onClick={() => setSelectedQuizAnswer(option)}
                              disabled={Boolean(selectedQuizAnswer)}
                            >
                              {getAnswerPreview(option)}
                            </button>
                          );
                        })}
                      </div>
                      {selectedQuizAnswer ? (
                        <div className="reference-card">
                          <h3>{selectedQuizAnswer === currentCard.back ? "Correct answer" : "Answer review"}</h3>
                          <div
                            className="flashcard-rich-content"
                            dangerouslySetInnerHTML={{ __html: currentCardBackHtml }}
                          />
                        </div>
                      ) : (
                        <p className="hint">Choose the best answer, then rate how it felt.</p>
                      )}
                    </div>
                  )}

                  <div className="study-footer">
                    <div className="study-progress">
                      Card {studyCards.length === 0 ? 0 : currentCardIndex + 1} of {studyCards.length} | Next review{" "}
                      {formatNextReview(currentCardProgress)}
                    </div>
                    <div className="button-row">
                      <button className="secondary-button" onClick={() => startEditCard(currentCard)}>
                        Edit
                      </button>
                      <button className="secondary-button" onClick={() => void toggleStar(currentCard.id)}>
                        {progress?.starredCardIds.includes(currentCard.id) ? "Unstar" : "Star"}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => setCurrentCardIndex((index) => Math.max(index - 1, 0))}
                      >
                        Previous
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => setCurrentCardIndex((index) => Math.min(index + 1, Math.max(studyCards.length - 1, 0)))}
                      >
                        Next
                      </button>
                    </div>
                  </div>

                  <div className="rating-row">
                    <button className="danger-button" onClick={() => void reviewCard("again")} disabled={!canRateCurrentCard}>
                      Again
                    </button>
                    <button className="secondary-button" onClick={() => void reviewCard("hard")} disabled={!canRateCurrentCard}>
                      Hard
                    </button>
                    <button className="success-button" onClick={() => void reviewCard("good")} disabled={!canRateCurrentCard}>
                      Good
                    </button>
                    <button className="primary-button" onClick={() => void reviewCard("easy")} disabled={!canRateCurrentCard}>
                      Easy
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <h3>No cards in this review slice.</h3>
                  <p>Switch filters, add cards, or import a deck.</p>
                </div>
              )}
            </article>

            <aside className="panel stats-panel">
              <div className="panel-header">
                <h2>Stats</h2>
                <button className="text-button" onClick={() => void resetSession()}>
                  Reset session
                </button>
              </div>
              <div className="stat-block">
                <strong>{deckCounts.total}</strong>
                <span>Total cards</span>
              </div>
              <div className="stat-block">
                <strong>{deckCounts.due}</strong>
                <span>Due now</span>
              </div>
              <div className="stat-block">
                <strong>{deckCounts.new}</strong>
                <span>New cards</span>
              </div>
              <div className="stat-block">
                <strong>{deckCounts.weak}</strong>
                <span>Weak cards</span>
              </div>
              <div className="stat-block">
                <strong>{deckCounts.starred}</strong>
                <span>Starred</span>
              </div>
              <div className="stat-block">
                <strong>{deckCounts.reviewed}</strong>
                <span>Reviewed this session</span>
              </div>
              <p className="hint">
                Flashy now supports classic flip cards, written recall, and multiple-choice quiz mode with no daily limits.
              </p>
            </aside>
          </section>
        ) : (
          <section className="content-grid browse-layout">
            <aside className="panel browse-list-panel">
              <div className="panel-header">
                <h2>Browse Cards</h2>
                <span className="hint">Press `/` to search</span>
              </div>
              <label className="field-label">
                Search
                <input
                  ref={browseSearchRef}
                  value={browseSearch}
                  onChange={(event) => setBrowseSearch(event.target.value)}
                  placeholder="Type to narrow cards"
                />
              </label>
              <label className="field-label">
                Cards
                <select
                  className="card-select"
                  size={14}
                  value={selectedCard?.id ?? ""}
                  onChange={(event) => setSelectedCardId(event.target.value)}
                >
                  {browseCards.map((card) => (
                    <option key={card.id} value={card.id}>
                      {card.title || card.front}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">{browseCards.length} cards match the current filter.</p>
            </aside>

            <article className="panel browse-detail-panel">
              {selectedCard ? (
                isEditingCard && cardEditDraft ? (
                  <div className="editor-panel">
                    <div className="panel-header">
                      <h2>Edit Card</h2>
                    </div>
                    <label className="field-label">
                      Title
                      <input
                        value={cardEditDraft.title}
                        onChange={(event) =>
                          setCardEditDraft((current) =>
                            current ? { ...current, title: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Front
                      <textarea
                        rows={4}
                        value={cardEditDraft.front}
                        onChange={(event) =>
                          setCardEditDraft((current) =>
                            current ? { ...current, front: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Back
                      <textarea
                        rows={6}
                        value={cardEditDraft.back}
                        onChange={(event) =>
                          setCardEditDraft((current) =>
                            current ? { ...current, back: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Category
                      <input
                        value={cardEditDraft.category}
                        onChange={(event) =>
                          setCardEditDraft((current) =>
                            current ? { ...current, category: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Tags
                      <input
                        value={cardEditDraft.tags}
                        onChange={(event) =>
                          setCardEditDraft((current) =>
                            current ? { ...current, tags: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label className="field-label">
                      Notes
                      <textarea
                        rows={4}
                        value={cardEditDraft.notes}
                        onChange={(event) =>
                          setCardEditDraft((current) =>
                            current ? { ...current, notes: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <div className="button-row">
                      <button className="primary-button" onClick={() => void saveCardEdit()}>
                        Save card
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setIsEditingCard(false);
                          setCardEditDraft(null);
                        }}
                      >
                        Cancel
                      </button>
                      <button className="danger-button" onClick={() => void removeSelectedCard()}>
                        Delete card
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="panel-header">
                      <div>
                        <p className="eyebrow">{selectedCard.category ?? "Card"}</p>
                        <h2>{selectedCard.title || selectedCard.front}</h2>
                        {selectedCard.tags.length > 0 ? (
                          <p className="hint">Tags: {selectedCard.tags.join(", ")}</p>
                        ) : null}
                      </div>
                      <div className="button-row compact-actions">
                        <button className="secondary-button" onClick={() => setViewMode("study")}>
                          Study deck
                        </button>
                        <button className="secondary-button" onClick={() => startEditCard(selectedCard)}>
                          Edit card
                        </button>
                        <button className="secondary-button" onClick={() => void toggleStar(selectedCard.id)}>
                          {progress?.starredCardIds.includes(selectedCard.id) ? "Unstar" : "Star"}
                        </button>
                      </div>
                    </div>

                    <div className="summary-strip">
                      <div className="summary-metric">
                        <strong>{formatNextReview(getCardProgress(progress, selectedCard.id))}</strong>
                        <span>Next review</span>
                      </div>
                      <div className="summary-metric">
                        <strong>{getCardProgress(progress, selectedCard.id)?.totalReviews ?? 0}</strong>
                        <span>Total reviews</span>
                      </div>
                      <div className="summary-metric">
                        <strong>{getCardProgress(progress, selectedCard.id)?.streak ?? 0}</strong>
                        <span>Current streak</span>
                      </div>
                    </div>

                    <div className="reference-grid">
                      <section className="reference-card">
                        <h3>Front</h3>
                        <p>{selectedCard.front}</p>
                      </section>
                      <section className="reference-card">
                        <h3>Back</h3>
                        <div
                          className="flashcard-rich-content"
                          dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(selectedCard.back) }}
                        />
                      </section>
                      {selectedCard.notes ? (
                        <section className="reference-card">
                          <h3>Notes</h3>
                          <p>{selectedCard.notes}</p>
                        </section>
                      ) : null}
                    </div>
                  </>
                )
              ) : (
                <div className="empty-state">
                  <h3>No cards found.</h3>
                  <p>Add cards manually or import a file.</p>
                </div>
              )}
            </article>
          </section>
        )}
      </main>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
