/**
 * Host agent version — the CLI that fired the hook, not this adapter.
 *
 * `telemetry.sdk.version` already reports *our* version. `service.version` has
 * to report the thing a human would name when asked "which agent are you on".
 *
 * MEASURED 2026-09-15 inside a live Gemini CLI 0.59.0 hook process. Every claim
 * below came out of a probe hook, not out of the docs:
 *
 *   hook payload   session_id · transcript_path · cwd · hook_event_name ·
 *                  timestamp · source        → no version field
 *   hook env       GEMINI_PROJECT_DIR · GEMINI_PLANS_DIR · GEMINI_CWD ·
 *                  GEMINI_SESSION_ID · CLAUDE_PROJECT_DIR   → no version
 *   process.ppid   node … /opt/homebrew/bin/gemini          → the live process
 *   PATH           /opt/homebrew/bin/gemini → …/gemini-cli  → 0.59.0
 *
 * The host volunteers nothing, so both working sources DERIVE the version from
 * the executable that is actually running.
 *
 * ── Why a manifest is not enough: the other half of this bundle ─────────────
 *
 * This adapter serves Gemini CLI *and* Antigravity (no separate adaptor — see
 * lifecycle/scanner.ts). Only gemini ships as npm. MEASURED 2026-09-15 against
 * Antigravity CLI 1.2.3:
 *
 *   PATH name      `agy` — and ONLY `agy`. Neither "antigravity" nor
 *                  "antigravity-cli" exists on PATH, so the names this file
 *                  originally guessed matched nothing.
 *   realpath       …/Caskroom/antigravity-cli/1.2.3,<build>/antigravity
 *   file type      Mach-O 64-bit arm64, 181MB — a native binary
 *   package.json   ABSENT at all five levels the manifest walk climbs
 *
 * So for half of this bundle's installs the manifest route cannot succeed, no
 * matter which name is matched. The binary has to be asked directly.
 *
 * ── Why asking the binary is safe here ─────────────────────────────────────
 *
 * `--version` spawns a process, which is a thing to be careful about inside a
 * hook. Measured before adopting it:
 *
 *   cost        62–65ms, and cached for the life of the hook process
 *   recursion   `agy --version` spawns NO children and produces NO hook
 *               traffic (watched for child pids; sidecar.log unchanged)
 *
 * Recursion is nevertheless guarded, because the failure mode is unbounded
 * process spawn rather than a wrong answer — see PROBE_ENV.
 *
 * ── Why host env is never searched ──────────────────────────────────────────
 *
 * Gemini's `sanitizeEnvironment()` hands the hook the parent's whole
 * environment. That environment was observed carrying:
 *
 *   COPILOT_CLI_BINARY_VERSION = 1.0.83
 *
 * A different agent's version, sitting in gemini's hook env. Any generic
 * `*VERSION` sweep would report Copilot's version as Gemini's. A wrong version
 * is worse than an absent one — it reports confidently and it is wrong. So the
 * only env consulted is our own namespaced override.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isGemini, type Agent, type RawEvent } from "./types.js";

/** Values that claim to be a version while carrying no information. */
const PLACEHOLDERS = new Set(["", "unknown", "undefined", "null", "n/a", "none", "-"]);

function real(v: unknown): string | undefined {
  const t = typeof v === "string" ? v.trim() : undefined;
  return t && !PLACEHOLDERS.has(t.toLowerCase()) ? t : undefined;
}

/**
 * `0.59.0`, `1.2.3-rc.1`. Applied to values we DERIVE (a manifest field, a path
 * segment) rather than ones the host hands us: a directory can be keyed by a
 * channel (`latest`, `nightly`) and a channel is not a version.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function versionLike(v: unknown): string | undefined {
  const t = real(v);
  return t && VERSION_RE.test(t) ? t : undefined;
}

/**
 * Payload keys, snake (gemini) and camel (antigravity). None of these exist
 * today — they are here so that the day a host starts volunteering its version
 * we read it for free, and prefer it, because it describes the process that
 * actually fired rather than whatever else is installed.
 */
const PAYLOAD_VERSION_KEYS = [
  "cli_version",
  "cliVersion",
  "gemini_version",
  "geminiVersion",
  "agent_version",
  "agentVersion",
  "app_version",
  "appVersion",
  "version",
] as const;

/** Our own namespace. Never a host-supplied name — see the header. */
const OVERRIDE_ENV = "PINTA_GEMINI_HOST_VERSION";

/**
 * Set on the `--version` child so that a host which DOES fire hooks on
 * `--version` cannot make them probe again. Gemini passes the parent
 * environment through to hooks, so the marker reaches a nested hook and stops
 * the walk at depth one. Antigravity 1.2.3 was measured not to fire at all;
 * this exists so a future release that does cannot melt the machine.
 */
const PROBE_ENV = "PINTA_GEMINI_VERSION_PROBE";

/** Long enough for a 181MB binary to start, short enough not to stall a hook. */
const PROBE_TIMEOUT_MS = 2000;

