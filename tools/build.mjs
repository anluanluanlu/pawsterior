// Builds the static site into dist/:
//   dist/        the real app,   from <prodDir>  (default: this checkout)
//   dist/test/   the TEST build, from <testDir>  (default: this checkout)
// Usage: node tools/build.mjs [prodDir] [testDir]
// In CI, prodDir is the `main` branch and testDir the `staging` branch, so each
// URL always serves its own branch. Locally both default to the working tree.
// The app tells the two apart by its URL path (src/env.js), so this is just copying files.
import { cp, mkdir, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const prodDir = resolve(process.argv[2] ?? root);
const testDir = resolve(process.argv[3] ?? root);
const dist = join(root, 'dist');
const FILES = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'CNAME', '.nojekyll'];
const DIRS = ['src', 'icons'];

async function copyApp(from, to) {
  await mkdir(to, { recursive: true });
  for (const f of FILES) await copyFile(join(from, f), join(to, f));
  for (const d of DIRS) await cp(join(from, d), join(to, d), { recursive: true });
}

await rm(dist, { recursive: true, force: true });
await copyApp(prodDir, dist);
await copyApp(testDir, join(dist, 'test'));
await copyFile(join(testDir, 'manifest.test.webmanifest'), join(dist, 'test', 'manifest.webmanifest'));
console.log(`Built dist/ from ${prodDir} and dist/test/ from ${testDir}`);
