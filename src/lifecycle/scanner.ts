/**
 * M5b + M5e — pinta-gemini `TranscriptSource` for BOTH Gemini CLI and
 * Antigravity. Per the project decision, Antigravity gets NO separate adaptor:
 * this one lifecycle owns it, since both tools live under `~/.gemini`.
 *
 * Single root: `$GEMINI_HOME ?? ~/.gemini` (same override the env-file loader
 * honors via @pinta-ai/core's `envFilePath(..., "GEMINI_HOME")`). We do NOT
 * blind-walk the root — only these two subtrees are scanned, everything else
 * (notably `antigravity/bin/` — 12MB binaries — and `knowledge/*.lock`) is
 * excluded. `relPath`s are POSIX and relative to the root, so the `tmp/…` vs
 * `antigravity/…` prefix disambiguates the two products (plan §4.3, M5b/M5e).
 *
 * (1) `tmp/<projectHash>/` — Gemini CLI. Real layout observed on disk:
 *       tmp/<hash>/logs.json           -> meta,        rewritten-doc, no sessionId
 *       tmp/<hash>/chats/<stem>.jsonl  -> session-log, rewritten-doc, sessionId=<stem>
 *       tmp/<hash>/.project_root       -> EXCLUDED
 *     Gemini rewrites whole files on save, so EVERYTHING here is
 *     `rewritten-doc` (never append-log). `projectKey = <hash>`. Anything else
 *     under a project dir (e.g. a `logs/` subdir) is excluded.
 *     NOTE: the plan text says `chats/*.json`; on this machine the chat files
 *     are actually `*.jsonl` (a single whole-file-rewritten JSON doc, not an
 *     append log), so we match both `.json` and `.jsonl` there. Only direct
 *     file children of `chats/` are taken (a stray `chats/<uuid>/` subdir seen
 *     on disk is not recursed into).
 *
 * (2) `antigravity/` — Antigravity. Real layout observed on disk:
 *       conversations/<uuid>.db                                  -> database,      session-log, sessionId=<uuid>
 *       brain/<uuid>/.system_generated/logs/transcript.jsonl     -> append-log,    session-log, sessionId=<uuid>
 *       brain/<uuid>/.system_generated/logs/transcript_full.jsonl-> append-log,    session-log, sessionId=<uuid>
 *       brain/<uuid>/**  (any other file)                        -> rewritten-doc, meta,        sessionId=<uuid>
 *       annotations/<uuid>.pbtxt                                 -> rewritten-doc, meta,        sessionId=<uuid>
 *       <top-level>/*.pb, *.pbtxt, installation_id               -> rewritten-doc, other,       no sessionId
 *       bin/**            -> EXCLUDED (webm_encoder, ~12MB, 92% of the tree)
 *       knowledge/**      -> EXCLUDED (incl. *.lock)
 *     `projectKey = 'antigravity'` for all of these. `wrapper_type` stays
 *     `'pinta-gemini'`; Antigravity files are distinguished only by the
 *     `antigravity/` relPath prefix + `projectKey`.
 *
 * Per plan §4.2 this module sticks to `node:*` APIs only (no Bun globals) so
 * it runs unmodified whether the sidecar host is Node or Bun.
 */
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  TranscriptClass,
  TranscriptFile,
  TranscriptSemantics,
  TranscriptSource,
} from "./types.js";
import { snapshotDb } from "./snapshot.js";

const WRAPPER_ID = "pinta-gemini";

const ANTIGRAVITY_PROJECT_KEY = "antigravity";

/** `$GEMINI_HOME ?? ~/.gemini` — the same base dir the env-file loader resolves. */
function geminiHome(): string {
  const override = process.env.GEMINI_HOME;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(homedir(), ".gemini");
}

/** Relative path from `root` to `absPath`, POSIX-style regardless of platform. */
function toPosixRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

