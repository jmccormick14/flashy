# Flashy Handoff

Last updated: 2026-04-16
Local path: `C:\Users\Owner\Flahsy`
Repo: `https://github.com/jmccormick14/flashy.git`

## Current State

`Flashy` is now a general-purpose offline-first flashcard PWA built with `Vite + React + TypeScript`.

The app currently supports:
- manual deck creation
- manual card creation
- import from `CSV`, `TSV`, `JSON`, and pasted text blocks
- editable cards
- local IndexedDB storage
- JSON backup/restore
- CSV export
- Browse mode with live narrowing search
- Study mode with:
  - `Flash`
  - `Write`
  - `Quiz`
- spaced-review style confidence buttons:
  - `Again`
  - `Hard`
  - `Good`
  - `Easy`
- GitHub Pages friendly PWA deployment

## Recent Fixes

- Rebuilt the old drug-specific app into a generic `deck -> cards -> review progress` model.
- Removed legacy work-mode / drug-reference architecture.
- Added `Write` and `Quiz` study modes.
- Fixed quiz distractor generation so choices come from the full active deck instead of only the current review slice.
- Added a fallback message when a deck does not have enough distinct answers for quiz mode.

## Deployment

GitHub Pages is configured through `GitHub Actions`.

Expected live URL:
- `https://jmccormick14.github.io/flashy/`

If resuming deployment/debugging:
1. Check the Actions tab in the GitHub repo.
2. Confirm the latest Pages workflow is green.
3. Hard refresh the live app after deployment because service workers can cache old bundles.

## Important Files

- [src/App.tsx](C:/Users/Owner/Flahsy/src/App.tsx:1)
- [src/lib/importer.ts](C:/Users/Owner/Flahsy/src/lib/importer.ts:1)
- [src/lib/storage.ts](C:/Users/Owner/Flahsy/src/lib/storage.ts:1)
- [src/types.ts](C:/Users/Owner/Flahsy/src/types.ts:1)
- [src/styles.css](C:/Users/Owner/Flahsy/src/styles.css:1)
- [vite.config.ts](C:/Users/Owner/Flahsy/vite.config.ts:1)

## Good Next Steps

- Add a proper `Match` study mode as its own layout instead of squeezing it into the card panel.
- Improve quiz distractors further by preferring same-category cards when available.
- Add deck duplication.
- Add bulk card edit/delete.
- Add import preview examples and better mapping hints for non-technical users.
- Add lightweight tests around importer and review logic.

## Resume Notes

If we pick this up later, start by:
1. opening the live Pages app and checking the three study modes on mobile
2. confirming service-worker updates are not masking the latest deployment
3. deciding whether the next priority is `Match mode`, deck management, or import UX
