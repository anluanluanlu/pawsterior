# Pawsterior

Track meditation and the things that shape your mind, alongside how you're actually doing.

Pawsterior is a website you can also install as an app (a Progressive Web App). It works offline, and all data stays on your device.

- **Meditate.** A timer with an adjustable warm-up (15 s by default, ended by a short wood snap), optional interval bells, and a singing-bowl end bell. Quick durations of 10, 12 or 15 minutes, or type any number. The stats show minutes and days meditated in the last 7 days. Choose an ambient sound: silence, brown noise, rain or ocean. You can pause, resume, finish early or discard. Each finished session is logged automatically, and afterwards you're asked how you feel.
- **Log.** You define every entry type yourself. Each type is one of:
  - an **activity / happening**, such as "Met friends" or "Coffee after 4pm"; or
  - a **mental state**, marked as a sign of *good* mental health ("Felt calm") or *negative* mental health ("Couldn't fall asleep", "Catastrophic thoughts").

  One tap logs a type now. You can then add a time, a duration (activities), an intensity from 1 to 5 (mental states) or a note.
- **History.** Every entry by day, with filtering and editing.
- **Insights.** A three-week grid of everything you logged, plus, for each activity and mental state pair, how often the state shows up on days with the activity compared with days without it. You can count the activity on the same day, or on the same day and the day before (or the two days before). These are associations in your own data, not causes.
- **Setup.** Edit, archive or delete types, and export or import a JSON backup.

## Specification first: Allium

