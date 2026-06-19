import { createRequire as __pintaCreateRequire } from 'module'; const require = __pintaCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../pinta-core/dist/redact.js
var require_redact = __commonJS({
  "../pinta-core/dist/redact.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PATTERNS = exports.MAX_BYTES = void 0;
    exports.truncate = truncate;
    exports.collectMatches = collectMatches;
    exports.resolveOverlaps = resolveOverlaps;
    exports.applyMatches = applyMatches;
    exports.redact = redact;
    exports.MAX_BYTES = 102400;
    function truncate(input) {
      const buf = Buffer.from(input, "utf-8");
      if (buf.length <= exports.MAX_BYTES)
        return input;
      const head = buf.subarray(0, exports.MAX_BYTES).toString("utf-8");
      return `${head}\u2026[TRUNCATED:${buf.length}]`;
    }
    exports.PATTERNS = [
      { type: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
      {
        type: "aws_secret_key",
        // Context word `aws_secret`/`AWS_SECRET` (with optional separator) followed
        // by an assignment-ish character then a 40-char base64-ish blob.
        regex: /(?:aws[_-]?secret(?:[_-]?(?:access)?[_-]?key)?)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
        captureGroup: 1
      },
      {
        type: "gcp_service_account",
        // Whole JSON blob starting with the service-account discriminator.
        regex: /\{[\s\S]{0,200}?"type"\s*:\s*"service_account"[\s\S]*?\}/g
      },
      { type: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
      { type: "gitlab_token", regex: /glpat-[A-Za-z0-9_-]{20}/g },
      { type: "slack_token", regex: /xox[abrsp]-[0-9A-Za-z-]{10,}/g },
      { type: "openai_key", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/g },
      { type: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_-]{50,}/g },
      { type: "stripe_key", regex: /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
      {
        type: "jwt",
        regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
      },
      {
        type: "private_key_block",
        regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
      },
      { type: "bearer_token", regex: /bearer\s+([A-Za-z0-9._~+/=-]{12,})/gi, captureGroup: 1 },
      { type: "basic_auth", regex: /basic\s+([A-Za-z0-9+/=]{12,})/gi, captureGroup: 1 },
      {
        type: "db_url_password",
        regex: /\b(?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:([^@\s]+)@/gi,
        captureGroup: 1
      },
      {
        type: "cli_password_flag",
        regex: /(?:--password|--pass|--pwd)[=\s]([^\s'"]+)/g,
        captureGroup: 1
      },
      {
        type: "cli_password_short",
        // mysql -p<pass>; only on bash context.
        regex: /\s-p([^\s'"]+)/g,
        captureGroup: 1,
        requireContext: "bash"
      },
      {
        type: "env_var_secret",
        // Known false positive: trailing `[A-Z0-9_]*` is greedy, so names like
        // `OPENAI_API_KEY_DESCRIPTION=Used` still match. Acceptable for Bronze.
        regex: /^(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY)[A-Z0-9_]*)\s*=\s*["']?([^\s"'\n]+)/gm,
        captureGroup: 2
      }
    ];
    function collectMatches(input, opts) {
      const out = [];
      for (const pattern of exports.PATTERNS) {
        if (pattern.requireContext && pattern.requireContext !== opts.context)
          continue;
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = re.exec(input)) !== null) {
          const cg = pattern.captureGroup ?? 0;
          const captured = m[cg];
          if (captured === void 0) {
            if (m.index === re.lastIndex)
              re.lastIndex++;
            continue;
          }
          const start = m.index;
          const end = m.index + m[0].length;
          const replaceStart = start + m[0].indexOf(captured);
          const replaceEnd = replaceStart + captured.length;
          out.push({ start, end, replaceStart, replaceEnd, type: pattern.type });
          if (m.index === re.lastIndex)
            re.lastIndex++;
        }
      }
      return out;
    }
    function resolveOverlaps(matches) {
      const sorted = [...matches].sort((a, b) => {
        if (a.start !== b.start)
          return a.start - b.start;
        return b.end - b.start - (a.end - a.start);
      });
      const kept = [];
      let lastEnd = -1;
      for (const m of sorted) {
        if (m.start < lastEnd)
          continue;
        kept.push(m);
        lastEnd = m.end;
      }
      return kept;
    }
    function applyMatches(input, matches) {
      const sorted = [...matches].sort((a, b) => b.replaceStart - a.replaceStart);
      let out = input;
      for (const m of sorted) {
        out = out.slice(0, m.replaceStart) + `[REDACTED:${m.type}]` + out.slice(m.replaceEnd);
      }
      return out;
    }
    function redact(input, opts = {}) {
      if (input.length === 0)
        return input;
      const all = collectMatches(input, opts);
      if (all.length === 0)
        return input;
      const kept = resolveOverlaps(all);
      return applyMatches(input, kept);
    }
  }
});

// ../pinta-core/dist/otlp.js
var require_otlp = __commonJS({
  "../pinta-core/dist/otlp.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ulidToTraceId = ulidToTraceId2;
    exports.newSpanId = newSpanId;
    exports.snakeCase = snakeCase2;
    exports.toOtlpValue = toOtlpValue2;
    exports.attrsFromRecord = attrsFromRecord2;
    exports.guardAttrs = guardAttrs;
    exports.buildPayload = buildPayload2;
    exports.mergeBatch = mergeBatch;
    var crypto_1 = __importDefault(__require("crypto"));
    var redact_js_1 = require_redact();
    var CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    function ulidToTraceId2(ulid) {
      if (ulid.length !== 26) {
        throw new Error(`ulidToTraceId: expected 26 chars, got ${ulid.length}`);
      }
      let n = 0n;
      for (const ch of ulid) {
        const idx = CROCKFORD.indexOf(ch);
        if (idx < 0)
          throw new Error(`ulidToTraceId: invalid Crockford char "${ch}"`);
        n = n << 5n | BigInt(idx);
      }
      const mask = (1n << 128n) - 1n;
      n &= mask;
      return n.toString(16).padStart(32, "0");
    }
    function newSpanId() {
      return crypto_1.default.randomBytes(8).toString("hex");
    }
    function snakeCase2(name) {
      return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
    }
    var EMPTY_SET = /* @__PURE__ */ new Set();
    function maybeRedactString(key, raw, policy) {
      const truncated = (0, redact_js_1.truncate)(raw);
      if ((policy.skipRedactKeys ?? EMPTY_SET).has(key))
        return truncated;
      const context = (policy.bashContextKeys ?? EMPTY_SET).has(key) ? "bash" : void 0;
      return (0, redact_js_1.redact)(truncated, { context });
    }
    function toOtlpValue2(key, v, policy = {}) {
      if (v === null || v === void 0)
        return null;
      switch (typeof v) {
        case "string":
          return { stringValue: maybeRedactString(key, v, policy) };
        case "boolean":
          return { boolValue: v };
        case "number":
          if (Number.isInteger(v))
            return { intValue: v };
          return { doubleValue: v };
        case "object":
          try {
            return { stringValue: maybeRedactString(key, JSON.stringify(v), policy) };
          } catch {
            return { stringValue: maybeRedactString(key, String(v), policy) };
          }
        default:
          return { stringValue: maybeRedactString(key, String(v), policy) };
      }
    }
    function attrsFromRecord2(record, prefix, policy = {}) {
      const out = [];
      for (const [k, v] of Object.entries(record)) {
        const key = `${prefix}.${k}`;
        const value = toOtlpValue2(key, v, policy);
        if (value === null)
          continue;
        out.push({ key, value });
      }
      return out;
    }
    function guardAttrs(guard) {
      const out = [
        { key: "pinta.guard.decision", value: { stringValue: guard.decision.toLowerCase() } },
        { key: "pinta.guard.duration_ms", value: { intValue: guard.durationMs } }
      ];
      if (guard.reason) {
        out.push({ key: "pinta.guard.matched_rule", value: { stringValue: guard.reason } });
      }
      if (guard.failOpenReason) {
        out.push({ key: "pinta.guard.fail_open_reason", value: { stringValue: guard.failOpenReason } });
      }
      return out;
    }
    function buildPayload2(args) {
      const ts = args.now ?? Date.now();
      const tsNano = (BigInt(ts) * 1000000n).toString();
      const attrs = [...args.attributes];
      if (args.guard)
        attrs.push(...guardAttrs(args.guard));
      const span = {
        traceId: ulidToTraceId2(args.traceId),
        spanId: newSpanId(),
        name: args.spanName,
        kind: args.spanKind ?? 1,
        startTimeUnixNano: tsNano,
        endTimeUnixNano: tsNano,
        attributes: attrs
      };
      return {
        resourceSpans: [
          {
            resource: { attributes: args.resource },
            scopeSpans: [{ scope: args.scope, spans: [span] }]
          }
        ]
      };
    }
    function mergeBatch(payloads) {
      const out = [];
      for (const p of payloads)
        out.push(...p.resourceSpans);
      return { resourceSpans: out };
    }
  }
});

// ../pinta-core/dist/guard.js
var require_guard = __commonJS({
  "../pinta-core/dist/guard.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.evaluateGuard = evaluateGuard2;
    var DEFAULT_TIMEOUT_MS = 1e4;
    var DEFAULT_UA = "pinta-core";
    function sleep(ms) {
      return new Promise((_, reject) => setTimeout(() => {
        const err = new Error("Guard request timed out");
        err.name = "TimeoutError";
        reject(err);
      }, ms));
    }
    async function evaluateGuard2(input, endpoint, opts = {}) {
      if (!endpoint)
        return null;
      if (opts.disabled)
        return null;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const start = Date.now();
      try {
        const res = await Promise.race([
          fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": opts.userAgent ?? DEFAULT_UA,
              "x-pinta-relay-token": opts.token ?? ""
            },
            body: JSON.stringify({ input })
          }),
          sleep(timeoutMs)
        ]);
        if (res.status !== 200) {
          return { decision: "ALLOW", reason: null, userMessage: null, durationMs: Date.now() - start, failOpenReason: "error" };
        }
        const body = await res.json();
        return {
          decision: body.decision,
          reason: body.reason,
          userMessage: body.userMessage ?? null,
          durationMs: body.durationMs ?? Date.now() - start
        };
      } catch (err) {
        const reason = err.name === "TimeoutError" ? "timeout" : "error";
        return { decision: "ALLOW", reason: null, userMessage: null, durationMs: Date.now() - start, failOpenReason: reason };
      }
    }
  }
});