/** `agy version 1.2.3`, `v0.59.0` — a version sitting inside other words. */
const VERSION_TOKEN_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/**
 * Executable basenames per host family, most specific first.
 *
 * `agy` leads the antigravity list because it is the only name measured on
 * PATH; the other two are kept for the installers that may use the product
 * name, and cost nothing when absent.
 */
function binaryNames(agent: Agent): string[] {
  return isGemini(agent) ? ["gemini"] : ["agy", "antigravity", "antigravity-cli"];
}

/**
 * Walk up from a file's directory to the manifest that names its package.
 * npm layouts put the executable a level or two below `package.json`
 * (`…/@google/gemini-cli/bundle/gemini.js`), so a couple of steps are needed —
 * but the walk is bounded so a stray parent manifest can't be mistaken for it.
 */
function manifestVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 5; depth++) {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      const v = versionLike((JSON.parse(raw) as { version?: unknown }).version);
      if (v) return v;
    } catch {
      /* no manifest here, or unreadable — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Read the version off `<binary> --version`.
 *
 * Only reached when the manifest walk found nothing, so gemini — which always
 * has a manifest — never pays for it. The file handed here has already matched
 * `binaryNames()`, so this is not an arbitrary exec.
 */
function versionFromCommand(file: string): string | undefined {
  if (process.env[PROBE_ENV] === "1") return undefined; // we are already a probe

  let out: string;
  try {
    out = execFileSync(file, ["--version"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, [PROBE_ENV]: "1" },
    });
  } catch {
    return undefined; // not executable, wrong flag, timed out, non-zero exit
  }

  const lines = out.split(/\r?\n/, 5).map((l) => l.trim()).filter(Boolean);
  // A line that is *only* a version is unambiguous. Both hosts answer this way:
  // `agy --version` → "1.2.3", `gemini --version` → "0.59.0".
  for (const line of lines) {
    const exact = versionLike(line);
    if (exact) return exact;
  }
  // Otherwise take the first version-shaped token, for hosts that pad the line.
  for (const line of lines) {
    const m = VERSION_TOKEN_RE.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Manifest first — it is a file read, and it describes the package rather than
 * whatever the binary chooses to print. `--version` is the fallback for hosts
 * that ship no manifest at all (Antigravity; see the header).
 */
function versionFromExecutable(file: string): string | undefined {
  let resolved = file;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    /* keep the original path — it may still sit next to a manifest */
  }
  // The probe runs the path we were given, not the realpath: some CLIs branch
  // on argv[0], and the given path is the one the host itself invokes.
  return manifestVersion(path.dirname(resolved)) ?? versionFromCommand(file);
}

/**
 * The parent process IS the host. Measured: the hook's direct parent was
 * `node … /opt/homebrew/bin/gemini -p …`, so no chain walk is needed — gemini
 * spawns through a shell that execs itself away.
 *
 * This is the most authoritative source available: it names the binary that
 * fired this hook, not whichever copy happens to be first on PATH.
 */
function fromParentProcess(agent: Agent): string | undefined {
  if (process.platform === "win32") return undefined; // no ps(1)
  const ppid = process.ppid;
  if (!ppid || ppid <= 1) return undefined;

  let command: string;
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", String(ppid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  if (!command) return undefined;

  const names = binaryNames(agent);
  for (const token of command.split(/\s+/)) {
    if (!token.startsWith("/")) continue;
    const base = path.basename(token).replace(/\.(js|mjs|cjs)$/, "");
    if (!names.includes(base)) continue;
    const v = versionFromExecutable(token);
    if (v) return v;
  }
  return undefined;
}

/**
 * PATH survives into the hook — it is in gemini's
 * `ALWAYS_ALLOWED_ENVIRONMENT_VARIABLES`. Walked directly rather than shelling
 * out to `command -v`: one less subprocess, and no shell to disagree with.
 */
function fromPath(agent: Agent): string | undefined {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (entries.length === 0) return undefined;
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];

  for (const name of binaryNames(agent)) {
    for (const dir of entries) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, name + suffix);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
        const v = versionFromExecutable(candidate);
        if (v) return v;
      }
    }
  }
  return undefined;
}

/** `null` = resolved and nothing answered; `undefined` = not resolved yet. */
let cachedHostVersion: string | null | undefined;

function resolveHostVersion(agent: Agent): string | null {
  return real(process.env[OVERRIDE_ENV]) ?? fromParentProcess(agent) ?? fromPath(agent) ?? null;
}

/**
 * Host CLI version, or `undefined` when nothing could answer.
 *
 * `undefined` is a real answer here: the caller omits the attribute rather than
 * writing a placeholder. See `resourceAttrs` in otlp.ts.
 */
export function hostVersion(agent: Agent, event?: RawEvent): string | undefined {
  if (event) {
    for (const key of PAYLOAD_VERSION_KEYS) {
      const v = real(event[key]);
      if (v) return v;
    }
  }
  if (cachedHostVersion === undefined) cachedHostVersion = resolveHostVersion(agent);
  return cachedHostVersion ?? undefined;
}