/** True for the two Antigravity brain transcript logs, which alone are append-only. */
function isBrainTranscript(relPath: string): boolean {
  return (
    relPath.endsWith("/.system_generated/logs/transcript.jsonl") ||
    relPath.endsWith("/.system_generated/logs/transcript_full.jsonl")
  );
}

/** Direct chat file under a Gemini CLI project's `chats/` dir. */
function isChatFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".json");
}

/** Strip a single trailing extension to derive a chat sessionId (`x.jsonl` -> `x`). */
function stem(name: string): string {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export async function roots(): Promise<string[]> {
  return [geminiHome()];
}

/** A file we intend to yield, before it is `stat`'d / `since`-filtered. */
interface Candidate {
  absPath: string;
  relPath: string;
  semantics: TranscriptSemantics;
  sessionId?: string;
  projectKey?: string;
}

/** Recursive, streaming walk yielding every *file* under `dir` (never dirs). */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return; // missing / vanished mid-walk — nothing to yield
  }
  try {
    for await (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkFiles(abs);
      } else if (entry.isFile()) {
        yield abs;
      }
      // symlinks / special entries skipped (avoid escaping the root / cycles)
    }
  } catch {
    return; // dir removed while iterating — end this subtree
  }
}

/** List direct children of `dir` (name + kind); empty if `dir` is absent. */
async function* readEntries(dir: string): AsyncGenerator<{ name: string; isDir: boolean; isFile: boolean }> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return;
  }
  try {
    for await (const entry of entries) {
      yield { name: entry.name, isDir: entry.isDirectory(), isFile: entry.isFile() };
    }
  } catch {
    return;
  }
}

/** (1) Gemini CLI — `tmp/<projectHash>/{logs.json, chats/*.{json,jsonl}}`. */
async function* tmpCandidates(root: string): AsyncGenerator<Candidate> {
  const tmpRoot = path.join(root, "tmp");
  for await (const project of readEntries(tmpRoot)) {
    if (!project.isDir) {
      continue; // only per-project dirs live at tmp/ top level
    }
    const projectKey = project.name;
    const projectDir = path.join(tmpRoot, projectKey);

    // logs.json (meta) — only this exact file, not a `logs/` subdir.
    const logsJson = path.join(projectDir, "logs.json");
    yield {
      absPath: logsJson,
      relPath: toPosixRelPath(root, logsJson),
      semantics: "rewritten-doc",
      projectKey,
    };

    // chats/*.{json,jsonl} (session-log) — direct file children only.
    const chatsDir = path.join(projectDir, "chats");
    for await (const chat of readEntries(chatsDir)) {
      if (!chat.isFile || !isChatFile(chat.name)) {
        continue; // skip a stray chats/<uuid>/ subdir and non-chat files
      }
      const abs = path.join(chatsDir, chat.name);
      yield {
        absPath: abs,
        relPath: toPosixRelPath(root, abs),
        semantics: "rewritten-doc",
        sessionId: stem(chat.name),
        projectKey,
      };
    }
    // .project_root and everything else under the project dir: excluded.
  }
}