// ../pinta-core/dist/retry-queue.js
var require_retry_queue = __commonJS({
  "../pinta-core/dist/retry-queue.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MemoryRetryQueue = exports.DiskRetryQueue = void 0;
    var fs_1 = __importDefault(__require("fs"));
    var path_1 = __importDefault(__require("path"));
    var MAX_ENTRIES = 1e3;
    var LOCK_TIMEOUT_MS = 50;
    var LOCK_POLL_MS = 5;
    var DiskRetryQueue = class {
      filePath;
      lockPath;
      logPrefix;
      constructor(pluginData, logPrefix) {
        this.filePath = path_1.default.join(pluginData, "failed-spans.jsonl");
        this.lockPath = this.filePath + ".lock";
        this.logPrefix = logPrefix;
      }
      /** Append a single payload. Best-effort: any IO error is swallowed (logged to stderr). */
      enqueue(payload) {
        try {
          fs_1.default.mkdirSync(path_1.default.dirname(this.filePath), { recursive: true });
          const line = JSON.stringify({ savedAt: (/* @__PURE__ */ new Date()).toISOString(), payload }) + "\n";
          fs_1.default.appendFileSync(this.filePath, line);
          this.trim();
        } catch (err) {
          process.stderr.write(`[${this.logPrefix}] retry-queue enqueue failed: ${err}
`);
        }
      }
      /**
       * Read all entries oldest-first. Returns [] if the file does not exist or is unreadable.
       * Does NOT delete the file — callers handle persistence via `rewrite`.
       */
      readAll() {
        try {
          const raw = fs_1.default.readFileSync(this.filePath, "utf-8");
          const out = [];
          for (const line of raw.split("\n")) {
            if (!line.trim())
              continue;
            try {
              out.push(JSON.parse(line));
            } catch {
            }
          }
          return out;
        } catch {
          return [];
        }
      }
      /** Replace the queue with the given entries (or delete the file when empty). */
      rewrite(entries) {
        try {
          if (entries.length === 0) {
            if (fs_1.default.existsSync(this.filePath))
              fs_1.default.unlinkSync(this.filePath);
            return;
          }
          fs_1.default.mkdirSync(path_1.default.dirname(this.filePath), { recursive: true });
          fs_1.default.writeFileSync(this.filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
        } catch (err) {
          process.stderr.write(`[${this.logPrefix}] retry-queue rewrite failed: ${err}
`);
        }
      }
      /**
       * Try to acquire the lock for ~LOCK_TIMEOUT_MS. Returns true on success.
       * Caller MUST call `release()` if true is returned.
       */
      tryAcquireLock() {
        const start = Date.now();
        fs_1.default.mkdirSync(path_1.default.dirname(this.lockPath), { recursive: true });
        while (Date.now() - start < LOCK_TIMEOUT_MS) {
          try {
            const fd = fs_1.default.openSync(this.lockPath, "wx");
            fs_1.default.writeSync(fd, String(process.pid));
            fs_1.default.closeSync(fd);
            return true;
          } catch (err) {
            if (err?.code !== "EEXIST") {
              process.stderr.write(`[${this.logPrefix}] retry-queue lock open failed: ${err}
`);
              return false;
            }
            try {
              const st = fs_1.default.statSync(this.lockPath);
              if (Date.now() - st.mtimeMs > 3e4) {
                fs_1.default.unlinkSync(this.lockPath);
                continue;
              }
            } catch {
            }
            const wait = LOCK_POLL_MS;
            const end = Date.now() + wait;
            while (Date.now() < end) {
            }
          }
        }
        return false;
      }
      release() {
        try {
          fs_1.default.unlinkSync(this.lockPath);
        } catch {
        }
      }
      trim() {
        const entries = this.readAll();
        if (entries.length <= MAX_ENTRIES)
          return;
        const drop = entries.length - MAX_ENTRIES;
        process.stderr.write(`[${this.logPrefix}] retry-queue full, dropping ${drop} oldest entries
`);
        this.rewrite(entries.slice(drop));
      }
    };
    exports.DiskRetryQueue = DiskRetryQueue;
    var MemoryRetryQueue = class {
      entries = [];
      enqueue(payload) {
        this.entries.push(payload);
        if (this.entries.length > MAX_ENTRIES) {
          this.entries.splice(0, this.entries.length - MAX_ENTRIES);
        }
      }
      /** Remove and return all buffered payloads. */
      drain() {
        const out = this.entries;
        this.entries = [];
        return out;
      }
      get size() {
        return this.entries.length;
      }
    };
    exports.MemoryRetryQueue = MemoryRetryQueue;
  }
});

