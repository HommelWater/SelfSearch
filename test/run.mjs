// Run the whole test suite without npm:  node test/run.mjs
// Runs every test/*.test.mjs with Node's built-in runner (the extension has
// no runtime dependencies; only the tests need a fake IndexedDB, which is
// vendored under test/vendor/).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .map(f => join(testDir, f));

const { status } = spawnSync(
  process.execPath,
  ['--test', '--test-force-exit', ...files],
  { stdio: 'inherit' }
);
process.exit(status ?? 1);
