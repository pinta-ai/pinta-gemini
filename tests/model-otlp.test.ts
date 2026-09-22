import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { OtlpPayload } from "@pinta-ai/core";

const scratch = `.model-wire-${randomUUID()}`;
const root = path.resolve(scratch);
const received: OtlpPayload[] = [];
const guarded: OtlpPayload[] = [];
let server: Server;
let endpoint: string;

function span(payload: OtlpPayload) {
  return payload.resourceSpans[0].scopeSpans[0].spans[0];
}

function attrs(payload: OtlpPayload): Record<string, unknown> {
  return Object.fromEntries(span(payload).attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
}

beforeAll(async () => {
  mkdirSync(scratch);
  await Promise.all(["index.ts", "index.mts"].map((entry, i) => build({
    entryPoints: [`src/${entry}`], outfile: `${scratch}/hook-${i}.mjs`,
    bundle: true, platform: "node", format: "esm", target: "node18", minify: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(raw) as OtlpPayload;
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    if (req.url === "/guard") {
      guarded.push(payload);
      res.end(JSON.stringify({ decision: raw.includes("DENYME") ? "DENY" : "ALLOW", reason: "test-deny" }));
    } else {
      received.push(payload);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { received.length = 0; guarded.length = 0; });

function fire(agent: string, event: string, payload: unknown, entry = 0) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [`${root}/hook-${entry}.mjs`, "--agent", agent, "--event", event], {
      env: {
        PATH: "", HOME: `${root}/home`, GEMINI_HOME: `${root}/home/.gemini`,
        TMPDIR: root, GEMINI_PLUGIN_DATA: `${root}/data`,
        GEMINI_PLUGIN_OPTION_ENDPOINT: `${endpoint}/v1/traces`,
        PINTA_GUARD_ENDPOINT: `${endpoint}/guard`, PINTA_GEMINI_HOST_VERSION: "0.59.0",
      },
      stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

describe("built Gemini/Antigravity hooks → loopback OTLP", () => {
  it("emits nested request evidence and preserves the AfterModel skip/count", async () => {
    const request = { model: "gemini-2.5-pro", messages: [] };
    const before = await fire("gemini", "BeforeModel", { session_id: "s", llm_request: request });
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual({});
    expect(received).toHaveLength(1);
    expect(attrs(received[0])).toMatchObject({
      "gemini.model": "gemini-2.5-pro",
      "gemini.model_source": "requested:llm_request.model",
      "gemini.llm_request": JSON.stringify(request),
    });
    const after = await fire("gemini", "AfterModel", {
      session_id: "s", llm_request: request,
      llm_response: { text: "synthetic chunk", candidates: [], usageMetadata: { candidatesTokenCount: 1 } },
    });
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({});
    expect(received).toHaveLength(1);
    expect(guarded).toHaveLength(0);
  });

  it("omits complete, malformed and truncated JSON-prefixed model strings on both hosts", async () => {
    for (const model of ["{}", "[]", " \t{truncated", "\n [truncated"]) {
      await fire("gemini", "BeforeModel", { session_id: "json-prefix", model, llm_request: { model } });
      await fire("antigravity", "PreInvocation", { conversationId: "json-prefix", modelId: model });
    }
    expect(received).toHaveLength(8);
    for (const payload of received) {
      const actual = attrs(payload);
      expect(actual["gemini.model"]).toBeUndefined();
      expect(actual["antigravity.model"]).toBeUndefined();
    }
  });

  it("does not carry model state across sessions, same-session subagents, switches or stale files", async () => {
    const tool = { tool_name: "read_file", tool_input: { path: "file" } };
    const inputs = [
      { session_id: "a", model: "main-v1", marker: "main" },
      { session_id: "b", model: "other-v1", marker: "other" },
      { session_id: "a", agent_id: "child", model: "child-v1", marker: "child" },
    ];
    const results = await Promise.all(inputs.map((input) => fire("gemini", "BeforeTool", { ...tool, ...input })));
    for (const result of results) expect(result.code).toBe(0);
    await fire("gemini", "BeforeTool", { ...tool, session_id: "a", model: "main-v2", marker: "switch" });
    writeFileSync(`${scratch}/stale.json`, JSON.stringify({ sessionId: "a", messages: [{ type: "gemini", model: "stale" }] }));
    writeFileSync(`${scratch}/malformed.json`, "{broken");
    for (const file of ["stale.json", "malformed.json"]) {
      await fire("gemini", "BeforeTool", {
        ...tool, session_id: "a", transcript_path: `${root}/${file}`, marker: file,
      });
    }
    await fire("gemini", "SessionEnd", { session_id: "a", model: "unknown", marker: "end" });
    expect(received).toHaveLength(7);
    for (const input of [...inputs, { marker: "switch", model: "main-v2" }]) {
      const payload = received.find((p) => attrs(p)["gemini.marker"] === input.marker)!;
      expect(attrs(payload)["gemini.model"]).toBe(input.model);
    }
    for (const marker of ["stale.json", "malformed.json", "end"]) {
      const payload = received.find((p) => attrs(p)["gemini.marker"] === marker)!;
      expect(attrs(payload)["gemini.model"]).toBeUndefined();
    }
  }, 30_000);

  it("uses Antigravity's own fields, preserves raw payload and denies the same model-bearing span", async () => {
    const toolCall = { name: "run_command", args: { CommandLine: "DENYME mysql -psecretpw" } };
    const result = await fire("antigravity", "PreToolUse", {
      conversationId: "conversation", workspacePaths: [root], toolCall,
      modelId: "claude-sonnet-4-5", llm_request: { model: "not-antigravity-evidence" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ decision: "deny", reason: "test-deny" });
    expect(received).toHaveLength(1);
    expect(guarded).toHaveLength(1);
    const actual = attrs(received[0]);
    expect(actual).toMatchObject({
      "antigravity.model": "claude-sonnet-4-5", "antigravity.model_source": "reported:modelId",
      "antigravity.session_id": "conversation", "pinta.guard.decision": "deny",
    });
    expect(actual["antigravity.toolCall"]).not.toContain("secretpw");
    expect(actual["antigravity.toolCall"]).toContain("[REDACTED:cli_password_short]");
    expect(span(guarded[0]).spanId).toBe(span(received[0]).spanId);
    expect(attrs(guarded[0])["antigravity.model"]).toBe(actual["antigravity.model"]);
    await fire("antigravity", "PreInvocation", {
      conversationId: "conversation", llm_request: { model: "gemini-only-shape" },
    });
    expect(attrs(received[1])["antigravity.model"]).toBeUndefined();
  });

  it("covers the ESM entry and malformed input without extra/error model spans", async () => {
    expect((await fire("gemini", "BeforeTool", { session_id: "esm", model: "gemini-2.5-flash" }, 1)).code).toBe(0);
    expect(attrs(received[0])["gemini.model"]).toBe("gemini-2.5-flash");
    expect((await fire("gemini", "BeforeTool", "{broken")).stdout.trim()).toBe("{}");
    expect(received).toHaveLength(1);
  });
});
