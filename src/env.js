// Which build is running. The test build is the same code served under /test/
// (see tools/build.mjs). It uses its own storage key, so it can never touch the
// real data, and it fills itself with sample entries on first run.

export const IS_TEST = /\/test(\/|$)/.test(globalThis.location?.pathname ?? '');
export const STORAGE_KEY = IS_TEST ? 'pawsterior-test:v1' : 'pawsterior:v1';
export const APP_TITLE = IS_TEST ? 'Pawsterior TEST' : 'Pawsterior';
