import type { Result } from "better-result";
import { readAuthInfo, type AuthInfo, type WebRequestFailed } from "./http";

export type AuthInfoState = { auth?: AuthInfo; error?: string };
type AuthInfoResult = Result<AuthInfo, WebRequestFailed>;

export function clerkPublishableKey(auth: AuthInfo | undefined): string | undefined {
  return auth?.provider === "clerk" ? auth.publishableKey : undefined;
}

export type AuthInfoLoader = ReturnType<typeof createAuthInfoLoader>;

/** Unknown settings count as needing a provider token, so a retry never sends the cookie alone. */
export async function providerTokenRequired(loader: Pick<AuthInfoLoader, "load">) {
  return (await loader.load()).match({
    ok: (auth) => !!clerkPublishableKey(auth),
    err: () => true,
  });
}

// A page that starts offline cannot read the auth settings, so a failed read is repeated on the
// next request instead of being kept for the life of the page.
export function createAuthInfoLoader(read: () => Promise<AuthInfoResult> = readAuthInfo) {
  let state: AuthInfoState = {};
  let request: Promise<AuthInfoResult> | undefined;
  const listeners = new Set<() => void>();
  const settle = (result: AuthInfoResult) => {
    state = result.match<AuthInfoState>({
      ok: (auth) => ({ auth }),
      err: (error) => {
        request = undefined;
        return { error: error.message };
      },
    });
    for (const listener of listeners) listener();
    return result;
  };
  return {
    /** Returns the loaded settings, or reads them again after a failed read. */
    load(): Promise<AuthInfoResult> {
      request ??= read().then(settle);
      return request;
    },
    getSnapshot: (): AuthInfoState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
