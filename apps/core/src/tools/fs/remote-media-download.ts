import { createDownload } from "ai";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError } from "better-result";

import { captureError } from "../../shared/error-capture";
import type { ReadRemoteMedia } from "./fs";

export class RemoteMediaTooLarge extends TaggedError("RemoteMediaTooLarge")<{
  readonly message: string;
}> {}

class RemoteMediaDownloadFailed extends TaggedError("RemoteMediaDownloadFailed")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export const readRemoteMedia: ReadRemoteMedia = async ({ url, abortSignal, maxBytes }) => {
  const captured = (
    await Result.tryPromise({
      try: () => createDownload({ maxBytes })({ url, abortSignal }),
      catch: captureError,
    })
  ).match<
    | { readonly kind: "success"; readonly data: Uint8Array }
    | { readonly kind: "failure"; readonly cause: Error }
  >({
    ok: ({ data }) => ({ kind: "success", data }),
    err: ({ cause }) => ({ kind: "failure", cause }),
  });
  if (captured.kind === "success") return Result.ok({ data: captured.data });
  if (Panic.is(captured.cause)) throw captured.cause;
  // The SDK exposes size failures only through its download error message.
  if (/too large|media limit|maximum \d+ bytes|exceeded.*bytes/i.test(captured.cause.message)) {
    return Result.err(new RemoteMediaTooLarge({ message: captured.cause.message }));
  }
  return Result.err(
    new RemoteMediaDownloadFailed({
      cause: captured.cause,
      message: opaqueErrorMessage(captured.cause, "Remote media download failed"),
    }),
  );
};
