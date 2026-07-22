/**
 * `snapshot()` for Antigravity's `conversations/<uuid>.db` SQLite files — the
 * fleet's FIRST `database`-semantics implementation (plan §4.2/§4.3, §7).
 *
 * A live SQLite db must never be read directly: a concurrent writer produces a
 * torn read, and the real page state may live in a sibling `-wal`/`-shm`. We
 * produce a consistent copy first, then hand its path to the caller (which
 * uploads it and deletes it afterward).
 *
 * Hard constraint: the adaptor bundle must stay pure JS (`bun build`/esbuild,
 * no native npm deps), so we cannot link `better-sqlite3`. Two strategies,
 * tried in order:
 *
 *   1. **system `sqlite3` CLI** (preferred). `sqlite3 <db> ".backup '<dst>'"`
 *      performs an online backup that is transactionally consistent even while
 *      a writer holds the db, and folds any `-wal` back into a single file.
 *      macOS ships `/usr/bin/sqlite3`; availability is probed ONCE and cached.
 *
 *   2. **quiesce-copy fallback** (no CLI present). `stat` the db plus its
 *      `-wal`/`-shm` siblings, require their mtimes to have been stable for
 *      ≥ `minStableMs` (default 2s = no writer active), copy all present files
 *      into a temp dir, then re-`stat` the originals; if anything changed
 *      during the copy the copy may be torn, so retry (up to `maxRetries`,
 *      default 3). The `-wal`/`-shm` copies keep the db self-consistent for a
 *      later reader. If it never quiesces, we throw and the caller skips the
 *      file + emits an audit event (per the interface contract).
 *
 * The temp dir base, the CLI path, the stability window, the clock and the
 * sleep are all injectable so tests can drive both paths deterministically.
 */
import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { constants as FS_CONSTANTS } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TranscriptFile } from "./types.js";

export interface SnapshotOpts {
  /** Base dir under which a unique snapshot dir is created (default `os.tmpdir()`). */
  tmpDirBase?: string;
  /**
   * `undefined` → auto-detect + cache the system `sqlite3` CLI.
   * A string → use that binary (skip detection).
   * `null` → force the quiesce-copy fallback (skip the CLI entirely).
   */
  sqlite3Path?: string | null;
  /** Min ms the source must be un-modified before a fallback copy (default 2000). */
  minStableMs?: number;
  /** Max fallback attempts before giving up (default 3). */
  maxRetries?: number;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** Delay used between fallback attempts (default real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: fires after each fallback copy, before the originals are re-`stat`'d. */
  onCopied?: (attempt: number) => void | Promise<void>;
  /**
   * Overall wall-clock budget for one snapshot attempt (default 60000). Bounds
   * the CLI `.backup` (killed if it hangs on a locked db) and the quiesce-copy
   * stability wait. Set `0` to disable.
   */
  overallTimeoutMs?: number;
}

/** Cached CLI probe result: `undefined` = not yet probed, `null` = unavailable. */
let cachedSqlite3: string | null | undefined;

/** Candidate absolute paths tried before falling back to a bare `sqlite3` on PATH. */
const SQLITE3_CANDIDATES = ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"];

async function probeSqlite3(): Promise<string | null> {
  for (const candidate of SQLITE3_CANDIDATES) {
    try {
      await access(candidate, FS_CONSTANTS.X_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  // Not at a well-known path — is a bare `sqlite3` on PATH runnable?
  const onPath = await new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn("sqlite3", ["--version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return onPath ? "sqlite3" : null;
}

async function detectSqlite3(): Promise<string | null> {
  if (cachedSqlite3 === undefined) {
    cachedSqlite3 = await probeSqlite3();
  }
  return cachedSqlite3;
}

/** Test-only: reset the cached CLI probe so detection re-runs. */
export function resetSqlite3Cache(): void {
  cachedSqlite3 = undefined;
}

async function backupViaCli(bin: string, src: string, dest: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [src, `.backup '${dest}'`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    // Overall deadline: a `.backup` against a wedged/locked db can block forever.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`sqlite3 .backup timed out after ${timeoutMs}ms: ${src}`)));
      }, timeoutMs);
      timer.unref?.();
    }
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`sqlite3 .backup exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        }
      });
    });
  });
}

/** stat one path → `${mtimeMs}:${size}`, or `"absent"` if it doesn't exist. */
async function signatureOf(p: string): Promise<string> {
  try {
    const st = await stat(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

async function signatures(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of paths) {
    out.set(p, await signatureOf(p));
  }
  return out;
}

function sameSignatures(a: Map<string, string>, b: Map<string, string>): boolean {
  for (const [p, sig] of a) {
    if (b.get(p) !== sig) {
      return false;
    }
  }
  return true;
}

async function quiesceCopy(src: string, dir: string, dest: string, opts: SnapshotOpts): Promise<string> {
  const minStableMs = opts.minStableMs ?? 2000;
  const maxRetries = opts.maxRetries ?? 3;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const overallTimeoutMs = opts.overallTimeoutMs ?? 60000;
  const start = now();

  // The db and its (optional) live WAL/SHM siblings.
  const members = [src, `${src}-wal`, `${src}-shm`];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Bounded wall-clock deadline, independent of the retry count.
    if (overallTimeoutMs > 0 && now() - start > overallTimeoutMs) {
      throw new Error(`snapshot quiesce-copy exceeded overall deadline of ${overallTimeoutMs}ms: ${src}`);
    }
    const before = await signatures(members);
    if (before.get(src) === "absent") {
      throw new Error(`snapshot source vanished: ${src}`);
    }

    // Require the source (and siblings) to have been stable for ≥ minStableMs.
    let youngest = 0;
    for (const p of members) {
      try {
        const st = await stat(p);
        youngest = Math.max(youngest, st.mtimeMs);
      } catch {
        // absent sibling — ignore
      }
    }
    if (now() - youngest < minStableMs) {
      await sleep(minStableMs);
      continue; // still hot — wait and re-check
    }

    // Copy every present member into the temp dir (same basenames, so the db
    // copy finds its -wal/-shm next to it).
    for (const p of members) {
      if (before.get(p) === "absent") {
        continue;
      }
      await copyFile(p, path.join(dir, path.basename(p)));
    }

    if (opts.onCopied) {
      await opts.onCopied(attempt);
    }

    // Did anything change while we copied? If so the copy may be torn — retry.
    const after = await signatures(members);
    if (sameSignatures(before, after)) {
      return dest;
    }
  }

  throw new Error(`snapshot quiesce-copy did not stabilize after ${maxRetries} attempts: ${src}`);
}

/**
 * Produce a consistent, standalone copy of `file.absPath` (a SQLite db) and
 * return its absolute path. The caller owns cleanup (delete after upload).
 */
export async function snapshotDb(file: TranscriptFile, opts: SnapshotOpts = {}): Promise<string> {
  const base = opts.tmpDirBase ?? os.tmpdir();
  const dir = await mkdtemp(path.join(base, "pinta-gemini-snap-"));
  try {
    const dest = path.join(dir, path.basename(file.absPath));
    const bin = opts.sqlite3Path !== undefined ? opts.sqlite3Path : await detectSqlite3();
    if (bin) {
      await backupViaCli(bin, file.absPath, dest, opts.overallTimeoutMs ?? 60000);
      return dest;
    }
    return await quiesceCopy(file.absPath, dir, dest, opts);
  } catch (err) {
    // The caller only deletes the snapshot dir on success, so a throw from
    // either strategy would leak the mkdtemp dir (these accumulate under a
    // periodic tmp scan). Clean it up before re-throwing.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
