import { sshExecScriptJson } from "../../ssh/ssh-exec";
import { getRemoteRunnerJsText } from "../../ssh/remote-js";

export type RemoteReadTextInput = {
  path: string;
  startLine?: number;
  maxLines?: number;
  maxCharacters?: number;
  format?: "raw" | "numbered";
};

export type RemoteReadTextOutput =
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      format: "raw";
      content: string;
    }
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      format: "numbered";
      numberedContent: string;
    }
  | {
      success: false;
      resolvedPath: string;
      error: {
        code: "NOT_FOUND" | "PERMISSION" | "UNKNOWN";
        message: string;
      };
    };

export type RemoteReadBytesResult =
  | {
      ok: true;
      resolvedPath: string;
      fileHash: string;
      bytesLength: number;
      base64: string;
    }
  | {
      ok: false;
      resolvedPath?: string;
      error: string;
    };

export type RemoteGlobEntry = {
  path: string;
  type:
    | "symlink"
    | "file"
    | "directory"
    | "socket"
    | "block_device"
    | "character_device"
    | "fifo"
    | "unknown";
  size: number;
};

export type RemoteGlobOutput = {
  truncated: boolean;
  entries: RemoteGlobEntry[];
  error?: string;
};

export type RemoteGrepMatch = {
  file: string;
  line: number;
  column: number;
  text: string;
  submatches?: { match: string; start: number; end: number }[];
};

export type RemoteGrepOutput = {
  results?: RemoteGrepMatch[];
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 500_000;

export async function remoteReadTextFile(params: {
  host: string;
  cwd: string;
  input: RemoteReadTextInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
}): Promise<RemoteReadTextOutput> {
  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteReadTextOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.read_text",
      denyPaths: params.denyPaths,
      input: params.input,
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    return {
      success: false,
      resolvedPath: params.input.path,
      error: { code: "UNKNOWN", message: res.error },
    };
  }

  return res.value;
}

export async function remoteReadFileBytes(params: {
  host: string;
  cwd: string;
  filePath: string;
  denyPaths: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
}): Promise<RemoteReadBytesResult> {
  // Base64 output can be large (1.33x bytes). Keep a generous cap.
  const maxOutputChars = Math.max(500_000, Math.ceil(params.maxBytes * 1.5) + 10_000);

  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteReadBytesResult>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.read_bytes",
      denyPaths: params.denyPaths,
      input: { path: params.filePath, maxBytes: params.maxBytes },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars,
  });

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  return res.value;
}

export async function remoteGlob(params: {
  host: string;
  cwd: string;
  patterns: readonly string[];
  maxEntries?: number;
  denyPaths: readonly string[];
  timeoutMs?: number;
}): Promise<RemoteGlobOutput> {
  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteGlobOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.glob",
      denyPaths: params.denyPaths,
      input: {
        patterns: params.patterns,
        maxEntries: params.maxEntries,
      },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    return { truncated: false, entries: [], error: res.error };
  }

  return res.value;
}

export async function remoteGrep(params: {
  host: string;
  cwd: string;
  input: {
    pattern: string;
    regex?: boolean;
    maxResults?: number;
    fileExtensions?: readonly string[];
    includeContextLines?: number;
  };
  denyPaths: readonly string[];
  timeoutMs?: number;
}): Promise<RemoteGrepOutput> {
  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteGrepOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.grep",
      denyPaths: params.denyPaths,
      input: {
        pattern: params.input.pattern,
        regex: params.input.regex,
        maxResults: params.input.maxResults,
        fileExtensions: params.input.fileExtensions,
        includeContextLines: params.input.includeContextLines,
      },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    return { error: res.error };
  }

  return res.value;
}

// For unit tests and future callsites.
export function toRemoteDebugPath(host: string, resolvedPath: string): string {
  const p = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;
  return `ssh://${host}${p}`;
}
