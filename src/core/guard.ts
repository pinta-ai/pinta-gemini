export interface GuardInput {
  spanId: string;
  toolName?: string;
  toolInput?: unknown;
  rawTextFields?: Record<string, string>;
}

export interface GuardResult {
  decision: 'ALLOW' | 'DENY' | 'REVIEW';
  reason: string | null;
  // Pre-formatted message the manager wants surfaced to the LLM/user when
  // decision === 'DENY'. Null otherwise, or when talking to an older manager
  // that doesn't yet emit this field.
  userMessage: string | null;
  durationMs: number;
  failOpenReason?: 'timeout' | 'refused' | 'error';
}

const TIMEOUT_MS = 50;

// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Keep the
// version in sync with package.json.
const GUARD_UA = 'pinta-gemini/0.4.0';

/**
 * The shell command text out of a tool_input, regardless of host field name:
 * Gemini CLI's run_shell_command uses `command`, Antigravity's run_command uses
 * PascalCase `CommandLine`. The manager's guard scans rawTextFields.toolInput as
 * its shell-command fallback (the package extractor reads toolInput.command or
 * rawTextFields.toolInput) and cannot parse a command out of a JSON-stringified
 * object — so for Antigravity we must hand it the plain command string, else the
 * package guard silently fails open. Returns undefined for non-shell shapes so
 * the caller keeps its JSON-stringify fallback.
 */
export function shellCommandText(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return undefined;
  const o = toolInput as Record<string, unknown>;
  const v = o['command'] ?? o['CommandLine'];
  return typeof v === 'string' ? v : undefined;
}

function sleep(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => {
      const err = new Error('Guard request timed out');
      err.name = 'TimeoutError';
      reject(err);
    }, ms),
  );
}

export async function evaluateGuard(
  input: GuardInput,
  endpoint: string | undefined,
  // Relay token to authenticate the guard call. Pass the SAME token the trace
  // transport uses (config.headers['x-pinta-relay-token'], parsed from
  // GEMINI_PLUGIN_OPTION_HEADERS) so trace and guard share one env source.
  // Falls back to PINTA_RELAY_TOKEN for back-compat with older enrollments.
  relayToken?: string,
): Promise<GuardResult | null> {
  if (!endpoint) return null;
  if (process.env.PINTA_GUARD_DISABLED === '1') return null;
  const start = Date.now();
  try {
    const res = await Promise.race([
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': GUARD_UA,
          'x-pinta-relay-token': relayToken ?? process.env.PINTA_RELAY_TOKEN ?? '',
        },
        body: JSON.stringify({ input }),
      }),
      sleep(TIMEOUT_MS),
    ]);
    if (res.status !== 200) {
      return { decision: 'ALLOW', reason: null, userMessage: null, durationMs: Date.now() - start, failOpenReason: 'error' };
    }
    const body = (await res.json()) as {
      decision: GuardResult['decision'];
      reason: string | null;
      userMessage?: string | null;
      durationMs?: number;
    };
    return {
      decision: body.decision,
      reason: body.reason,
      userMessage: body.userMessage ?? null,
      durationMs: body.durationMs ?? (Date.now() - start),
    };
  } catch (err) {
    const reason: GuardResult['failOpenReason'] = (err as Error).name === 'TimeoutError' ? 'timeout' : 'error';
    return { decision: 'ALLOW', reason: null, userMessage: null, durationMs: Date.now() - start, failOpenReason: reason };
  }
}