// ../pinta-core/dist/transport.js
var require_transport = __commonJS({
  "../pinta-core/dist/transport.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MemoryTransport = exports.DiskTransport = void 0;
    exports.parseHeadersEnv = parseHeadersEnv2;
    exports.envOptionsResolver = envOptionsResolver;
    exports.postOtlp = postOtlp;
    var retry_queue_js_1 = require_retry_queue();
    var otlp_js_1 = require_otlp();
    var TIMEOUT_MS2 = 5e3;
    function parseHeadersEnv2(raw) {
      if (!raw)
        return {};
      if (typeof raw === "object")
        return { ...raw };
      const out = {};
      for (const pair of raw.split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k && rest.length > 0)
          out[k.trim()] = rest.join("=").trim();
      }
      return out;
    }
    function envOptionsResolver() {
      const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      let endpoint;
      if (tracesEndpoint) {
        endpoint = tracesEndpoint.replace(/\/+$/, "");
      } else if (baseEndpoint) {
        endpoint = baseEndpoint.replace(/\/+$/, "") + "/v1/traces";
      }
      if (!endpoint)
        return null;
      return {
        endpoint,
        headers: parseHeadersEnv2(process.env.OTEL_EXPORTER_OTLP_HEADERS)
      };
    }
    async function postOtlp(payload, opts, logPrefix) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS2);
      try {
        const res = await fetch(opts.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...opts.headers },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        if (!res.ok) {
          let body = "";
          try {
            body = (await res.text()).slice(0, 200);
          } catch {
          }
          const hint = res.status === 401 || res.status === 403 ? " \u2014 check OTEL_EXPORTER_OTLP_HEADERS (relay token)" : res.status === 404 ? " \u2014 check OTEL_EXPORTER_OTLP_TRACES_ENDPOINT path" : res.status >= 500 ? " \u2014 collector may be down" : "";
          process.stderr.write(`[${logPrefix}] OTLP POST ${res.status} ${opts.endpoint}${hint}${body ? ` body=${body}` : ""}
`);
          return false;
        }
        return true;
      } catch (err) {
        process.stderr.write(`[${logPrefix}] OTLP POST failed: ${err.message ?? String(err)}
`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    }
    var DiskTransport2 = class {
      queue;
      logPrefix;
      resolveOptions;
      constructor(opts) {
        this.queue = new retry_queue_js_1.DiskRetryQueue(opts.pluginData, opts.logPrefix);
        this.logPrefix = opts.logPrefix;
        this.resolveOptions = opts.resolveOptions ?? envOptionsResolver;
      }
      async send(payload) {
        const opts = this.resolveOptions();
        if (!opts)
          return;
        const ok = await postOtlp(payload, opts, this.logPrefix);
        if (!ok)
          this.queue.enqueue(payload);
      }
      async flush() {
        const opts = this.resolveOptions();
        if (!opts)
          return;
        if (!this.queue.tryAcquireLock())
          return;
        try {
          const entries = this.queue.readAll();
          if (entries.length === 0)
            return;
          const merged = (0, otlp_js_1.mergeBatch)(entries.map((e) => e.payload));
          const ok = await postOtlp(merged, opts, this.logPrefix);
          if (ok)
            this.queue.rewrite([]);
        } finally {
          this.queue.release();
        }
      }
    };
    exports.DiskTransport = DiskTransport2;
    var MemoryTransport = class {
      queue = new retry_queue_js_1.MemoryRetryQueue();
      logPrefix;
      resolveOptions;
      constructor(opts) {
        this.logPrefix = opts.logPrefix;
        this.resolveOptions = opts.resolveOptions;
      }
      async send(payload) {
        const opts = this.resolveOptions();
        if (!opts)
          return;
        const ok = await postOtlp(payload, opts, this.logPrefix);
        if (!ok)
          this.queue.enqueue(payload);
      }
      async flush() {
        const opts = this.resolveOptions();
        if (!opts)
          return;
        const buffered = this.queue.drain();
        if (buffered.length === 0)
          return;
        const merged = (0, otlp_js_1.mergeBatch)(buffered);
        const ok = await postOtlp(merged, opts, this.logPrefix);
        if (!ok)
          for (const p of buffered)
            this.queue.enqueue(p);
      }
    };
    exports.MemoryTransport = MemoryTransport;
  }
});

