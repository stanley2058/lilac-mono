import { createHash } from "node:crypto";
import { isAbsolute, resolve, extname, relative, sep } from "node:path";
import { posix as posixPath } from "node:path";
import { expandTilde } from "../tools/fs/fs-impl";

const RESTRICTED_TMP_ROOT = "/tmp/lilac-restricted";
const RESTRICTED_TMP_MOUNT = "/tmp";

type ToolPathRequestContext = {
  sessionId?: string;
  safetyMode?: "trusted" | "restricted";
};

export function resolveToolPath(toolRoot: string, inputPath: string): string {
  const expanded = expandTilde(inputPath);
  const root = resolve(expandTilde(toolRoot));
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(root, expanded);
}

function restrictedSessionPathToken(value: string | undefined): string {
  const raw = value?.trim() || "unknown-session";
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveRestrictedSessionTmpDir(sessionId: string | undefined): string {
  return resolve(RESTRICTED_TMP_ROOT, restrictedSessionPathToken(sessionId));
}

export function resolveToolPathForRequestContext(params: {
  cwd: string;
  inputPath: string;
  context?: ToolPathRequestContext | undefined;
}): string {
  if (params.context?.safetyMode !== "restricted") {
    return resolveToolPath(params.cwd, params.inputPath);
  }

  if (!params.context.sessionId) {
    throw new Error("Restricted mode file paths require a session id.");
  }

  if (params.inputPath.startsWith("~")) {
    throw new Error("Restricted mode only allows file paths under /tmp.");
  }

  const cwd = params.cwd.startsWith("/") ? params.cwd : `/${params.cwd}`;
  const base = posixPath.normalize(cwd);
  const input = params.inputPath.startsWith("/")
    ? params.inputPath
    : posixPath.join(base, params.inputPath);
  const virtualPath = posixPath.normalize(input);

  if (virtualPath !== RESTRICTED_TMP_MOUNT && !virtualPath.startsWith(`${RESTRICTED_TMP_MOUNT}/`)) {
    throw new Error("Restricted mode only allows file paths under /tmp.");
  }

  const relativeToTmp = virtualPath === RESTRICTED_TMP_MOUNT ? "" : virtualPath.slice(5);
  const tmpRoot = resolveRestrictedSessionTmpDir(params.context.sessionId);
  const resolved = resolve(tmpRoot, relativeToTmp.split("/").join(sep));
  if (!isPathInside(tmpRoot, resolved)) {
    throw new Error("Restricted mode only allows file paths under /tmp.");
  }

  return resolved;
}

export function formatToolPathForRequestContext(params: {
  path: string;
  context?: ToolPathRequestContext | undefined;
}): string {
  if (params.context?.safetyMode !== "restricted") return params.path;

  const tmpRoot = resolveRestrictedSessionTmpDir(params.context.sessionId);
  const resolved = resolve(params.path);
  if (!isPathInside(tmpRoot, resolved)) return RESTRICTED_TMP_MOUNT;

  const rel = relative(tmpRoot, resolved);
  if (rel === "") return RESTRICTED_TMP_MOUNT;
  return `${RESTRICTED_TMP_MOUNT}/${rel.split(sep).join("/")}`;
}

export function inferMimeTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".m4v":
      return "video/x-m4v";
    case ".mkv":
      return "video/x-matroska";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".log":
      return "text/plain";
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".json":
      return "application/json";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "application/javascript";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/x-yaml";
    case ".csv":
      return "text/csv";
    default:
      return "application/octet-stream";
  }
}

export function inferExtensionFromMimeType(mimeType: string): string {
  const mt = mimeType.toLowerCase().split(";")[0]?.trim();
  switch (mt) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "video/x-m4v":
      return ".m4v";
    case "video/x-matroska":
      return ".mkv";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    case "text/csv":
      return ".csv";
    default:
      return "";
  }
}

export function looksLikeHttpUrl(s: string): boolean {
  return s.startsWith("https://") || s.startsWith("http://");
}

export function looksLikeDataUrl(s: string): boolean {
  return s.startsWith("data:");
}

export function decodeDataUrl(s: string): {
  bytes: Buffer;
  mimeType?: string;
} {
  const comma = s.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid data URL");
  }

  const meta = s.slice(5, comma);
  const data = s.slice(comma + 1);

  const metaParts = meta.split(";");
  const mimeType = metaParts[0] ? metaParts[0] : undefined;
  const isBase64 = metaParts.includes("base64");

  const bytes = isBase64 ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
  return { bytes, mimeType };
}

export function sanitizeExtension(ext: string): string {
  if (!ext) return "";
  const normalized = ext.startsWith(".") ? ext : `.${ext}`;
  if (!/^\.[a-z0-9]+$/u.test(normalized)) return "";
  if (normalized.length > 10) return "";
  return normalized;
}
