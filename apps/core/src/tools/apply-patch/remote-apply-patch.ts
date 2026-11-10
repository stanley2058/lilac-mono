import { DEFAULT_FS_DENY_PATHS } from "../fs/deny-paths";
import { decodeRemoteApplyPatchResponseJson } from "@stanley2058/lilac-fs";

import { sshExecScriptJson } from "../../ssh/ssh-exec";
import { getRemoteRunnerJsText } from "../../ssh/remote-js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REMOTE_ALLOW_ALL_PATHS: readonly string[] = [];

export async function remoteApplyPatch(params: {
  host: string;
  cwd: string;
  patchText: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  dangerouslyAllow?: boolean;
}): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const source = await getRemoteRunnerJsText();
  return source.match<() => Promise<{ ok: true; output: string } | { ok: false; error: string }>>({
    err: (error) => async () => ({ ok: false, error: error.message }),
    ok: (js) => async () => {
      const res = await sshExecScriptJson({
        host: params.host,
        cwd: params.cwd,
        js,
        input: {
          op: "apply_patch",
          denyPaths: [
            ...(params.dangerouslyAllow === true ? REMOTE_ALLOW_ALL_PATHS : DEFAULT_FS_DENY_PATHS),
          ],
          input: { patchText: params.patchText },
        },
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: params.signal,
        maxOutputChars: 1_000_000,
        decodeResponse: decodeRemoteApplyPatchResponseJson,
      });
      return res.match<{ ok: true; output: string } | { ok: false; error: string }>({
        err: (error) => ({ ok: false, error: error.message }),
        ok: (output) => ({ ok: true, output }),
      });
    },
  })();
}
