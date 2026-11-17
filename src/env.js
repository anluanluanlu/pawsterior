// Which build is running. The test build is the same code served under /test/
// (see tools/build.mjs). It uses its own storage key, so it can never touch the
// real data, and it fills itself with sample entries on first run.

export const IS_TEST = /\/test(\/|$)/.test(globalThis.location?.pathname ?? '');
export const STORAGE_KEY = IS_TEST ? 'pawsterior-test:v1' : 'pawsterior:v1';
export const APP_TITLE = IS_TEST ? 'Pawsterior TEST' : 'Pawsterior';

// Cloud sync. The API is the Worker in worker/ (see the README). While developing on
// localhost the app talks to `wrangler dev`; anywhere else it uses the deployed Worker.
const LOCAL = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);
export const API_URL = LOCAL ? 'http://localhost:8787' : 'https://pawsterior-api.pawsterior.workers.dev';
// The test build keeps its own cloud copy, next to the real one, under the same account.
export const SYNC_PROFILE = IS_TEST ? 'test' : 'main';
// Both builds share one origin, so one sign-in covers both.
export const AUTH_KEY = 'pawsterior:auth';
export const SYNC_META_KEY = `${STORAGE_KEY}:sync`;
