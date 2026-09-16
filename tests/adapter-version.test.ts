import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_VERSION } from "../src/core/version.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf-8"),
  ) as { version: string };
  return pkg.version;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.m?ts$/.test(full) ? [full] : [];
  });
}

/**
 * Blank out comments while preserving line numbers and string contents.
 *
 * Splitting on `//` would be wrong in both directions here. This repo records
 * measured host versions inside JSDoc blocks — `src/core/host-version.ts`
 * documents a live Gemini CLI 0.59.0 hook process and an Antigravity CLI 1.2.3
 * one, in detail — which a line-comment-only stripper leaves in and reports as
 * violations; and a `//` inside a string literal, such as a URL, would truncate
 * real code and hide a version sitting after it.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * These tests exist because `npm run bump` is a convention, not an enforcement.
 * The script does update package.json, `GUARD_UA`, `PLUGIN_VERSION` and the
 * generated extension manifest in lock-step and aborts if any target is
 * missing — but nothing made a release run it.
 *
 * This repo was in sync when these tests were written, which is the reason to
 * write them rather than not: it was in sync because its last release happened
 * to run the script, and nothing would have said otherwise. Three sibling
 * adaptors show both outcomes:
 *
 *   - pinta-codex drifted at 1.7.0 — package.json 1.7.0, `GUARD_UA`,
 *     `PLUGIN_VERSION` and the plugin manifest all 1.6.0 — and was fixed with a
 *     test pinning each known copy
 *   - pinta-copilot `chore(release): 0.7.0` (1574743) and pinta-opencode
 *     `chore(release): 0.8.0` (754e57d), which had no such test, shipped
 *     sending `pinta-copilot/0.6.0` and `pinta-opencode/0.7.0`
 *
 * Those two commits touched package.json and package-lock.json and nothing
 * else, which is what plain `npm version` produces. Release commits carry the
 * same title in every repo, so the log does not distinguish the ones that ran
 * the script from the ones that did not.
 *
 * These values are consumed by systems that *store* them — the manager
 * attributes guard calls per adaptor from the User-Agent, and `PLUGIN_VERSION`
 * is `telemetry.sdk.version` on every span — so a drift is invisible on the
 * machine that produced it: deployment stats name a version installed nowhere,
 * and the stale-session warning built on that attribution compares a fiction
 * against reality.
 *
 * The second test bans the pattern rather than pinning each constant, which is
 * the one thing pinta-codex's fix could not do: it held its three known copies
 * and would have said nothing about a fourth.
 */
describe("adaptor version", () => {
  it("matches the version in package.json", () => {
    expect(ADAPTER_VERSION).toBe(packageVersion());
  });

  it("is the only version literal in src/ and tools/", () => {
    // `tools/` is in scope because one of its files writes a published
    // artifact: install-hooks.ts generates the gemini-extension.json manifest,
    // and that manifest was a `scripts/bump.mjs` target for exactly that
    // reason. Host versions this adaptor *measures* (Gemini CLI 0.59.0,
    // Antigravity 1.2.3) live in comments, which are stripped above: they
    // describe what was observed, not what we ship.
    const versionLiteral = /(?<![\w.-])\d+\.\d+\.\d+(?![\w.-])/;
    const versionFile = join(repoRoot, "src", "core", "version.ts");
    const offenders: string[] = [];

    for (const tree of ["src", "tools"]) {
      for (const file of sourceFiles(join(repoRoot, tree))) {
        if (file === versionFile) continue;
        const rel = file.slice(repoRoot.length);
        stripComments(readFileSync(file, "utf-8"))
          .split("\n")
          .forEach((line, i) => {
            if (versionLiteral.test(line)) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }

    expect(
      offenders,
      "Version literals must be derived from ADAPTER_VERSION in src/core/version.ts, " +
        "not copied. Copies drift silently.",
    ).toEqual([]);
  });
});
