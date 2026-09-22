/**
 * The single source of truth for this adaptor's own version.
 *
 * There is exactly one version literal in `src/` and `tools/`, and it lives
 * here. That is a deliberate constraint, enforced by
 * `tests/adapter-version.test.ts`, which checks this value against package.json
 * and scans both trees for any other literal of the same shape.
 *
 * The constraint exists because `npm run bump` -- which does update every
 * embedded copy in lock-step -- is a convention, and nothing enforced it. This
 * repo was in sync when the constraint was added, but only because its last
 * release happened to run the script; there was no test that would have
 * noticed otherwise. Three sibling adaptors show both outcomes:
 *
 *   - pinta-codex drifted at 1.7.0 (package.json 1.7.0, three copies 1.6.0) and
 *     was fixed by a test pinning each known copy
 *   - pinta-copilot 0.7.0 (1574743) and pinta-opencode 0.8.0 (754e57d), which
 *     had no such test, shipped sending 0.6.0 and 0.7.0 respectively
 *
 * Those two release commits touched package.json and package-lock.json and
 * nothing else, which is exactly what plain `npm version` produces. Release
 * commits are titled `chore(release): <version>` in every repo, so reading the
 * log does not tell you which ones ran the script.
 *
 * These values are consumed by systems that *store* them -- the manager
 * attributes guard calls per adaptor from the User-Agent, and PLUGIN_VERSION is
 * `telemetry.sdk.version` on every span -- so a drift is invisible on the
 * machine that produced it and wrong everywhere the numbers are read. A comment
 * saying "keep in sync" sat directly above the old `GUARD_UA`. A comment is not
 * a mechanism; a failing test is.
 *
 * It is a literal rather than an import of package.json because the bundle is
 * produced by esbuild CLI invocations with no config file, and importing JSON
 * would inline the entire manifest into `dist/`.
 */
export const ADAPTER_VERSION = "0.12.0";
