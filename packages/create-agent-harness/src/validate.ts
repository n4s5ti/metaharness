// SPDX-License-Identifier: MIT
//
// `harness validate` — umbrella check that runs every gate a release-ready
// harness should pass, fail-fast with a structured per-check verdict.
//
// Checks (in order):
//   1. doctor          file-shape + manifest hash + at-least-one-host-artifact
//   2. verify          witness manifest signature check
//   3. path-guard      no hardcoded /tmp/, C:\, /Users/, /home/ in production
//   4. mcp-server      every entry in .mcp/servers.json passes kernel schema
//   5. secrets         (optional) gcloud + project + secret exist (--skip-gcp to skip)
//   6. diag            kernel-version skew check (iter 76 — informational,
//                      WARN on skew, never fails the umbrella because kernel
//                      skew is a deploy-side issue, not a release-readiness
//                      block for the harness being validated)
//
// Exits non-zero if any check fails. Structured output suits both human eyes
// and `grep PASS|FAIL` for CI.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { doctor, verify } from './subcommands.js';
import { check as secretsCheck } from './secrets.js';
import { buildDiagReport } from './diag.js';

export type SubcommandResult = { code: number; lines: string[] };

interface CheckResult {
  name: string;
  code: number;
  detail: string;
  // iter 76: optional override for the displayed tag. Lets a check
  // return code 0 (don't fail the umbrella) but surface WARN / SKIP in
  // the output. Used by diag to surface kernel skew informationally.
  tag?: 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
}

async function runDoctor(dir: string): Promise<CheckResult> {
  const r = await doctor([dir]);
  return {
    name: 'doctor',
    code: r.code,
    detail: r.lines.join(' | '),
  };
}

async function runVerify(dir: string): Promise<CheckResult> {
  if (!existsSync(join(dir, '.harness', 'witness.json'))) {
    return { name: 'verify', code: 0, detail: 'no witness — skipped (sign first)' };
  }
  const r = await verify([dir]);
  return { name: 'verify', code: r.code, detail: r.lines.slice(-2).join(' | ') };
}

