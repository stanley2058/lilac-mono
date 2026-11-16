import { DEFAULT_FS_DENY_PATHS } from "../fs/deny-paths";

import { createRemoteFileSystemHost } from "../../ssh/remote-filesystem-host";
import { applyHunksResult, parsePatchResult } from "./apply-patch-core";

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
  const denyPaths =
    params.dangerouslyAllow === true ? REMOTE_ALLOW_ALL_PATHS : DEFAULT_FS_DENY_PATHS;
  const hunks = parsePatchResult(params.patchText);
  if (hunks.isErr()) return { ok: false, error: hunks.error.message };

  const created = await createRemoteFileSystemHost({
    host: params.host,
    denyPaths,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
  });
  if (created.isErr()) return { ok: false, error: created.error.message };
  const host = created.value;
  const parsed = hunks.value;
  if (!host) return { ok: false, error: "remote host unavailable" };

  const applied = await applyHunksResult(params.cwd, parsed, {
    denyPaths,
    signal: params.signal,
    host,
  });
  return applied.match<{ ok: true; output: string } | { ok: false; error: string }>({
    ok: (output) => ({ ok: true, output }),
    err: (error) => ({ ok: false, error: error.message }),
  });
}