// ../pinta-core/dist/trace.js
var require_trace = __commonJS({
  "../pinta-core/dist/trace.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceManager = void 0;
    exports.generateUlid = generateUlid;
    var fs_1 = __importDefault(__require("fs"));
    var path_1 = __importDefault(__require("path"));
    var crypto_1 = __importDefault(__require("crypto"));
    var CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    function generateUlid() {
      const now = Date.now();
      let ts = "";
      let t = now;
      for (let i = 0; i < 10; i++) {
        ts = CROCKFORD[t & 31] + ts;
        t = Math.floor(t / 32);
      }
      const rand = crypto_1.default.randomBytes(10);
      let r = "";
      for (let i = 0; i < 10; i++) {
        r += CROCKFORD[rand[i] & 31];
      }
      while (r.length < 16)
        r += CROCKFORD[0];
      return ts + r;
    }
    var TraceManager2 = class {
      tracePath;
      constructor(tracePath) {
        this.tracePath = tracePath;
      }
      /** Generate and persist a fresh trace id (e.g. on UserPromptSubmit). */
      newTrace() {
        const traceId = generateUlid();
        this.save(traceId);
        return traceId;
      }
      /** Return the current trace id, generating one if no trace file exists. */
      currentTrace() {
        try {
          const data = fs_1.default.readFileSync(this.tracePath, "utf-8");
          const { traceId } = JSON.parse(data);
          if (traceId)
            return traceId;
        } catch {
        }
        return this.newTrace();
      }
      save(traceId) {
        fs_1.default.mkdirSync(path_1.default.dirname(this.tracePath), { recursive: true });
        fs_1.default.writeFileSync(this.tracePath, JSON.stringify({ traceId }));
      }
    };
    exports.TraceManager = TraceManager2;
  }
});

