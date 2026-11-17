# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kelime is an Anki-style spaced-repetition vocabulary app with IELTS Writing/Reading tools. The user writes in Turkish; all UI text, code comments and commit messages are Turkish.

## Commands

There is no build step, bundler, linter or test suite. `web/` is plain HTML/CSS/ES-module JS served as-is.

- Run locally: `python -m http.server 5173 --directory web` (also defined as `web` in `.claude/launch.json`; use the preview tool, not Bash). Open `http://localhost:5173`.
- Local Supabase (Docker Desktop must be running):
  - `.tools/supabase.exe start -x studio,imgproxy,storage-api,edge-runtime,logflare,vector,supavisor,realtime,postgres-meta,mailpit`
  - `.tools/supabase.exe migration up --local`
  - Point the app at it in the browser: `localStorage['kelime.config'] = JSON.stringify({url:'http://127.0.0.1:54321', key:'<local anon key>'})`.
- Type-check the edge function: in `supabase/functions/kelime-ai/`, run `deno check index.ts` with `DENO_NO_PACKAGE_JSON=1`.
- Verification is manual in the browser. The service worker caches aggressively, so before testing: unregister the SW and `caches.delete(...)` everything, then reload.

## Deployment

- Pushing to `main` deploys `web/` to GitHub Pages (`.github/workflows/pages.yml`) and builds the Android APK with Capacitor (`.github/workflows/android.yml`, release `kelime.apk`). `android-build/patch.py` patches the Gradle version and CSP for the native build.
- **Bump `CACHE` in `web/sw.js` (`'kelime-vNN'`) on every release.** Add any new static file to its `ASSETS` list.
- Supabase migrations and the `kelime-ai` edge function are **not** deployed by CI. The user runs the SQL in the Supabase SQL Editor and deploys the function themselves. Tell them when either changed.

## Architecture

**Local-first client (`web/js/`)**
- `store.js`: IndexedDB store, mirrored in memory (`mem[table]`). Every local write sets `_dirty` and `_rev`. When incoming server rows arrive, local dirty rows are kept and the server rows skipped. Bump the DB version when adding a table.
- `sync.js`: Supabase auth, push of dirty rows, pull, RPC helpers. Tables in `OPTIONAL_TABLES` are wrapped in `optionalTable(...)`, so the app keeps working when a migration hasn't been run yet. New server features should degrade the same way.
- `srs.js`: scheduling. `config.js`: Supabase URL and the public anon key (safe; RLS protects data).
- `app.js`: the entire UI, a single large file.
  - The view is in `state.view` (home, decks, deck, study, essays, essay, phrases, criteria, readings, reading, chat). Each view has a `showX()` that renders into `main.innerHTML` and calls `renderSidebar()`.
  - Clicks go through one delegated `data-act="..."` switch. To add an action, add a `case` there.
  - Esc/keyboard handling and the Android back button each have per-view branches. Update them when adding a view.
  - Remote-change refresh (`onRemoteChange`) re-renders the current view. The home page patches nodes instead of re-rendering, to avoid flicker (`refreshHome`, `patchNode`).
  - Native features (TTS, files, notifications, share) go through Capacitor plugins when `isNative`, and fall back to web APIs otherwise.
- `speaking.js` (+ `speaking.css`): IELTS Speaking mock exam, same `initX(ctx)` pattern as `fsp.js`. Views `speaking`, `speaking-setup`, `speaking-run`, `speaking-result`. Local-only data in its own IndexedDB `kelime-speaking` (tests, attempts, audio blobs; not synced, not in `store.js`). Tests are pasted by the user (`parseTests`). AI report goes through `kelime-ai` `action: 'speaking'`.
- Styling: `app.css` holds the base styles. `ds.css` (loaded after it) is the design system: tokens on `:root` and `:root[data-theme="dark"]`, Inter/Fraunces fonts vendored in `web/vendor/fonts`. Use the tokens; don't hard-code colors.
- CSP in `index.html` is strict (`script-src 'self'`). External libraries must be vendored into `web/vendor/` (e.g. pdf.js), and new network hosts must be added to `connect-src`.
- `web/content/*.json` holds static content (writing criteria summary, sample reading test, Task 1 collocations).

**Backend (`supabase/`)**
- `migrations/`: tables, RLS, RPCs (sharing codes, history triggers, study board, messages, activity feed, user stats, reading tests). New migrations go in date-named files (`YYYYMMDD000000_name.sql`) and must be idempotent enough to run by hand.
- `functions/kelime-ai/index.ts`: the only AI entry point. It calls NVIDIA-hosted models with `NVIDIA_API_KEY` from Supabase secrets and has a per-user daily limit. It switches on an `action` field: card generation by default, plus `essay`, `speaking`, `figure` (vision models raced against a time budget), `ocr` and `reading-part`. The client never calls a model directly.

**Legacy:** `app.py` and `ui/` are the old Windows-only pywebview app (no sync). Don't change them unless asked.

## Rules for this repo

- Never commit: `android-imza/`, `data/`, `kelime_yedek.json`, `ielts-descriptors/`, `reading-tests/`, `speaking-tests/`. Stage files selectively (`git add web/ ...`), never `git add -A`.
- The NVIDIA API key lives only in Supabase secrets, never in client code or the repo.
- Copyright: don't transcribe IELTS/Cambridge books or the official band descriptors into tracked files. The in-app criteria page is an original Turkish summary. Reading tests built from user-provided text stay in the gitignored `reading-tests/`.
- Don't create accounts or enter secrets on the live Supabase project; test against local Supabase.