/** Scan a harness's user-authored files for hardcoded paths. */
async function runPathGuard(dir: string): Promise<CheckResult> {
  const bannedPatterns = [
    /['"`]\/tmp\//,
    /['"`]C:\\\\/,
    /['"`]\/Users\//,
    /['"`]\/home\//,
  ];
  const offenders: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await import('node:fs/promises').then(m => m.readdir(d, { withFileTypes: true }));
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (/\.(ts|tsx|js|mjs|cjs|rs)$/.test(ent.name)) {
        const content = await readFile(p, 'utf-8').catch(() => '');
        for (const line of content.split('\n')) {
          // Skip comment lines
          if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
          for (const pat of bannedPatterns) {
            if (pat.test(line)) {
              offenders.push(`${p}: ${line.trim().slice(0, 80)}`);
              break;
            }
          }
        }
      }
    }
  }
  await walk(dir).catch(() => undefined);
  if (offenders.length === 0) {
    return { name: 'path-guard', code: 0, detail: 'no hardcoded /tmp, C:\\, /Users, /home in TS/JS/Rust' };
  }
  return {
    name: 'path-guard',
    code: 1,
    detail: `${offenders.length} hardcoded path${offenders.length === 1 ? '' : 's'}: ${offenders.slice(0, 3).join('; ')}`,
  };
}

/** Validate `.mcp/servers.json` (if present) against kernel MCP schema. */
async function runMcpCheck(dir: string): Promise<CheckResult> {
  const mcpPath = join(dir, '.mcp', 'servers.json');
  if (!existsSync(mcpPath)) {
    return { name: 'mcp', code: 0, detail: 'no .mcp/servers.json — skipped' };
  }
  try {
    const raw = JSON.parse(await readFile(mcpPath, 'utf-8'));
    const servers = Array.isArray(raw) ? raw : Array.isArray(raw?.mcpServers) ? raw.mcpServers : [];
    if (servers.length === 0) {
      return { name: 'mcp', code: 0, detail: '.mcp/servers.json present but empty — skipped' };
    }
    // Best-effort: each server must have name + command. Real schema check
    // would need the kernel NAPI binding — out of scope for the umbrella.
    const problems: string[] = [];
    for (const [i, s] of servers.entries()) {
      if (typeof s?.name !== 'string') problems.push(`server[${i}] missing name`);
      if (!Array.isArray(s?.command) && typeof s?.command !== 'string') {
        problems.push(`server[${i}] missing command`);
      }
    }
    if (problems.length === 0) {
      return { name: 'mcp', code: 0, detail: `${servers.length} server${servers.length === 1 ? '' : 's'} valid` };
    }
    return { name: 'mcp', code: 1, detail: problems.join('; ') };
  } catch (e) {
    return { name: 'mcp', code: 1, detail: `invalid JSON: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * iter 76: diag check inside the validate umbrella. Returns code 0
 * always so a kernel skew never blocks the umbrella verdict; surfaces
 * the state via the tag override field (PASS / WARN / SKIP).
 */
/**
 * iter 123: check #7 (informational). ADR-034 §134 specifies the OIA
 * manifest should be shape-validated by `harness validate` so a drifted
 * .harness/oia-manifest.json gets surfaced alongside the other gates.
 *
 * Informational on purpose:
 *   - manifest absent  → SKIP (OIA opt-in, not required)
 *   - manifest valid   → PASS
 *   - manifest drifted → WARN (reported but does NOT fail the umbrella;
 *     OIA v0.1 is pre-stable, drift may be a v1.0 migration in progress)
 *   - manifest corrupt → WARN (same reasoning)
 *
 * The user can promote this to FAIL by running `harness oia-manifest
 * <dir> --check` directly in CI.
 */
async function runOiaManifest(dir: string): Promise<CheckResult> {
  const manifestPath = join(dir, '.harness', 'oia-manifest.json');
  if (!existsSync(manifestPath)) {
    return { name: 'oia', code: 0, tag: 'SKIP', detail: 'no .harness/oia-manifest.json (OIA opt-in)' };
  }
  try {
    const { checkOiaManifest } = await import('./oia-manifest.js');
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const r = checkOiaManifest(m);
    if (r.ok) {
      return { name: 'oia', code: 0, tag: 'PASS', detail: `oia-manifest shape ok (oiaVersion=${m.oiaVersion ?? '?'})` };
    }
    return { name: 'oia', code: 0, tag: 'WARN', detail: `oia-manifest drift: ${r.reasons.length} issue(s) — run \`harness oia-manifest ${dir} --check\` for detail` };
  } catch (e) {
    return { name: 'oia', code: 0, tag: 'WARN', detail: `oia-manifest parse error (${String(e).slice(0, 50)})` };
  }
}

async function runDiag(dir: string): Promise<CheckResult> {
  if (!existsSync(join(dir, '.harness', 'manifest.json'))) {
    return { name: 'diag', code: 0, tag: 'SKIP', detail: 'no manifest at path' };
  }
  const r = await buildDiagReport(dir);
  if (!r.manifestKernelVersion) {
    return { name: 'diag', code: 0, tag: 'SKIP', detail: 'manifest pre-iter-58 (no kernel_version)' };
  }
  if (!r.localKernelVersion) {
    return {
      name: 'diag', code: 0, tag: 'SKIP',
      detail: `@metaharness/kernel not installed locally (manifest pins ${r.manifestKernelVersion})`,
    };
  }
  if (r.verdict === 'match' || r.verdict === 'patch-diff') {
    return {
      name: 'diag', code: 0, tag: 'PASS',
      detail: `kernel manifest=${r.manifestKernelVersion} local=${r.localKernelVersion} (${r.verdict})`,
    };
  }
  // minor-diff / major-diff / unparseable → WARN but DON'T fail
  return {
    name: 'diag', code: 0, tag: 'WARN',
    detail: `kernel manifest=${r.manifestKernelVersion} local=${r.localKernelVersion} (${r.verdict})`,
  };
}

/** Top-level dispatcher: `harness validate [path] [--skip-gcp] [--secret=NAME]`. */
export async function validate(args: string[]): Promise<SubcommandResult> {
  const dir = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  const skipGcp = args.includes('--skip-gcp');
  const secret = args.find(a => a.startsWith('--secret='))?.slice('--secret='.length);
  const lines: string[] = [`harness validate — ${dir}`];

  // OBS-2269: the umbrella buffers every check and prints only at the end,
  // so a slow gate renders as a blank terminal with nothing to attribute the
  // stall to. Emit a progress breadcrumb to stderr (stdout stays the clean,
  // parseable report) before each gate runs.
  const progress = (name: string) => {
    // Quiet under test runners and when explicitly silenced — the breadcrumb
    // is a human affordance for a slow interactive run, not test output.
    if (!process.env.HARNESS_VALIDATE_QUIET && !process.env.VITEST) {
      process.stderr.write(`  … ${name}\n`);
    }
  };

  const results: CheckResult[] = [];

  progress('doctor');
  results.push(await runDoctor(dir));
  progress('verify');
  results.push(await runVerify(dir));
  progress('path-guard');
  results.push(await runPathGuard(dir));
  progress('mcp');
  results.push(await runMcpCheck(dir));

  if (!skipGcp) {
    progress('secrets (gcloud — use --skip-gcp to skip)');
    const sc = await secretsCheck(secret ? [`--secret=${secret}`] : []);
    const detail = sc.lines.slice(-2).join(' | ').replace(/\s+/g, ' ');
    // OBS-2269: a gcloud timeout (code 124 from the bounded runner) means the
    // credential provider is unreachable, not that the harness is unfit to
    // release. Degrade to WARN so an offline/ADC-less machine cannot fail the
    // umbrella on an environmental condition.
    if (sc.code === 124 || /timed out after \d+ms/.test(detail)) {
      results.push({
        name: 'secrets',
        code: 0,
        tag: 'WARN',
        detail: `gcloud unreachable or unauthenticated — skipped (re-run with --skip-gcp to silence): ${detail}`,
      });
    } else {
      // OBS-2269: a genuine secrets finding (e.g. NPM_TOKEN absent) is a real
      // publish blocker and must keep failing. Keep the hint attached so the
      // user can tell "publish credentials missing" from "harness is broken".
      results.push({
        name: 'secrets',
        code: sc.code,
        detail: sc.code === 0 ? detail : `${detail} — publish-time GCP check; use --skip-gcp for a local-only run`,
      });
    }
  } else {
    results.push({ name: 'secrets', code: 0, detail: 'skipped (--skip-gcp)' });
  }

  // iter 76: diag (kernel-version skew) as informational signal.
  // Never fails the umbrella — kernel skew is a deploy-side runtime
  // issue, not a release-readiness block for the harness being
  // validated. PASS on match/patch, WARN on minor/major, SKIP when
  // no kernel installed locally.
  results.push(await runDiag(dir));

  // iter 123: OIA manifest shape check (ADR-034 §134) as informational
  // signal. Never fails the umbrella — OIA at v0.1 is pre-stable, and
  // the manifest is opt-in (no manifest = SKIP). PASS on valid shape,
  // WARN on drift or parse error. Users who want CI-blocking validation
  // run `harness oia-manifest <dir> --check` directly.
  results.push(await runOiaManifest(dir));

  let problems = 0;
  for (const r of results) {
    const tag = r.tag ?? (r.code === 0 ? 'PASS' : 'FAIL');
    lines.push(`  ${tag.padEnd(4)} ${r.name.padEnd(10)} — ${r.detail}`);
    if (r.code !== 0) problems++;
  }
  lines.push('');
  if (problems === 0) {
    lines.push('Result: HEALTHY (release-ready)');
    return { code: 0, lines };
  }
  lines.push(`Result: ${problems} check${problems === 1 ? '' : 's'} FAILED — fix before publish`);
  // iter 94: symmetric with iter 93 — when the umbrella FAILs, point
  // the user at the bundle. Doctor already does this for its own
  // failures, but the umbrella aggregates 7 checks (doctor + verify +
  // path-guard + mcp + secrets + diag + oia) — any of them failing
  // should surface the bundle as the next user action. The diag and
  // oia checks are informational — they never fail the umbrella.
  lines.push('');
  lines.push(`Next: capture the full diagnostic state for a support ticket:`);
  lines.push(`  harness diag ${dir} --bundle > bundle.json`);
  lines.push(`(then attach bundle.json to a GitHub issue at`);
  lines.push(` https://github.com/ruvnet/agent-harness-generator/issues — the`);
  lines.push(` bundle is sanitised; secret_/token_/key_/password_ fields are redacted)`);
  return { code: 1, lines };
}
