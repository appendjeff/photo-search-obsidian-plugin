# Photo Date Search (Obsidian plugin)

Jump from a daily note (or any note that links to daily notes) straight to a Google Photos or Immich search for that date.

### Demo


https://github.com/user-attachments/assets/fab4e2d7-88f5-480f-8692-601013330875



## Dev
```
npm install
npx esbuild main.ts --bundle --external:obsidian --format=cjs --outfile=main.js --target=es2018
```

## Install (manual)
0. Make sure you have the main.js file built (see dev instructions)
1. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/photo-date-search/`
2. Enable "Photo Date Search" in Settings → Community plugins.

## Commands
- **Search photos for this note's date** — parses the active note's filename using your Daily Notes format (or an override in settings).
- **Search photos for a date mentioned in this note** — collects the note's own date, all outgoing links/embeds/frontmatter links whose target names parse as dates, and all backlinks *from* daily notes. One date → opens immediately; multiple → fuzzy picker.

## URL mechanics
- **Google Photos**: `https://photos.google.com/search/<Month D, YYYY>` search endpoint accepts natural-language dates. Being https, it's a universal/app link, so on iOS/Android it opens the Google Photos app when installed.
- **Immich**: `<base>/search?query=<urlencoded JSON>` with `takenAfter`/`takenBefore` set to local-day boundaries (ISO with offset).

## Settings
- Default provider: Google Photos / Immich / Ask each time
- Immich base URL (empty disables Immich)
- Daily note date format override + extra comma-separated formats to try on linked note names (strict Moment parsing, so "Meeting Notes" won't false-positive)


