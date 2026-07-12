#!/usr/bin/env node
// M5b/M5e — Node 20 smoke test for the ESM dual-entry (dist/index.mjs).
//
// Two things must hold:
//   1. `lifecycle` is exported and `lifecycle.id === 'pinta-gemini'`.
//   2. Importing the module must NOT run the hook's runHook() — which would
//      read stdin, forward a span, and call process.exit(). If the
//      import.meta.url-vs-argv[1] guard in src/index.mts is broken, runHook()
//      fires as a side effect of module evaluation.
//
// We don't rely on timing to catch (2): `for await (chunk of process.stdin)`
// puts stdin into flowing mode synchronously as part of entering the async
// iterator, and that happens before any `await` inside runHook() can yield —
// so a broken guard flips `process.stdin.readableFlowing` to `true` (or
// `false`, if paused) within the SAME synchronous turn that evaluates the
// module's top level, i.e. before `await import(...)` below resolves. A
// correct guard leaves it `null` (untouched).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.join(here, "..", "dist", "index.mjs");

const flowingBefore = process.stdin.readableFlowing;
if (flowingBefore !== null) {
  console.error(
    `[smoke:import] FAIL: process.stdin.readableFlowing was already ${flowingBefore} before import — cannot assert`,
  );
  process.exit(1);
}

const mod = await import(entryPath);

const flowingAfter = process.stdin.readableFlowing;
if (flowingAfter !== null) {
  console.error(
    `[smoke:import] FAIL: importing dist/index.mjs touched process.stdin (readableFlowing=${flowingAfter}) — ` +
      "the direct-exec guard did not prevent runHook() from running.",
  );
  process.exit(1);
}

if (typeof mod.lifecycle === "undefined") {
  console.error("[smoke:import] FAIL: dist/index.mjs did not export `lifecycle`");
  process.exit(1);
}

if (mod.lifecycle.id !== "pinta-gemini") {
  console.error(
    `[smoke:import] FAIL: lifecycle.id = ${JSON.stringify(mod.lifecycle.id)}, expected "pinta-gemini"`,
  );
  process.exit(1);
}

// Extra margin: give any errantly-fired runHook() a tick to blow up (e.g. via
// process.exit()) before we declare success.
await new Promise((resolve) => setTimeout(resolve, 50));

console.log(
  "[smoke:import] OK: import()-ing dist/index.mjs did not run the hook, and lifecycle.id === 'pinta-gemini'",
);
process.exit(0);
