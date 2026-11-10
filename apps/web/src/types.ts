import type { ModelReasoning } from "@stanley2058/lilac-client-protocol";
import type { WebNativeCache } from "./cache";
import type { ReactNode } from "react";
import type { NativeClient, CacheScope } from "@stanley2058/lilac-client";
import type {
  BootstrapReply,
  DisplayCatalog,
  NativeThread,
  NativeRpcOutputs,
} from "@stanley2058/lilac-client-protocol";

export type AppProps = {
  client: NativeClient;
  initial: BootstrapReply;
  scope: CacheScope;
  initialThreadId?: string;
  upload: (
    resourceId: string,
    file: File,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  resourceUrl: (resourceId: string) => string;
  onLogout: () => Promise<void>;
  sessionControl?: ReactNode;
  accountProfile?: ReactNode;
  draftCache?: Pick<WebNativeCache, "readDraft" | "saveDraft" | "listLocalDrafts" | "deleteDraft"> &
    Partial<Pick<WebNativeCache, "flushDrafts">>;
};
export type Attachment = {
  key: string;
  file: File;
  preview?: string;
  resourceId?: string;
  reservation: Promise<string | undefined>;
  progress: number;
  state: "reserving" | "uploading" | "ready" | "failed";
  error?: string;
};
export type ComposerSubmission = {
  text: string;
  attachmentText?: string;
  skillIds: string[];
  mode: "steer" | "followup";
  modelId?: string;
  reasoning?: ModelReasoning;
  command?: { id: string; arguments: string };
  attachments: Attachment[];
  /** Answers this pending question with the whole message. */
  questionReply?: { messageId: string; token: string };
};
export type ChatCommon = Pick<AppProps, "client" | "scope" | "resourceUrl" | "upload"> & {
  thread: NativeThread;
  catalog?: DisplayCatalog;
  onError: (message: string) => void;
};
export type QueueEntry = NativeRpcOutputs["runs"]["queue"]["items"][number];
