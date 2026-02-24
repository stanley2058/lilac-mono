import { isAbsolute, resolve, extname } from "node:path";
import { expandTilde } from "../tools/fs/fs-impl";

export function resolveToolPath(toolRoot: string, inputPath: string): string {
  const expanded = expandTilde(inputPath);
  const root = resolve(expandTilde(toolRoot));
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(root, expanded);
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
