import { Panic, Result } from "better-result";
import {
  extractAccountId,
  readCodexTokens,
  refreshAccessToken,
  writeCodexTokens,
  type CodexOAuthFetch,
  type CodexOAuthTokens,
} from "./codex-oauth";

const CODEX_OAUTH_REFRESH_SKEW_MS = 30_000;

export function shouldRefreshCodexOAuthTokens(tokens: CodexOAuthTokens, now = Date.now()): boolean {
  return !tokens.access || tokens.expires <= now + CODEX_OAUTH_REFRESH_SKEW_MS;
}

export type RefreshCodexOAuthTokensOptions = {
  fetch?: CodexOAuthFetch;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

export async function refreshCodexOAuthTokens(
  current: CodexOAuthTokens,
  options: RefreshCodexOAuthTokensOptions = {},
): Promise<CodexOAuthTokens> {
  const tokens = await refreshAccessToken(current.refresh, options.fetch, options.signal);
  const next: CodexOAuthTokens = {
    type: "oauth",
    refresh: tokens.refresh_token ?? current.refresh,
    access: tokens.access_token,
    expires: (options.now ?? Date.now)() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) ?? current.accountId,
    idToken: tokens.id_token ?? current.idToken,
  };
  await (options.writeTokens ?? writeCodexTokens)(next);
  return next;
}

export type CodexOAuthAuthorizationOptions = {
  readTokens?: () => Promise<CodexOAuthTokens | null>;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
};

const CODEX_REFRESH_CALLER_ABORTED = Symbol("codex-refresh-caller-aborted");

type CapturedCodexRefreshFailure =
  | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  | { readonly kind: "defect"; readonly error: Error };
type CodexRefreshOutcome = { readonly kind: "success" } | CapturedCodexRefreshFailure;

function captureCodexRefreshFailure(restoreCause: () => unknown): CapturedCodexRefreshFailure {
  const cause = restoreCause();
  const panic = Result.try({
    try: () => (Panic.is(cause) ? cause : undefined),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  if (panic) return { kind: "panic", panic };
  return {
    kind: "defect",
    error: cause instanceof Error ? cause : new Error("Codex OAuth token refresh failed"),
  };
}

async function waitForCodexRefresh(
  refresh: Promise<CodexRefreshOutcome>,
  signal: AbortSignal,
): Promise<CodexRefreshOutcome | typeof CODEX_REFRESH_CALLER_ABORTED> {
  if (signal.aborted) return CODEX_REFRESH_CALLER_ABORTED;
  let removeAbortListener = () => {};
  const aborted = new Promise<typeof CODEX_REFRESH_CALLER_ABORTED>((resolve) => {
    const onAbort = () => resolve(CODEX_REFRESH_CALLER_ABORTED);
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const outcome = await Promise.race([refresh, aborted]);
  removeAbortListener();
  return outcome;
}

type CodexOAuthAuthorization = (signal?: AbortSignal) => Promise<Record<string, string>>;
let defaultAuthorization: CodexOAuthAuthorization | undefined;

export function createCodexOAuthAuthorization(
  options: CodexOAuthAuthorizationOptions = {},
): CodexOAuthAuthorization {
  if (!options.readTokens && !options.writeTokens) {
    defaultAuthorization ??= createCodexOAuthAuthorization({
      readTokens: readCodexTokens,
      writeTokens: writeCodexTokens,
    });
    return defaultAuthorization;
  }
  let refreshInFlight: Promise<CodexRefreshOutcome> | null = null;
  const readTokens = options.readTokens ?? readCodexTokens;
  const writeTokens = options.writeTokens ?? writeCodexTokens;

  const refreshIfNeeded = async (): Promise<CodexRefreshOutcome> => {
    const captured = await Result.tryPromise({
      try: async () => {
        const latest = await readTokens();
        if (!latest) {
          return {
            kind: "defect" as const,
            error: new Error(
              "Codex OAuth not configured. Complete a Codex OAuth login to authenticate.",
            ),
          };
        }
        if (!shouldRefreshCodexOAuthTokens(latest)) return { kind: "success" as const };
        await refreshCodexOAuthTokens(latest, { writeTokens });
        return { kind: "success" as const };
      },
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    refreshInFlight = null;
    return captured.match<CodexRefreshOutcome>({
      ok: (outcome) => outcome,
      err: ({ restoreCause }) => captureCodexRefreshFailure(restoreCause),
    });
  };

  return async (signal?: AbortSignal): Promise<Record<string, string>> => {
    signal?.throwIfAborted();
    let auth = await readTokens();
    signal?.throwIfAborted();
    if (!auth) {
      throw new Error("Codex OAuth not configured. Complete a Codex OAuth login to authenticate.");
    }
    if (shouldRefreshCodexOAuthTokens(auth)) {
      refreshInFlight ??= refreshIfNeeded();
      const outcome = signal
        ? await waitForCodexRefresh(refreshInFlight, signal)
        : await refreshInFlight;
      if (outcome === CODEX_REFRESH_CALLER_ABORTED) throw signal?.reason;
      if (outcome.kind === "panic") throw outcome.panic;
      if (outcome.kind === "defect") throw outcome.error;
      auth = await readTokens();
      if (!auth?.access) {
        throw new Error("Codex OAuth token refresh failed. Complete a new Codex OAuth login.");
      }
    }
    signal?.throwIfAborted();
    return {
      authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      originator: "lilac",
    };
  };
}
