#!/usr/bin/env node
// Removes orphaned folders under ~/.claude/worktrees and merged worktree-agent-* branches.
//
// A folder is deleted only when ALL of these hold:
//   - it is not a live git worktree (no .git link, or the link points to a gitdir that no longer exists)
//   - nothing in it, or the folder itself, was modified within the grace period
//   - no running process mentions its path in its command line or executable path
// Registered worktrees are never touched, whatever their state.
//
// Branch cleanup runs in the current repo (if cwd is in one): `git worktree prune`, then every
// `worktree-agent-*` branch that is not checked out and is an ancestor of the default branch is
// deleted with `git branch -d` (which itself refuses unmerged branches).
//
// Usage: node clean-worktrees.mjs [--dry-run] [--grace-minutes N] [--root DIR] [--no-branches]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const dryRun = flag('--dry-run');
const graceMinutes = Number(opt('--grace-minutes', '15'));
const root = path.resolve(opt('--root', path.join(os.homedir(), '.claude', 'worktrees')));
const doBranches = !flag('--no-branches');

if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
  console.error('--grace-minutes must be a non-negative number');
  process.exit(2);
}

const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function run(cmd, cmdArgs, cwd) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function processText() {
  const out =
    process.platform === 'win32'
      ? run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }',
        ])
      : run('ps', ['-eo', 'pid=,args=']);
  if (out === null) {
    console.error('Could not list processes; refusing to delete anything.');
    process.exit(1);
  }
  return out
    .split(/\r?\n/)
    .filter((l) => l && !l.includes('clean-worktrees.mjs'))
    .map((l) => l.replace(/\\/g, '/').toLowerCase());
}

function newestMtime(dir) {
  // The folder and its top-level entries. Deep scans of node_modules are too slow and add nothing:
  // an active session touches top-level files or the folder itself.
  let newest = fs.statSync(dir).mtimeMs;
  for (const name of fs.readdirSync(dir)) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
    } catch {
      /* vanished mid-scan */
    }
  }
  return newest;
}

function classify(dir) {
  const dotGit = path.join(dir, '.git');
  if (!fs.existsSync(dotGit)) return { orphan: true, why: 'no .git link' };
  if (fs.statSync(dotGit).isDirectory()) return { orphan: false, why: 'standalone repository' };
  const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!m) return { orphan: false, why: 'unreadable .git file' };
  const gitdir = path.resolve(dir, m[1].trim());
  if (!fs.existsSync(gitdir)) return { orphan: true, why: 'gitdir missing (repo pruned it)' };
  return { orphan: false, why: 'registered worktree' };
}

// ---- folders ----
const results = { removed: [], kept: [], failed: [] };

if (fs.existsSync(root)) {
  const procs = processText();
  const cutoff = Date.now() - graceMinutes * 60_000;

  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const { orphan, why } = classify(dir);
    if (!orphan) {
      results.kept.push(`${name}  (${why})`);
      continue;
    }
    if (newestMtime(dir) > cutoff) {
      results.kept.push(`${name}  (modified within ${graceMinutes} min)`);
      continue;
    }
    const needle = norm(dir);
    const user = procs.find((p) => p.includes(needle));
    if (user) {
      results.kept.push(`${name}  (in use by process ${user.split('\t')[0]})`);
      continue;
    }
    if (dryRun) {
      results.removed.push(`${name}  (${why}) [dry run]`);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      results.removed.push(`${name}  (${why})`);
    } catch (err) {
      results.failed.push(`${name}  (${err.code ?? err.message}; partially removed, retry later)`);
    }
  }
}

// ---- branches ----
const branches = { deleted: [], kept: [] };
const repoTop = doBranches ? run('git', ['rev-parse', '--show-toplevel'])?.trim() : null;

if (repoTop) {
  if (!dryRun) run('git', ['worktree', 'prune'], repoTop);

  const headRef = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoTop)?.trim();
  const base = headRef || (run('git', ['rev-parse', '--verify', 'main'], repoTop) ? 'main' : null);

  const checkedOut = new Set(
    (run('git', ['worktree', 'list', '--porcelain'], repoTop) ?? '')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
  const agentBranches = (
    run('git', ['branch', '--list', 'worktree-agent-*', '--format=%(refname:short)'], repoTop) ?? ''
  )
    .split(/\r?\n/)
    .filter(Boolean);

  for (const b of agentBranches) {
    if (checkedOut.has(b)) {
      branches.kept.push(`${b}  (checked out in a worktree)`);
    } else if (!base || run('git', ['merge-base', '--is-ancestor', b, base], repoTop) === null) {
      branches.kept.push(`${b}  (not merged into ${base ?? 'default branch'})`);
    } else if (dryRun) {
      branches.deleted.push(`${b}  [dry run]`);
    } else if (run('git', ['branch', '-d', b], repoTop) !== null) {
      branches.deleted.push(b);
    } else {
      branches.kept.push(`${b}  (git branch -d refused)`);
    }
  }
}

// ---- report ----
const section = (title, items) => {
  if (items.length) console.log(`${title}:\n${items.map((i) => `  - ${i}`).join('\n')}`);
};
console.log(`Worktree cleanup${dryRun ? ' (dry run)' : ''} — ${root}`);
section('Removed folders', results.removed);
section('Kept folders', results.kept);
section('Failed folders', results.failed);
if (repoTop) {
  section('Deleted branches', branches.deleted);
  section('Kept branches', branches.kept);
}
const nothing =
  !results.removed.length &&
  !results.kept.length &&
  !results.failed.length &&
  !branches.deleted.length &&
  !branches.kept.length;
if (nothing) console.log('Nothing to clean.');
process.exit(results.failed.length ? 1 : 0);
