import { sshExecScriptJson } from "../../ssh/ssh-exec";
import { getRemoteRunnerJsText } from "../../ssh/remote-js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REMOTE_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;

export async function remoteApplyPatch(params: {
  host: string;
  cwd: string;
  patchText: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<string>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "apply_patch",
      denyPaths: REMOTE_DENY_PATHS,
      input: { patchText: params.patchText },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars: 1_000_000,
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, output: res.value };
}
