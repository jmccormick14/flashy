# Flashy

Offline-first general flashcard PWA with deck creation, browser search, import/export, and confidence-based review.

## Local Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```

## Notes

- Decks and review progress are stored locally in IndexedDB.
- JSON backup/restore is the canonical backup format.
- CSV export is available for spreadsheet-friendly editing.
- The app is designed to stay GitHub Pages friendly with no required backend.
