/**
 * service.version — host CLI version resolution (PTA-348, PTA-357).
 *
 * The adapter used to ship no `service.version` at all, so every gemini and
 * antigravity span was unattributable to a CLI release. These cases pin the two
 * things that matter: that a resolved version is emitted, and that an
 * unresolved one is *omitted* rather than faked.
 *
 * The env-bleed case is the important one. Gemini hands the hook the parent's
 * whole environment, and a real hook process was measured carrying
 * `COPILOT_CLI_BINARY_VERSION=1.0.83` — another agent's version. Reading it
 * would be silently, confidently wrong.
 *
 * The antigravity cases are the second lesson (PTA-357). They used to build an
 * npm layout — manifest, bundle dir, symlink — for a product that ships as a
 * single native binary under a name (`agy`) the resolver did not even look for.
 * The suite was green while the real install resolved nothing, which is the
 * failure a fixture is supposed to catch. They now model what is on disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TRACE = "01HQXM7Y9YZJ8MK7Z6P3X1V8R0";

/** Env names each case may touch; all are saved and restored around the suite. */
const TOUCHED_ENV = [
  "PINTA_GEMINI_HOST_VERSION",
  "PINTA_GEMINI_VERSION_PROBE",
  "COPILOT_CLI_BINARY_VERSION",
  "COPILOT_CLI_VERSION",
  "GEMINI_CLI_VERSION",
  "PATH",
] as const;

/**
 * The resolver caches the host lookup for the life of the process, so each case
 * needs a fresh module instance — otherwise the first case's answer leaks.
 */
async function resourceAttr(
  key: string,
  opts: { agent?: string; event?: Record<string, unknown> } = {}
): Promise<string | undefined> {
  vi.resetModules();
  const { buildOtlpPayload } = await import("../src/core/otlp.js");
  const payload = buildOtlpPayload({
    agent: opts.agent ?? "gemini",
    canonical: { hook: "BeforeTool" },
    event: opts.event ?? {},
    traceId: TRACE,
  });
  const attrs = payload.resourceSpans[0].resource.attributes as Array<{
    key: string;
    value: Record<string, unknown>;
  }>;
  const found = attrs.find((a) => a.key === key);
  return found ? (Object.values(found.value)[0] as string) : undefined;
}

const serviceVersion = (opts?: { agent?: string; event?: Record<string, unknown> }) =>
  resourceAttr("service.version", opts);

/**
 * Lay down an npm-shaped install: a manifest, a bundled entry a level below it,
 * and a symlinked launcher on PATH. Mirrors the real gemini layout measured at
 * `…/@google/gemini-cli/bundle/gemini.js`.
 *
 * `probeOutput` makes the entry an executable that answers `--version`, so a
 * case can prove which of the two sources won.
 */
function fakeInstall(
  root: string,
  opts: { bin: string; pkgName: string; version: unknown; probeOutput?: string }
): string {
  const pkgDir = path.join(root, "lib", "node_modules", ...opts.pkgName.split("/"));
  const bundleDir = path.join(pkgDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: opts.pkgName, version: opts.version })
  );

  const entry = path.join(bundleDir, `${opts.bin}.js`);
  fs.writeFileSync(
    entry,
    opts.probeOutput === undefined ? "// stub\n" : `#!/bin/sh\necho ${JSON.stringify(opts.probeOutput)}\n`
  );
  fs.chmodSync(entry, 0o755);

  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(entry, path.join(binDir, opts.bin));
  return binDir;
}

/**
 * The Antigravity shape: an executable on PATH with NO package.json anywhere
 * above it. Measured — `agy` resolves to a 181MB Mach-O in Homebrew's Caskroom
 * and the manifest walk finds nothing at any of its five levels.
 *
 * `output` is what the binary prints for `--version`; `exitCode` lets a case
 * model a binary that rejects the flag.
 */
function fakeNativeBinary(
  root: string,
  opts: { bin: string; output?: string; exitCode?: number }
): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, opts.bin);
  const body = opts.output === undefined ? "" : `echo ${JSON.stringify(opts.output)}\n`;
  fs.writeFileSync(file, `#!/bin/sh\n${body}exit ${opts.exitCode ?? 0}\n`);
  fs.chmodSync(file, 0o755);
  return binDir;
}