/** (2) Antigravity — conversations / brain / annotations / top-level protos. */
async function* antigravityCandidates(root: string): AsyncGenerator<Candidate> {
  const agRoot = path.join(root, "antigravity");

  // conversations/<uuid>.db (SQLite → database, session-log)
  const convDir = path.join(agRoot, "conversations");
  for await (const conv of readEntries(convDir)) {
    if (!conv.isFile || !conv.name.endsWith(".db")) {
      continue;
    }
    const abs = path.join(convDir, conv.name);
    yield {
      absPath: abs,
      relPath: toPosixRelPath(root, abs),
      semantics: "database",
      sessionId: stem(conv.name),
      projectKey: ANTIGRAVITY_PROJECT_KEY,
    };
  }

  // brain/<uuid>/** — transcript logs are append-log/session-log, rest meta.
  const brainDir = path.join(agRoot, "brain");
  for await (const session of readEntries(brainDir)) {
    if (!session.isDir) {
      continue;
    }
    const sessionId = session.name;
    const sessionDir = path.join(brainDir, sessionId);
    for await (const abs of walkFiles(sessionDir)) {
      const relPath = toPosixRelPath(root, abs);
      yield {
        absPath: abs,
        relPath,
        semantics: isBrainTranscript(relPath) ? "append-log" : "rewritten-doc",
        sessionId,
        projectKey: ANTIGRAVITY_PROJECT_KEY,
      };
    }
  }

  // annotations/<uuid>.pbtxt (rewritten-doc, meta)
  const annDir = path.join(agRoot, "annotations");
  for await (const ann of readEntries(annDir)) {
    if (!ann.isFile || !ann.name.endsWith(".pbtxt")) {
      continue;
    }
    const abs = path.join(annDir, ann.name);
    yield {
      absPath: abs,
      relPath: toPosixRelPath(root, abs),
      semantics: "rewritten-doc",
      sessionId: stem(ann.name),
      projectKey: ANTIGRAVITY_PROJECT_KEY,
    };
  }

  // top-level *.pb / *.pbtxt / installation_id (rewritten-doc, other).
  // bin/ and knowledge/ subdirs are simply never descended into.
  for await (const top of readEntries(agRoot)) {
    if (!top.isFile) {
      continue;
    }
    if (top.name.endsWith(".pb") || top.name.endsWith(".pbtxt") || top.name === "installation_id") {
      const abs = path.join(agRoot, top.name);
      yield {
        absPath: abs,
        relPath: toPosixRelPath(root, abs),
        semantics: "rewritten-doc",
        projectKey: ANTIGRAVITY_PROJECT_KEY,
      };
    }
  }
}

async function* candidates(root: string): AsyncGenerator<Candidate> {
  yield* tmpCandidates(root);
  yield* antigravityCandidates(root);
}

async function* scan(opts: { since?: Date }): AsyncIterable<TranscriptFile> {
  const [root] = await roots();
  const sinceMs = opts.since?.getTime();

  for await (const cand of candidates(root)) {
    let st;
    try {
      st = await stat(cand.absPath);
    } catch {
      continue; // absent / removed between listing and stat (plan §4.1 "삭제됨: 스킵")
    }
    if (!st.isFile()) {
      continue;
    }
    if (sinceMs !== undefined && st.mtime.getTime() <= sinceMs) {
      continue;
    }
    yield {
      relPath: cand.relPath,
      absPath: cand.absPath,
      size: st.size,
      mtime: st.mtime,
      sessionId: cand.sessionId,
      projectKey: cand.projectKey,
      semantics: cand.semantics,
    };
  }
}

/** `classify()` — coarse content type from `relPath` alone (plan §4.2). */
export function classify(relPath: string): TranscriptClass {
  const seg = relPath.split("/");

  if (seg[0] === "tmp") {
    // tmp/<hash>/...
    if (seg[2] === "chats") {
      return "session-log";
    }
    if (seg[2] === "logs.json" && seg.length === 3) {
      return "meta";
    }
    return "other";
  }

  if (seg[0] === "antigravity") {
    switch (seg[1]) {
      case "conversations":
        return "session-log";
      case "brain":
        return isBrainTranscript(relPath) ? "session-log" : "meta";
      case "annotations":
        return "meta";
      default:
        // top-level *.pb / *.pbtxt / installation_id
        return "other";
    }
  }

  return "other";
}

export const lifecycle: TranscriptSource = {
  id: WRAPPER_ID,
  roots,
  scan,
  classify,
  // First `database`-semantics implementation in the fleet: Antigravity's
  // conversations/<uuid>.db files go through a consistent snapshot before the
  // sidecar reads them (torn-read / -wal / -shm safety). See snapshot.ts.
  snapshot: (file) => snapshotDb(file),
};
