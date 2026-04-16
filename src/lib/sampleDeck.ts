import type { Deck, Flashcard } from "../types";
import { createId } from "./ids";

function sampleCard(
  title: string,
  front: string,
  back: string,
  category: string,
  tags: string[],
  sourceRow: number
): Flashcard {
  const now = new Date().toISOString();

  return {
    id: createId("card"),
    title,
    front,
    back,
    category,
    tags,
    notes: "",
    sourceRow,
    createdAt: now,
    updatedAt: now
  };
}

export const sampleDeck: Deck = {
  id: createId("deck"),
  name: "Flashy Starter Deck",
  description: "A small sample deck showing simple Q&A cards, tags, and spaced review.",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cards: [
    sampleCard(
      "HTTP Status",
      "What does HTTP 404 mean?",
      "The server could not find the requested resource.",
      "Web Basics",
      ["networking", "http"],
      1
    ),
    sampleCard(
      "Mitochondria",
      "What is the primary role of mitochondria?",
      "They generate ATP through cellular respiration.",
      "Biology",
      ["cell", "science"],
      2
    ),
    sampleCard(
      "Spanish",
      "What is the Spanish word for apple?",
      "Manzana",
      "Language",
      ["spanish", "vocabulary"],
      3
    )
  ]
};
