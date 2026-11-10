import { ConnectionLoading } from "./components/ui/connection-loading";
import { SkeletonLines } from "./components/ui/skeleton";
import { loadSavedTheme, watchSystemTheme } from "./theme/theme";
import { SurfaceVisibilityContext } from "./components/ui/surface-visibility";
import { Outlet, RouterProvider, useMatch } from "@tanstack/react-router";
import { createAppRouter } from "./router";
import { Button } from "./components/ui/button";
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Result } from "better-result";
import { WebSessionController, webCache, type WebState } from "./bootstrap";
import { LocalLogin } from "./auth";
import { readAuthInfo, resourceUrl, uploadResource, type AuthInfo } from "./http";
import { requireConnectionCredentials } from "./connection-credentials";
import { isConnectionFailure } from "./connection-lifecycle";
import { closeConnectionNotice, showConnectionNotice } from "./use-connection-notice";
import { watchAppUpdates, watchAppUpdateChecks, type AppUpdate } from "./updates";
import { showAppUpdateToast } from "./app-update-toast";
import { AccountLoadBoundary } from "./AccountLoadBoundary";
import App from "./App";
import "./styles.css";
import { Toaster, toast } from "./components/ui/toast";

const ClerkLogin = lazy(() => import("./clerk").then((module) => ({ default: module.ClerkLogin })));
const ClerkSession = lazy(() =>
  import("./clerk").then((module) => ({ default: module.ClerkSession })),
);
const ClerkAccount = lazy(() =>
  import("./clerk").then((module) => ({ default: module.ClerkAccount })),
);
const ClerkCredentials = lazy(() =>
  import("./clerk").then((module) => ({ default: module.ClerkCredentials })),
);
const sessions = new WebSessionController();
let authInfo: ReturnType<typeof readAuthInfo> | undefined;
let sessionStarted = false;
function clerkKey(result: Awaited<ReturnType<typeof readAuthInfo>>): string | undefined {
  return result.match({
    ok: (auth) => (auth.provider === "clerk" ? auth.publishableKey : undefined),
    err: () => undefined,
  });
}
function enterChat() {
  authInfo ??= readAuthInfo();
  if (sessionStarted) return;
  sessionStarted = true;
  requireConnectionCredentials(authInfo.then((result) => !!clerkKey(result)));
  start();
}
const start = () => {
  return sessions.start();
};
// Auth settings are read once at startup, and the sign-in and credential flows all depend on them.
const reloadPage = () => {
  location.reload();
  return new Promise<void>(() => {});
};
const logout = async () => {
  const auth = await authInfo;
  if (!auth) return;
  const provider = auth.match({ ok: (value) => value.provider, err: () => "local" });
  if (provider !== "clerk") {
    await sessions.logout();
    return;
  }
  const loadedProvider = await Result.tryPromise({
    try: async () => (await import("./clerk")).signOutActiveClerk,
    catch: () =>
      new Error("Could not load account controls. Reload to finish signing out of Clerk."),
  });
  await loadedProvider.match({
    ok: (signOut) => sessions.logout(signOut),
    err: (error) => sessions.logout(async () => Result.err(error)),
  });
};

// Sign-in is the only screen that needs auth settings, so a failed read must not outlive it.
function signInMessage(state: WebState, authError: string): string {
  if (state.kind !== "login") return "";
  if (state.message && state.message !== "Sign in to continue") return state.message;
  return authError;
}