The behaviour is specified in [`spec/pawsterior.allium`](spec/pawsterior.allium), written in [Allium](https://juxt.github.io/allium/), JUXT's behavioural specification language for LLM-driven development. The spec defines the entities (`EntryType`, `Entry`, `MeditationSession`), the rules with their preconditions and outcomes, the invariants, the surfaces and the open questions. It is the source of truth:

- [`src/model.js`](src/model.js) implements the entities and rules as pure functions.
- [`src/insights.js`](src/insights.js) implements the `Insights` surface.
- The tests in [`test/`](test) check the rules and invariants.

When behaviour changes, update the spec first, then the code. With the Allium skill installed in Claude Code (`/plugin marketplace add juxt/claude-plugins`, then `/plugin install allium`), `/allium:weed` finds places where the spec and the code have drifted apart. `/allium:propagate` generates tests from the spec. The `allium` CLI (from [juxt/allium-tools](https://github.com/juxt/allium-tools/releases)) checks the spec. `npm run spec` runs `allium analyse`, which reports structural errors as well as states a session could get stuck in.

## Run it

You need Node 20 or later. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:5173. To install it as an app, use your browser's install button or "Add to Home Screen".

```bash
npm test
```

## Real app and test build

The app is deployed twice, from two branches:

| | URL | Data |
| --- | --- | --- |
| Real app | `https://pawsterior.buecking.me/` | `localStorage` key `pawsterior:v1`, starts empty |
| Test build | `https://pawsterior.buecking.me/test/` | `localStorage` key `pawsterior-test:v1`, starts with about 8 weeks of random sample entries |

The real app comes from `main` and the test build from `staging` (see below). The app knows which one it is from its URL path ([`src/env.js`](src/env.js)), so there are no build flags. The test build has a yellow TEST badge, its own storage key, its own service worker cache and its own installable manifest ([`manifest.test.webmanifest`](manifest.test.webmanifest)), so the two never touch each other's data. Test data persists between visits; Setup has a button to regenerate it ([`src/seed.js`](src/seed.js)).

Locally, `npm start` serves the real app at http://localhost:5173 and the test build at http://localhost:5173/test/.

## Cloud sync (Cloudflare Worker + KV)

You have to sign in to use the app (the sign-in screen replaces the app until you do, and your email shows in the top corner with a sync light). Your data is kept in Cloudflare Workers KV and synced between devices. The device copy stays the source of truth, so once signed in the app works offline and syncs when it can. The first time you sign in on a device that already has data, that data is uploaded to your account. Signing out removes the data from the device (it stays in your account).

```
PWA (GitHub Pages)  ->  Worker in worker/  ->  KV namespace PAWS
```

- **Accounts:** email and password. Passwords are PBKDF2-SHA256 hashed with a per-user salt; sessions are random tokens (90 days) of which only the SHA-256 is stored; 10 wrong passwords lock an email for 15 minutes.
- **Sync:** the whole data document is pushed after a change (2 s debounce) and pulled on start, on focus and when back online. Each push says which cloud revision it is based on. If the cloud moved on while this device also changed, the app asks which copy to keep. A running timer is never synced.
- **Real and test:** the test build signs in with the same account but syncs to its own cloud copy (`profile=test`).

### Set it up

1. Create a free Cloudflare account, then from `worker/`:
   ```bash
   npm i -g wrangler
   wrangler login
   wrangler kv namespace create PAWS
   ```
   Paste the printed `id` into [`worker/wrangler.toml`](worker/wrangler.toml).
2. Check `ALLOWED_ORIGINS` in the same file (your site's origin, no trailing slash), then deploy:
   ```bash
   wrangler deploy
   ```
   Wrangler prints the Worker URL (`https://pawsterior-api.<you>.workers.dev`).
3. Point the app at it: set `API_URL` in [`src/env.js`](src/env.js). If your domain is on Cloudflare you can instead uncomment `routes` in `wrangler.toml` to serve it at `pawsterior-api.buecking.me`, and then set `API_URL` to that address.
4. Open the app and choose "Create account".
5. Registration is limited to the emails in `ALLOWED_EMAILS` in `wrangler.toml`. To invite a friend, add their address to that list and run `wrangler deploy`; they can then create their account in the app. Set `ALLOW_SIGNUP = "false"` to close registration for everyone. Existing accounts are never affected by either setting.

Also worth doing in the Cloudflare dashboard: a rate limiting rule on `/auth/*` (Security, WAF).

### Develop locally

```bash
cd worker
cp .dev.vars.example .dev.vars   # allows requests from http://localhost
wrangler dev                      # API on http://localhost:8787, with local KV
```

Then `npm start` in the repo root; on localhost the app talks to port 8787. `npm test` covers the Worker (against in-memory KV) and the sync logic ([`test/worker.test.js`](test/worker.test.js), [`test/sync.test.js`](test/sync.test.js)).

KV has no atomic compare-and-swap, so two writes landing in the same instant could both pass the revision check. That is fine for one person on a few devices; use a Durable Object if you ever need strict ordering.

## Staging and release

GitHub Pages hosts one site, so [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) rebuilds both halves on every push to `main` or `staging`: the real app from `main`, the test build from `staging` ([`tools/build.mjs`](tools/build.mjs)). It runs `npm test` first and deploys nothing if a test fails.

```
work on staging  ->  push staging  ->  /test/ updates, the real app is untouched
happy?           ->  merge staging into main  ->  the real app updates
```

```bash
git switch staging        # make changes, commit
git push                  # try them at https://pawsterior.buecking.me/test/
git switch main && git merge staging && git push   # release
```

One-time GitHub setup: Settings > Pages > Source: "GitHub Actions"; and Settings > Environments > github-pages > Deployment branches: allow `main` and `staging`.

After changing any app file, bump `CACHE` in [`sw.js`](sw.js) so installed copies pick up the new version.

## Layout

```
spec/pawsterior.allium   behavioural spec (source of truth)
src/model.js             entities and rules (pure, tested)
src/insights.js          activity / mental-state associations (pure, tested)
src/sounds.js            Web Audio bells, wood snap and ambient noise (no audio files)
src/env.js               real app vs test build, picked by URL path
src/seed.js              random sample data for the test build
src/app.js               UI, routing, persistence (localStorage), wake lock
src/sync.js              sign-in and cloud sync engine (no DOM, tested)
worker/                  Cloudflare Worker: auth and sync API on KV
index.html, styles.css   shell and styles (light and dark)
sw.js, manifest.webmanifest, icons/   PWA: offline and installable
tools/serve.mjs          zero-dependency dev server
tools/build.mjs          builds dist/ (real app) and dist/test/ (test build)
icons/logo-source.png      source cat logo the app icons were generated from
```
