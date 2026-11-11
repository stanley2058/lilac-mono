import { createHash } from "node:crypto";
import { z } from "zod";

const uuidSchema = z.uuid();

/** Derives a stable UUIDv8 from an unambiguous, namespaced producer identity. */
export function deriveRequestDeliveryId(namespace: string, ...identity: readonly string[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([namespace, ...identity]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Preserves existing UUIDs while mapping a legacy stored key to its wire identity. */
export function normalizeRequestDeliveryId(namespace: string, storedKey: string): string {
  if (uuidSchema.safeParse(storedKey).success) return storedKey;
  return deriveRequestDeliveryId(namespace, storedKey);
}
