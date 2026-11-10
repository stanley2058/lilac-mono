import { createFileEditors } from "./file-editors";
import { createThreadPresence } from "./thread-presence";
import { createBackgroundPush } from "./background-push";
import { createNotificationPreferences } from "./notifications";
import { watchConnectionLifecycle } from "./connection-lifecycle";
import { createPanelStore } from "./panel-store";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppProps } from "./types";
import { UploadPool } from "./uploads";
import { createDraftStore } from "./draft-store";
import { createKeybindings } from "./keybindings";
import { createPreferences } from "./preferences";
import { releaseDraftAttachments } from "./draft-thread";

type WorkspaceServices = Pick<
  AppProps,
  "client" | "scope" | "upload" | "resourceUrl" | "draftCache" | "accountProfile" | "authProvider"
> & {
  fileEditors: ReturnType<typeof createFileEditors>;
  keybindings: ReturnType<typeof createKeybindings>;
  panels: ReturnType<typeof createPanelStore>;
  pool: UploadPool;
  drafts: ReturnType<typeof createDraftStore>;
  notifications: ReturnType<typeof createNotificationPreferences>;
  backgroundPush: ReturnType<typeof createBackgroundPush>;
  presence: ReturnType<typeof createThreadPresence>;
  preferences: ReturnType<typeof createPreferences>;
};
const WorkspaceContext = createContext<WorkspaceServices | undefined>(undefined);
export function useOptionalWorkspace() {
  return useContext(WorkspaceContext);
}
export function useWorkspace() {
  return useContext(WorkspaceContext)!;
}

export function WorkspaceProvider({ children, ...props }: AppProps & { children: ReactNode }) {
  // Stores are rebuilt per installation and principal, not per scope object, which the compiler
  // cannot express.
  "use no memo";
  const { client, scope, upload, resourceUrl, draftCache, accountProfile, authProvider } = props;
  useEffect(() => watchConnectionLifecycle(client), [client]);
  const keybindings = useMemo(
    () => createKeybindings(scope),
    [scope.installationId, scope.principalId],
  );
  const fileEditors = useMemo(() => createFileEditors(), [scope.installationId, scope.principalId]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!fileEditors.getState().dirty.size) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [fileEditors]);
  const panels = useMemo(() => createPanelStore(scope), [scope.installationId, scope.principalId]);
  const pool = useMemo(() => new UploadPool(client, upload), [client, upload]);
  const drafts = useMemo(() => createDraftStore(), [client]);
  const preferences = useMemo(
    () => createPreferences(scope),
    [scope.installationId, scope.principalId],
  );
  const notifications = useMemo(
    () => createNotificationPreferences(scope),
    [scope.installationId, scope.principalId],
  );
  const backgroundPush = useMemo(
    () => createBackgroundPush(client, notifications),
    [client, notifications],
  );
  useEffect(() => backgroundPush.start(), [backgroundPush]);
  const presence = useMemo(() => createThreadPresence(client), [client]);
  useEffect(() => presence.start(), [presence]);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.animation = preferences.getState().animation;
    };
    apply();
    const unsubscribe = preferences.subscribe(apply);
    return () => {
      unsubscribe();
      delete document.documentElement.dataset.animation;
    };
  }, [preferences]);
  const services = useMemo(
    () => ({
      client,
      fileEditors,
      scope,
      upload,
      resourceUrl,
      draftCache,
      accountProfile,
      authProvider,
      pool,
      drafts,
      notifications,
      backgroundPush,
      presence,
      preferences,
      panels,
      keybindings,
    }),
    [
      fileEditors,
      client,
      fileEditors,
      scope,
      upload,
      resourceUrl,
      draftCache,
      accountProfile,
      authProvider,
      pool,
      drafts,
      notifications,
      backgroundPush,
      presence,
      preferences,
      panels,
      keybindings,
    ],
  );
  const queries = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
        },
      }),
    [client],
  );
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.kind === "connection" && event.state === "online")
          void queries.invalidateQueries({ refetchType: "none" });
      }),
    [client, queries],
  );
  useEffect(() => () => pool.dispose(), [pool]);
  useEffect(
    () => () => {
      queries.clear();
      for (const draft of drafts.getState().localDrafts.values()) {
        releaseDraftAttachments(draft.attachments);
        releaseDraftAttachments(draft.creation?.entry.submission.attachments ?? []);
      }
    },
    [drafts, queries],
  );
  return (
    <WorkspaceContext value={services}>
      <QueryClientProvider client={queries}>{children}</QueryClientProvider>
    </WorkspaceContext>
  );
}