function Root() {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const [auth, setAuth] = useState<AuthInfo>();
  const [authError, setAuthError] = useState("");
  const [update, setUpdate] = useState<AppUpdate>();
  const client = state.kind === "ready" ? state.session.client : undefined;
  useEffect(() => {
    void authInfo?.then((result) =>
      result.match({ ok: setAuth, err: (error) => setAuthError(error.message) }),
    );
  }, []);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void watchAppUpdates(setUpdate).then((cleanup) => {
      if (disposed) {
        cleanup?.();
        return;
      }
      stop = cleanup;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!client) return;
    return watchAppUpdateChecks(client);
  }, [client]);
  useEffect(() => {
    if (!update) return;
    const id = showAppUpdateToast(update.activate);
    return () => toast.close(id);
  }, [update]);
  const loginMessage = signInMessage(state, authError);
  const unreachable = isConnectionFailure(loginMessage);
  const offlineReason = state.kind === "offline" ? state.message : undefined;
  const connectionReason = offlineReason ?? (unreachable ? loginMessage : undefined);
  const retryConnection = state.kind === "offline" ? start : reloadPage;
  useEffect(() => {
    if (!connectionReason) return;
    showConnectionNotice({ reason: connectionReason, retry: retryConnection });
    return () => closeConnectionNotice();
  }, [connectionReason, retryConnection]);
  const sessionError = unreachable ? "" : loginMessage;
  useEffect(() => {
    if (!sessionError) return;
    toast.add({ id: "session-status", title: sessionError, type: "error", timeout: 0 });
    return () => toast.close("session-status");
  }, [sessionError]);
  const reload = update?.activate ?? (() => location.reload());
  if (state.kind === "starting")
    return (
      <div className="login-shell w-[min(100%_-_calc(var(--ui-space-unit)*8),_24rem)] min-h-dvh mx-auto flex flex-col justify-center gap-6 py-12">
        <h1>Lilac</h1>
        <ConnectionLoading />
      </div>
    );
  if (state.kind === "offline")
    return (
      <main className="login-shell w-[min(100%_-_calc(var(--ui-space-unit)*8),_24rem)] min-h-dvh mx-auto flex flex-col justify-center gap-6 py-12">
        <h1>Lilac</h1>
        <Button onClick={start}>Reconnect</Button>
      </main>
    );
  if (state.kind === "login")
    return (
      <main className="login-shell w-[min(100%_-_calc(var(--ui-space-unit)*8),_24rem)] min-h-dvh mx-auto flex flex-col justify-center gap-6 py-12">
        <h1>Lilac</h1>
        {state.signingOut ? <p role="status">Signing out…</p> : null}
        {state.logoutFailed ? (
          <Button disabled={state.signingOut} onClick={logout}>
            Retry sign out
          </Button>
        ) : null}
        {!state.logoutFailed && auth?.provider === "local" ? (
          <fieldset disabled={state.signingOut}>
            <LocalLogin onSignedIn={start} />
          </fieldset>
        ) : null}
        {!state.signingOut &&
        !state.logoutFailed &&
        auth?.provider === "clerk" &&
        auth.publishableKey ? (
          <AccountLoadBoundary onReload={reload} message="Unable to load sign-in.">
            <Suspense fallback={<ConnectionLoading />}>
              <ClerkLogin publishableKey={auth.publishableKey} onSignedIn={start} />
            </Suspense>
          </AccountLoadBoundary>
        ) : null}
      </main>
    );
  const { session } = state;
  const sessionControl =
    auth?.provider === "clerk" && auth.publishableKey ? (
      <AccountLoadBoundary onReload={reload} message="Unable to load account controls.">
        <Suspense fallback={null}>
          <ClerkSession
            publishableKey={auth.publishableKey}
            client={session.client}
            onLogout={logout}
          />
        </Suspense>
      </AccountLoadBoundary>
    ) : undefined;
  const accountProfile =
    auth?.provider === "clerk" && auth.publishableKey ? (
      <AccountLoadBoundary onReload={reload} message="Unable to load account settings.">
        <Suspense fallback={<SkeletonLines label="Loading account" lines={5} className="py-2" />}>
          <ClerkAccount publishableKey={auth.publishableKey} />
        </Suspense>
      </AccountLoadBoundary>
    ) : undefined;
  return (
    <App
      {...session}
      draftCache={webCache}
      upload={uploadResource}
      resourceUrl={resourceUrl}
      onLogout={logout}
      sessionControl={sessionControl}
      accountProfile={accountProfile}
      authProvider={auth?.provider}
    />
  );
}

function ConnectionCredentials() {
  const [publishableKey, setPublishableKey] = useState<string>();
  useEffect(() => {
    void authInfo?.then((result) => setPublishableKey(clerkKey(result)));
  }, []);
  if (!publishableKey) return null;
  return (
    <AccountLoadBoundary>
      <Suspense fallback={null}>
        <ClerkCredentials publishableKey={publishableKey} />
      </Suspense>
    </AccountLoadBoundary>
  );
}

function RouteShell() {
  const chat = useMatch({ from: "/chat", shouldThrow: false, select: () => true }) ?? false;
  const [visitedChat, setVisitedChat] = useState(chat);
  if (chat && !visitedChat) setVisitedChat(true);
  return (
    <>
      {visitedChat ? (
        <div hidden={!chat} style={{ height: "100%" }}>
          <SurfaceVisibilityContext value={chat}>
            <ConnectionCredentials />
            <Root />
          </SurfaceVisibilityContext>
        </div>
      ) : null}
      <Outlet />
    </>
  );
}

watchSystemTheme();
await loadSavedTheme();

const router = createAppRouter({ shellComponent: RouteShell, onChatEnter: enterChat });
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <Toaster>
      <RouterProvider router={router} />
    </Toaster>,
  );
