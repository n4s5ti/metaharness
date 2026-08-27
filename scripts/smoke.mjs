// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`PASS ${msg}`);
  } else {
    console.log(`FAIL ${msg}`);
    failed++;
  }
}

// OBS-2270: the kernel's compiled-in version comes from the Rust crate, which
// inherits `[workspace.package].version` in the root Cargo.toml — the MONOREPO
// cadence (healthcheck.mjs enforces root package.json === Cargo workspace).
//
// `packages/kernel-js/package.json` is NOT on that cadence: @metaharness/kernel
// is deliberately published on its own semver alongside the native/wasm build
// arc (see the INDEPENDENT set in scripts/healthcheck.mjs), currently 0.1.3 on
// npm while the monorepo sits at 0.1.0.
//
// Asserting equality between those two values asserted that two intentionally
// decoupled cadences are identical, so a correct build failed with exit 1.
// Compare against the root/Cargo cadence the WASM artifact actually carries.
const rootPkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
);

try {
  const { loadKernel } = await import(
    resolve(repoRoot, 'packages/kernel-js/dist/index.js')
  );
  const k = await loadKernel();
  const info = k.kernelInfo();
  assert(typeof info.version === 'string' && info.version.length > 0,
    'kernelInfo.version is a non-empty string');
  assert(info.version === rootPkg.version,
    `kernelInfo.version ${info.version} matches monorepo version ${rootPkg.version}`);

  const bad = k.mcpValidate(JSON.stringify({ name: '', command: ['x'] }));
  assert(typeof bad === 'string' && bad.includes('empty'),
    'mcpValidate rejects empty name');

  const good = k.mcpValidate(JSON.stringify({ name: 'demo', command: ['npx', '-y', 'demo'] }));
  assert(good === null, 'mcpValidate accepts a well-formed stdio spec');

  console.log(`\nbackend: ${k.backend}`);
} catch (err) {
  console.error('smoke failed:', err);
  failed++;
}

process.exit(failed === 0 ? 0 : 1);