// ../pinta-core/dist/session-trace.js
var require_session_trace = __commonJS({
  "../pinta-core/dist/session-trace.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MemorySessionTraceManager = exports.DiskSessionTraceManager = void 0;
    var fs_1 = __importDefault(__require("fs"));
    var path_1 = __importDefault(__require("path"));
    var trace_js_1 = require_trace();
    var DEFAULT_MAX_SESSIONS = 200;
    var DiskSessionTraceManager2 = class {
      tracePath;
      maxSessions;
      constructor(tracePath, opts = {}) {
        this.tracePath = tracePath;
        this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
      }
      read() {
        try {
          const data = JSON.parse(fs_1.default.readFileSync(this.tracePath, "utf-8"));
          if (data && typeof data === "object" && !("traceId" in data)) {
            return data;
          }
        } catch {
        }
        return {};
      }
      write(map) {
        try {
          fs_1.default.mkdirSync(path_1.default.dirname(this.tracePath), { recursive: true });
          const entries = Object.entries(map);
          const capped = entries.length > this.maxSessions ? Object.fromEntries(entries.slice(-this.maxSessions)) : map;
          fs_1.default.writeFileSync(this.tracePath, JSON.stringify(capped));
        } catch {
        }
      }
      newTrace(sessionId) {
        const key = sessionId || "default";
        const traceId = (0, trace_js_1.generateUlid)();
        const map = this.read();
        map[key] = traceId;
        this.write(map);
        return traceId;
      }
      currentTrace(sessionId) {
        const key = sessionId || "default";
        const existing = this.read()[key];
        if (existing)
          return existing;
        return this.newTrace(key);
      }
    };
    exports.DiskSessionTraceManager = DiskSessionTraceManager2;
    var MemorySessionTraceManager = class {
      map = /* @__PURE__ */ new Map();
      maxSessions;
      constructor(opts = {}) {
        this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
      }
      newTrace(sessionId) {
        const key = sessionId || "default";
        const traceId = (0, trace_js_1.generateUlid)();
        this.map.set(key, traceId);
        if (this.map.size > this.maxSessions) {
          const oldest = this.map.keys().next().value;
          if (oldest !== void 0)
            this.map.delete(oldest);
        }
        return traceId;
      }
      currentTrace(sessionId) {
        const key = sessionId || "default";
        return this.map.get(key) ?? this.newTrace(key);
      }
    };
    exports.MemorySessionTraceManager = MemorySessionTraceManager;
  }
});

// ../pinta-core/dist/env-file.js
var require_env_file = __commonJS({
  "../pinta-core/dist/env-file.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.envFilePath = envFilePath2;
    exports.parseEnvFile = parseEnvFile2;
    exports.loadEnvFile = loadEnvFile2;
    var node_fs_1 = __importDefault(__require("node:fs"));
    var node_os_1 = __importDefault(__require("node:os"));
    var node_path_1 = __importDefault(__require("node:path"));
    function envFilePath2(dir, filename, overrideEnvVar) {
      const override = overrideEnvVar ? process.env[overrideEnvVar] : void 0;
      const base = override && override.length > 0 ? override : node_path_1.default.join(node_os_1.default.homedir(), dir);
      return node_path_1.default.join(base, filename);
    }
    function parseEnvFile2(content) {
      const out = {};
      for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
          continue;
        const idx = line.indexOf("=");
        if (idx < 0)
          continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        if (key)
          out[key] = value;
      }
      return out;
    }
    function loadEnvFile2(filePath) {
      let content;
      try {
        content = node_fs_1.default.readFileSync(filePath, "utf-8");
      } catch {
        return;
      }
      const parsed = parseEnvFile2(content);
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === void 0) {
          process.env[key] = value;
        }
      }
    }
  }
});

