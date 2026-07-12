import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotDb, resetSqlite3Cache } from "../../src/lifecycle/snapshot";
import type { TranscriptFile } from "../../src/lifecycle/types";

/** Locate a usable system sqlite3 CLI, mirroring snapshot.ts's own probe. */
function findSqlite3(): string | null {
  for (const c of ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]) {
    if (fs.existsSync(c)) return c;
  }
  const r = spawnSync("sqlite3", ["--version"]);
  return r.status === 0 ? "sqlite3" : null;
}
const SQLITE3 = findSqlite3();

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-snap-test-"));
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Push a file's mtime `ms` into the past (keeps the stability gate satisfied). */
function backdate(absPath: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(absPath, t, t);
}

function fakeDb(name: string, bytes: string): TranscriptFile {
  const abs = path.join(workDir, name);
  fs.writeFileSync(abs, bytes);
  return {
    relPath: `antigravity/conversations/${name}`,
    absPath: abs,
    size: Buffer.byteLength(bytes),
    mtime: new Date(),
    semantics: "database",
  };
}

describe("snapshotDb — quiesce-copy fallback (sqlite3Path: null)", () => {
  it("copies the db plus its -wal/-shm siblings into a temp dir and returns the db copy", async () => {
    const file = fakeDb("c.db", "DBDATA");
    fs.writeFileSync(`${file.absPath}-wal`, "WALBYTES");
    fs.writeFileSync(`${file.absPath}-shm`, "SHMBYTES");
    for (const p of [file.absPath, `${file.absPath}-wal`, `${file.absPath}-shm`]) {
      backdate(p, 10_000);
    }

    const dest = await snapshotDb(file, { sqlite3Path: null, minStableMs: 2000, tmpDirBase: workDir });

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf8")).toBe("DBDATA");
    const dir = path.dirname(dest);
    expect(fs.readFileSync(path.join(dir, "c.db-wal"), "utf8")).toBe("WALBYTES");
    expect(fs.readFileSync(path.join(dir, "c.db-shm"), "utf8")).toBe("SHMBYTES");
  });

  it("retries when the source changes during the copy, then succeeds", async () => {
    const file = fakeDb("c.db", "V1");
    // Backdate well into the past so the stability gate is always satisfied;
    // this test isolates the post-copy change-detection retry, not the gate.
    backdate(file.absPath, 10_000);
    const attempts: number[] = [];

    const dest = await snapshotDb(file, {
      sqlite3Path: null,
      minStableMs: 2000,
      maxRetries: 3,
      tmpDirBase: workDir,
      onCopied: (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          // Simulate a concurrent writer touching the db mid-copy: distinct
          // (but still safely-in-the-past) mtime so the re-stat detects the
          // change and forces a retry without re-tripping the stability gate.
          fs.writeFileSync(file.absPath, "V2");
          backdate(file.absPath, 8_000);
        }
      },
    });

    expect(attempts).toEqual([1, 2]); // attempt 1 saw the change, attempt 2 was stable
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("throws after maxRetries if the source never stabilizes", async () => {
    const file = fakeDb("c.db", "V0");
    backdate(file.absPath, 10_000);
    let n = 0;

    await expect(
      snapshotDb(file, {
        sqlite3Path: null,
        minStableMs: 2000,
        maxRetries: 2,
        tmpDirBase: workDir,
        onCopied: () => {
          n += 1;
          // A distinct (still-in-the-past) mtime each attempt: the change is
          // always detected (never stable), so the copy path runs every retry.
          fs.writeFileSync(file.absPath, `V${n}`);
          backdate(file.absPath, 9_000 - n * 1_000);
        },
      }),
    ).rejects.toThrow(/did not stabilize/);
  });

  it("waits (minStableMs) for a freshly-written db to go quiet before copying", async () => {
    const file = fakeDb("c.db", "DATA");
    const m = fs.statSync(file.absPath).mtimeMs;
    let clock = m + 500; // only 0.5s since the last write — still "hot"
    const sleeps: number[] = [];

    const dest = await snapshotDb(file, {
      sqlite3Path: null,
      minStableMs: 2000,
      maxRetries: 3,
      tmpDirBase: workDir,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms; // advancing past the stability window
      },
    });

    expect(sleeps).toEqual([2000]); // slept exactly once, then copied
    expect(fs.existsSync(dest)).toBe(true);
  });
});

describe("snapshotDb — system sqlite3 CLI path (auto-detected)", () => {
  it.skipIf(!SQLITE3)("produces a valid, queryable backup via `.backup`", async () => {
    resetSqlite3Cache(); // exercise real availability detection + cache
    const dbPath = path.join(workDir, "real.db");
    const create = spawnSync(SQLITE3 as string, [dbPath, "CREATE TABLE t(x); INSERT INTO t VALUES (42);"]);
    expect(create.status).toBe(0);

    const file: TranscriptFile = {
      relPath: "antigravity/conversations/real.db",
      absPath: dbPath,
      size: fs.statSync(dbPath).size,
      mtime: new Date(),
      semantics: "database",
    };

    const dest = await snapshotDb(file, { tmpDirBase: workDir }); // no sqlite3Path → auto-detect
    expect(fs.existsSync(dest)).toBe(true);
    expect(path.dirname(dest)).not.toBe(path.dirname(dbPath)); // a distinct temp copy

    const q = spawnSync(SQLITE3 as string, [dest, "SELECT x FROM t;"]);
    expect(q.status).toBe(0);
    expect(q.stdout.toString().trim()).toBe("42");
  });

  it.runIf(!SQLITE3)("(skipped: no system sqlite3 available on this machine)", () => {
    expect(SQLITE3).toBeNull();
  });
});
