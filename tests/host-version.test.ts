/**
 * service.version — host CLI version resolution (PTA-348).
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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TRACE = "01HQXM7Y9YZJ8MK7Z6P3X1V8R0";

/** Env names each case may touch; all are saved and restored around the suite. */
const TOUCHED_ENV = [
  "PINTA_GEMINI_HOST_VERSION",
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
 */
function fakeInstall(
  root: string,
  opts: { bin: string; pkgName: string; version: unknown }
): string {
  const pkgDir = path.join(root, "lib", "node_modules", ...opts.pkgName.split("/"));
  const bundleDir = path.join(pkgDir, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: opts.pkgName, version: opts.version })
  );

  const entry = path.join(bundleDir, `${opts.bin}.js`);
  fs.writeFileSync(entry, "// stub\n");
  fs.chmodSync(entry, 0o755);

  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(entry, path.join(binDir, opts.bin));
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

  it("resolves antigravity from its own binary", async () => {
    process.env.PATH = fakeInstall(tmp, {
      bin: "antigravity",
      pkgName: "antigravity-cli",
      version: "1.0.4",
    });
    const version = await serviceVersion({ agent: "antigravity" });
    expect(version).toBe("1.0.4");
    expect(await resourceAttr("service.name", { agent: "antigravity" })).toBe("antigravity-cli");
  });
});