// ../pinta-core/dist/index.js
var require_dist = __commonJS({
  "../pinta-core/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.loadEnvFile = exports.parseEnvFile = exports.envFilePath = exports.MemorySessionTraceManager = exports.DiskSessionTraceManager = exports.generateUlid = exports.TraceManager = exports.parseHeadersEnv = exports.envOptionsResolver = exports.postOtlp = exports.MemoryTransport = exports.DiskTransport = exports.MemoryRetryQueue = exports.DiskRetryQueue = exports.evaluateGuard = exports.mergeBatch = exports.buildPayload = exports.guardAttrs = exports.attrsFromRecord = exports.toOtlpValue = exports.snakeCase = exports.newSpanId = exports.ulidToTraceId = exports.MAX_BYTES = exports.PATTERNS = exports.applyMatches = exports.resolveOverlaps = exports.collectMatches = exports.truncate = exports.redact = void 0;
    var redact_js_1 = require_redact();
    Object.defineProperty(exports, "redact", { enumerable: true, get: function() {
      return redact_js_1.redact;
    } });
    Object.defineProperty(exports, "truncate", { enumerable: true, get: function() {
      return redact_js_1.truncate;
    } });
    Object.defineProperty(exports, "collectMatches", { enumerable: true, get: function() {
      return redact_js_1.collectMatches;
    } });
    Object.defineProperty(exports, "resolveOverlaps", { enumerable: true, get: function() {
      return redact_js_1.resolveOverlaps;
    } });
    Object.defineProperty(exports, "applyMatches", { enumerable: true, get: function() {
      return redact_js_1.applyMatches;
    } });
    Object.defineProperty(exports, "PATTERNS", { enumerable: true, get: function() {
      return redact_js_1.PATTERNS;
    } });
    Object.defineProperty(exports, "MAX_BYTES", { enumerable: true, get: function() {
      return redact_js_1.MAX_BYTES;
    } });
    var otlp_js_1 = require_otlp();
    Object.defineProperty(exports, "ulidToTraceId", { enumerable: true, get: function() {
      return otlp_js_1.ulidToTraceId;
    } });
    Object.defineProperty(exports, "newSpanId", { enumerable: true, get: function() {
      return otlp_js_1.newSpanId;
    } });
    Object.defineProperty(exports, "snakeCase", { enumerable: true, get: function() {
      return otlp_js_1.snakeCase;
    } });
    Object.defineProperty(exports, "toOtlpValue", { enumerable: true, get: function() {
      return otlp_js_1.toOtlpValue;
    } });
    Object.defineProperty(exports, "attrsFromRecord", { enumerable: true, get: function() {
      return otlp_js_1.attrsFromRecord;
    } });
    Object.defineProperty(exports, "guardAttrs", { enumerable: true, get: function() {
      return otlp_js_1.guardAttrs;
    } });
    Object.defineProperty(exports, "buildPayload", { enumerable: true, get: function() {
      return otlp_js_1.buildPayload;
    } });
    Object.defineProperty(exports, "mergeBatch", { enumerable: true, get: function() {
      return otlp_js_1.mergeBatch;
    } });
    var guard_js_1 = require_guard();
    Object.defineProperty(exports, "evaluateGuard", { enumerable: true, get: function() {
      return guard_js_1.evaluateGuard;
    } });
    var retry_queue_js_1 = require_retry_queue();
    Object.defineProperty(exports, "DiskRetryQueue", { enumerable: true, get: function() {
      return retry_queue_js_1.DiskRetryQueue;
    } });
    Object.defineProperty(exports, "MemoryRetryQueue", { enumerable: true, get: function() {
      return retry_queue_js_1.MemoryRetryQueue;
    } });
    var transport_js_1 = require_transport();
    Object.defineProperty(exports, "DiskTransport", { enumerable: true, get: function() {
      return transport_js_1.DiskTransport;
    } });
    Object.defineProperty(exports, "MemoryTransport", { enumerable: true, get: function() {
      return transport_js_1.MemoryTransport;
    } });
    Object.defineProperty(exports, "postOtlp", { enumerable: true, get: function() {
      return transport_js_1.postOtlp;
    } });
    Object.defineProperty(exports, "envOptionsResolver", { enumerable: true, get: function() {
      return transport_js_1.envOptionsResolver;
    } });
    Object.defineProperty(exports, "parseHeadersEnv", { enumerable: true, get: function() {
      return transport_js_1.parseHeadersEnv;
    } });
    var trace_js_1 = require_trace();
    Object.defineProperty(exports, "TraceManager", { enumerable: true, get: function() {
      return trace_js_1.TraceManager;
    } });
    Object.defineProperty(exports, "generateUlid", { enumerable: true, get: function() {
      return trace_js_1.generateUlid;
    } });
    var session_trace_js_1 = require_session_trace();
    Object.defineProperty(exports, "DiskSessionTraceManager", { enumerable: true, get: function() {
      return session_trace_js_1.DiskSessionTraceManager;
    } });
    Object.defineProperty(exports, "MemorySessionTraceManager", { enumerable: true, get: function() {
      return session_trace_js_1.MemorySessionTraceManager;
    } });
    var env_file_js_1 = require_env_file();
    Object.defineProperty(exports, "envFilePath", { enumerable: true, get: function() {
      return env_file_js_1.envFilePath;
    } });
    Object.defineProperty(exports, "parseEnvFile", { enumerable: true, get: function() {
      return env_file_js_1.parseEnvFile;
    } });
    Object.defineProperty(exports, "loadEnvFile", { enumerable: true, get: function() {
      return env_file_js_1.loadEnvFile;
    } });
  }
});

// src/env-file.ts
var import_core = __toESM(require_dist(), 1);
function envFilePath() {
  return (0, import_core.envFilePath)(".gemini", "pinta-gemini.env", "GEMINI_HOME");
}
function loadEnvFile(filePath = envFilePath()) {
  (0, import_core.loadEnvFile)(filePath);
}

