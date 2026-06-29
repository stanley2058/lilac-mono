/* oxlint-disable eslint/no-control-regex */

import { Buffer } from "node:buffer";

export function formatInt(n: number): string {
  // Locale-independent grouping.
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatSeconds(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(1)}s`;
}

export function sanitizeFilenameToken(raw: string): string {
  // Keep names mostly readable for humans (diff workflows) while preventing
  // directory traversal or weird control chars.
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, "_")
    .replace(/[\\/]/g, "_")
    .slice(0, 200);
}

export function debugJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof URL) return v.toString();
      if (v instanceof Error) {
        return {
          name: v.name,
          message: v.message,
          stack: v.stack,
        };
      }

      // Bun/Node Buffers are Uint8Array. Preserve byte identity as base64.
      if (v instanceof Uint8Array) {
        return {
          __type: "Uint8Array",
          base64: Buffer.from(v).toString("base64"),
          byteLength: v.byteLength,
        };
      }

      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }

      return v;
    },
    2,
  );
}

export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (value === undefined) return "undefined";
  try {
    const s = JSON.stringify(value);
    return s ?? String(value);
  } catch {
    return String(value);
  }
}
