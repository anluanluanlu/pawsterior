# Pawsterior

Track meditation and the things that shape your mind, alongside how you're actually doing.

Pawsterior is a website you can also install as an app (a Progressive Web App). It works offline, and all data stays on your device.

- **Meditate.** A timer with an adjustable warm-up (15 s by default, ended by a short wood snap), optional interval bells, and a singing-bowl end bell. Quick durations of 10, 12 or 15 minutes, or type any number. The stats show minutes and days meditated in the last 7 days. Choose an ambient sound: silence, brown noise, rain or ocean. You can pause, resume, finish early or discard. Each finished session is logged automatically, and afterwards you're asked how you feel.
- **Log.** You define every entry type yourself. Each type is one of:
  - an **activity / happening**, such as "Met friends" or "Coffee after 4pm"; or
  - a **mental state**, marked as a sign of *good* mental health ("Felt calm") or *bad* mental health ("Couldn't fall asleep", "Catastrophic thoughts").

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
index.html, styles.css   shell and styles (light and dark)
sw.js, manifest.webmanifest, icons/   PWA: offline and installable
tools/serve.mjs          zero-dependency dev server
tools/build.mjs          builds dist/ (real app) and dist/test/ (test build)
tools/make-icons.mjs     regenerates the PNG icons from the paw geometry
```