// src/core/config.ts
var import_core2 = __toESM(require_dist(), 1);
import os from "os";
import path from "path";
function geminiHome() {
  return process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
}
function resolveEndpoint() {
  const traces = process.env.GEMINI_PLUGIN_OPTION_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (traces) return traces.replace(/\/+$/, "");
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (base) return base.replace(/\/+$/, "") + "/v1/traces";
  return void 0;
}
function resolveHeaders() {
  const headers = (0, import_core2.parseHeadersEnv)(process.env.GEMINI_PLUGIN_OPTION_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const apiKey = process.env.GEMINI_PLUGIN_OPTION_API_KEY;
  if (apiKey && !headers["x-pinta-relay-token"]) headers["x-pinta-relay-token"] = apiKey;
  return headers;
}
function loadConfig() {
  const pluginData = process.env.GEMINI_PLUGIN_DATA || path.join(geminiHome(), "pinta-gemini-data");
  if (!process.env.PINTA_RELAY_TOKEN && process.env.GEMINI_PLUGIN_OPTION_API_KEY) {
    process.env.PINTA_RELAY_TOKEN = process.env.GEMINI_PLUGIN_OPTION_API_KEY;
  }
  return {
    pluginData,
    tracePath: path.join(pluginData, "trace.json"),
    endpoint: resolveEndpoint(),
    headers: resolveHeaders(),
    guardEndpoint: process.env.PINTA_GUARD_ENDPOINT
  };
}

// src/core/agent.ts
function parseInvocation(argv = process.argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : void 0;
  };
  return { agent: get("--agent") || "gemini", event: get("--event") };
}
function antigravityProduct(ev) {
  const tp = ev["transcriptPath"];
  if (typeof tp !== "string") return void 0;
  if (tp.includes("/antigravity-cli/brain/")) return "agy";
  if (tp.includes("/antigravity/brain/")) return "antigravity2";
  return void 0;
}

// src/core/types.ts
var isGemini = (agent) => agent === "gemini";
var GEMINI = {
  identity: { prefix: "gemini", ingest: "gemini", service: "gemini-cli" },
  gateEvent: "BeforeTool"
};
var ANTIGRAVITY = {
  identity: { prefix: "antigravity", ingest: "antigravity", service: "antigravity-cli" },
  gateEvent: "PreToolUse"
};
var profile = (agent) => isGemini(agent) ? GEMINI : ANTIGRAVITY;
function identity(agent) {
  return profile(agent).identity;
}
function gateEvent(agent) {
  return profile(agent).gateEvent;
}
var SKIP_HOOKS = /* @__PURE__ */ new Set(["AfterModel"]);
var isSkippedHook = (hook) => SKIP_HOOKS.has(hook);

// src/core/normalize.ts
function normalize(agent, event, ev) {
  if (isGemini(agent)) {
    return {
      hook: event || ev["hook_event_name"] || "unknown",
      session_id: asString(ev["session_id"]),
      cwd: asString(ev["cwd"]),
      tool_name: asString(ev["tool_name"]),
      tool_input: ev["tool_input"]
    };
  }
  const workspacePaths = ev["workspacePaths"];
  const toolCall = ev["toolCall"];
  return {
    hook: event || "unknown",
    session_id: asString(ev["conversationId"]),
    cwd: Array.isArray(workspacePaths) ? asString(workspacePaths[0]) : void 0,
    tool_name: toolCall?.name,
    tool_input: toolCall?.args
  };
}
function asString(v) {
  return typeof v === "string" ? v : void 0;
}

// src/core/guard.ts
var import_core3 = __toESM(require_dist(), 1);
var TIMEOUT_MS = 50;
var GUARD_UA = "pinta-gemini/0.4.1";
function shellCommandText(toolInput) {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return void 0;
  const o = toolInput;
  const v = o["command"] ?? o["CommandLine"];
  return typeof v === "string" ? v : void 0;
}
function evaluateGuard(input, endpoint, relayToken) {
  return (0, import_core3.evaluateGuard)(input, endpoint, {
    timeoutMs: TIMEOUT_MS,
    token: relayToken ?? process.env.PINTA_RELAY_TOKEN ?? "",
    disabled: process.env.PINTA_GUARD_DISABLED === "1",
    userAgent: GUARD_UA
  });
}

// src/core/transport.ts
var import_core4 = __toESM(require_dist(), 1);
var Transport = class extends import_core4.DiskTransport {
  constructor(config) {
    super({
      pluginData: config.pluginData,
      logPrefix: "pinta-gemini",
      resolveOptions: () => config.endpoint ? { endpoint: config.endpoint, headers: config.headers } : null
    });
  }
};

// src/core/trace.ts
var import_core5 = __toESM(require_dist(), 1);
var TraceManager = class extends import_core5.DiskSessionTraceManager {
  constructor(config) {
    super(config.tracePath);
  }
};

