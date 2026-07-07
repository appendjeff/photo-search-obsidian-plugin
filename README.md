# Photo Date Search (Obsidian plugin)

Jump from a daily note (or any note that links to daily notes) straight to a
Google Photos or Immich search for that date.

## Install (manual)
1. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/photo-date-search/`
2. Enable "Photo Date Search" in Settings → Community plugins.

## Commands
- **Search photos for this note's date** — parses the active note's filename
  using your Daily Notes format (or an override in settings).
- **Search photos for a date mentioned in this note** — collects the note's own
  date, all outgoing links/embeds/frontmatter links whose target names parse as
  dates, and all backlinks *from* daily notes. One date → opens immediately;
  multiple → fuzzy picker.

## URL mechanics
- **Google Photos**: `https://photos.google.com/search/<Month D, YYYY>` — the
  search endpoint accepts natural-language dates. Being https, it's a
  universal/app link, so on iOS/Android it opens the Google Photos app when
  installed. No official API for tighter deep links exists.
- **Immich**: `<base>/search?query=<urlencoded JSON>` with
  `takenAfter`/`takenBefore` set to local-day boundaries (ISO with offset).

## Settings
- Default provider: Google Photos / Immich / Ask each time
- Immich base URL (empty disables Immich)
- Daily note date format override + extra comma-separated formats to try on
  linked note names (strict Moment parsing, so "Meeting Notes" won't false-positive)

## Dev
```
npm install
npx esbuild main.ts --bundle --external:obsidian --format=cjs --outfile=main.js --target=es2018
```