describe("service.version — host CLI version", () => {
  const saved: Record<string, string | undefined> = {};
  let tmp: string;

  beforeEach(() => {
    for (const k of TOUCHED_ENV) saved[k] = process.env[k];
    for (const k of TOUCHED_ENV) delete process.env[k];
    // An empty PATH isolates the case from whatever is really installed on the
    // machine running the suite — this repo's own CI has a gemini on PATH.
    process.env.PATH = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pinta-gemini-ver-"));
  });

  afterEach(() => {
    for (const k of TOUCHED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("omits the attribute entirely when nothing answers — never writes \"unknown\"", async () => {
    expect(await serviceVersion()).toBeUndefined();
  });

  it("still reports service.name and the adapter's own sdk version when unresolved", async () => {
    expect(await resourceAttr("service.name")).toBe("gemini-cli");
    expect(await resourceAttr("telemetry.sdk.version")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("resolves from the executable on PATH via its package manifest", async () => {
    process.env.PATH = fakeInstall(tmp, {
      bin: "gemini",
      pkgName: "@google/gemini-cli",
      version: "0.59.0",
    });
    expect(await serviceVersion()).toBe("0.59.0");
  });

  it("ignores another agent's version bleeding through the host env", async () => {
    // Measured in a live gemini hook: sanitizeEnvironment() passes the parent's
    // whole env through, Copilot's version included. Reading it would report
    // Copilot's release as Gemini's.
    process.env.COPILOT_CLI_BINARY_VERSION = "1.0.83";
    process.env.COPILOT_CLI_VERSION = "1.0.83";
    process.env.GEMINI_CLI_VERSION = "7.7.7"; // no such variable exists either
    expect(await serviceVersion()).toBeUndefined();
  });

  it("honours our own namespaced override", async () => {
    process.env.PINTA_GEMINI_HOST_VERSION = "1.2.3";
    expect(await serviceVersion()).toBe("1.2.3");
  });

  it("prefers a version the host volunteers in the payload", async () => {
    process.env.PATH = fakeInstall(tmp, {
      bin: "gemini",
      pkgName: "@google/gemini-cli",
      version: "0.59.0",
    });
    expect(await serviceVersion({ event: { cli_version: "0.60.0" } })).toBe("0.60.0");
  });

  it("falls through a placeholder in the payload instead of storing it", async () => {
    process.env.PATH = fakeInstall(tmp, {
      bin: "gemini",
      pkgName: "@google/gemini-cli",
      version: "0.59.0",
    });
    expect(await serviceVersion({ event: { cli_version: "unknown" } })).toBe("0.59.0");
  });

  it("rejects a manifest whose version is a channel rather than a release", async () => {
    process.env.PATH = fakeInstall(tmp, {
      bin: "gemini",
      pkgName: "@google/gemini-cli",
      version: "nightly",
    });
    expect(await serviceVersion()).toBeUndefined();
  });

  it("does not hand gemini's binary to an antigravity span", async () => {
    process.env.PATH = fakeInstall(tmp, {
      bin: "gemini",
      pkgName: "@google/gemini-cli",
      version: "0.59.0",
    });
    expect(await serviceVersion({ agent: "antigravity" })).toBeUndefined();
  });

  it("does not hand antigravity's binary to a gemini span", async () => {
    process.env.PATH = fakeNativeBinary(tmp, { bin: "agy", output: "1.2.3" });
    expect(await serviceVersion()).toBeUndefined();
  });

  it("resolves antigravity from its own binary", async () => {
    // The shape actually on disk (PTA-357): the name on PATH is `agy`, and no
    // package.json exists at any level above it, so only `--version` answers.
    // The previous version of this case built an npm layout no Antigravity
    // install has ever had, and passed while the real thing resolved nothing.
    process.env.PATH = fakeNativeBinary(tmp, { bin: "agy", output: "1.2.3" });
    expect(await serviceVersion({ agent: "antigravity" })).toBe("1.2.3");
    expect(await resourceAttr("service.name", { agent: "antigravity" })).toBe("antigravity-cli");
  });

  it("still matches the product name when an installer uses it", async () => {
    process.env.PATH = fakeNativeBinary(tmp, { bin: "antigravity", output: "2.0.1" });
    expect(await serviceVersion({ agent: "antigravity" })).toBe("2.0.1");
  });

  it("prefers the manifest over asking the binary", async () => {
    // The two disagree on purpose. The manifest describes the package and
    // costs a file read; the probe costs a process. Order has to be provable.
    process.env.PATH = fakeInstall(tmp, {
      bin: "gemini",
      pkgName: "@google/gemini-cli",
      version: "0.59.0",
      probeOutput: "9.9.9",
    });
    expect(await serviceVersion()).toBe("0.59.0");
  });

  it("reads a version the binary pads with other words", async () => {
    process.env.PATH = fakeNativeBinary(tmp, {
      bin: "agy",
      output: "antigravity version 1.2.3 (arm64)",
    });
    expect(await serviceVersion({ agent: "antigravity" })).toBe("1.2.3");
  });

  it("omits rather than guessing when the binary rejects --version", async () => {
    process.env.PATH = fakeNativeBinary(tmp, { bin: "agy", exitCode: 1 });
    expect(await serviceVersion({ agent: "antigravity" })).toBeUndefined();
  });

  it("omits when the binary answers with a channel rather than a release", async () => {
    process.env.PATH = fakeNativeBinary(tmp, { bin: "agy", output: "nightly" });
    expect(await serviceVersion({ agent: "antigravity" })).toBeUndefined();
  });

  it("does not probe when it is itself running as a probe", async () => {
    // The guarded failure mode is worse than a wrong answer: a host that fired
    // hooks on `--version` would otherwise spawn processes without bound.
    process.env.PATH = fakeNativeBinary(tmp, { bin: "agy", output: "1.2.3" });
    process.env.PINTA_GEMINI_VERSION_PROBE = "1";
    expect(await serviceVersion({ agent: "antigravity" })).toBeUndefined();
  });
});