// src/core/otlp.ts
import os2 from "os";
var import_core6 = __toESM(require_dist(), 1);
var import_core7 = __toESM(require_dist(), 1);
var PLUGIN_VERSION = "0.4.1";
function attrPolicy(prefix) {
  return {
    skipRedactKeys: /* @__PURE__ */ new Set([
      `${prefix}.hook`,
      `${prefix}.agent`,
      `${prefix}.tool_name`,
      `${prefix}.session_id`,
      `${prefix}.transcript_path`,
      `${prefix}.transcriptPath`,
      `${prefix}.cwd`
    ]),
    bashContextKeys: /* @__PURE__ */ new Set([
      `${prefix}.tool_input`,
      `${prefix}.tool_response`,
      `${prefix}.toolCall`
    ])
  };
}
function resourceAttrs(serviceName) {
  return [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "telemetry.sdk.name", value: { stringValue: "pinta-gemini" } },
    { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
    { key: "telemetry.sdk.version", value: { stringValue: PLUGIN_VERSION } },
    { key: "process.pid", value: { intValue: process.pid } },
    { key: "process.owner", value: { stringValue: os2.userInfo().username } },
    { key: "host.name", value: { stringValue: os2.hostname() } },
    { key: "host.arch", value: { stringValue: os2.arch() } }
  ];
}
function buildOtlpPayload(args) {
  const id = identity(args.agent);
  const policy = attrPolicy(id.prefix);
  const attrs = [
    { key: "ingest.type", value: { stringValue: id.ingest } },
    { key: `${id.prefix}.hook`, value: { stringValue: args.canonical.hook } },
    { key: `${id.prefix}.agent`, value: { stringValue: args.agent } }
  ];
  if (args.product) attrs.push({ key: `${id.prefix}.product`, value: { stringValue: args.product } });
  attrs.push(...(0, import_core6.attrsFromRecord)(args.event, id.prefix, policy));
  const have = new Set(attrs.map((a) => a.key));
  for (const [field, val] of [
    ["session_id", args.canonical.session_id],
    ["cwd", args.canonical.cwd],
    ["tool_name", args.canonical.tool_name]
  ]) {
    const key = `${id.prefix}.${field}`;
    if (val != null && !have.has(key)) {
      const value = (0, import_core6.toOtlpValue)(key, String(val), policy);
      if (value !== null) attrs.push({ key, value });
    }
  }
  return (0, import_core6.buildPayload)({
    traceId: args.traceId,
    spanName: `${id.ingest}.${(0, import_core6.snakeCase)(args.canonical.hook)}`,
    attributes: attrs,
    resource: resourceAttrs(id.service),
    scope: { name: "pinta-gemini", version: PLUGIN_VERSION },
    now: args.now,
    guard: args.guard
  });
}

// src/core/decision.ts
function formatDecision(agent, event, guard) {
  if (guard && guard.decision === "DENY") {
    const reason = guard.userMessage ?? guard.reason ?? "guard_deny";
    if (isGemini(agent)) return { decision: "deny", reason, systemMessage: guard.userMessage ?? void 0 };
    return { decision: "deny", reason };
  }
  if (!isGemini(agent) && event === "PreToolUse") return { decision: "allow" };
  return {};
}

// src/core/invocation-log.ts
import fs from "fs";
import path2 from "path";
function logInvocation(config, rec) {
  if (process.env.PINTA_GEMINI_DEBUG !== "1") return;
  try {
    fs.mkdirSync(config.pluginData, { recursive: true });
    fs.appendFileSync(path2.join(config.pluginData, "invocations.jsonl"), JSON.stringify(rec) + "\n");
  } catch {
  }
}

// src/index.ts
loadEnvFile();
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
function isTurnStart(agent, c, ev) {
  if (isGemini(agent)) return c.hook === "BeforeAgent";
  return c.hook === "PreInvocation" && ev["invocationNum"] === 1;
}
async function main() {
  const { agent, event } = parseInvocation();
  let out = {};
  let ev = {};
  let c;
  let guard = null;
  const config = loadConfig();
  try {
    ev = JSON.parse(await readStdin() || "{}");
    c = normalize(agent, event, ev);
    if (!isSkippedHook(c.hook)) {
      const transport = new Transport(config);
      await transport.flush();
      const sessionId = c.session_id ?? "unknown";
      const trace = new TraceManager(config);
      const traceId = isTurnStart(agent, c, ev) ? trace.newTrace(sessionId) : trace.currentTrace(sessionId);
      if (c.hook === gateEvent(agent)) {
        const rawToolInput = shellCommandText(c.tool_input) ?? (typeof c.tool_input === "string" ? c.tool_input : JSON.stringify(c.tool_input ?? null));
        guard = await evaluateGuard(
          { spanId: sessionId, toolName: c.tool_name, toolInput: c.tool_input, rawTextFields: { toolInput: rawToolInput } },
          config.guardEndpoint,
          config.headers["x-pinta-relay-token"]
        );
      }
      const product = isGemini(agent) ? void 0 : antigravityProduct(ev);
      await transport.send(buildOtlpPayload({ agent, canonical: c, event: ev, traceId, guard, product }));
      out = formatDecision(agent, event, guard);
    }
  } catch (e) {
    process.stderr.write(`[pinta-gemini] error: ${e}
`);
    out = {};
  }
  logInvocation(config, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    pid: process.pid,
    agent,
    event,
    argv: process.argv.slice(2),
    received_payload: ev,
    normalized: c ?? null,
    guard,
    decision_returned: out
  });
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}
main();
