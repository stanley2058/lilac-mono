import fs from "node:fs/promises";
import path from "node:path";

import { jsonValueSchema, type JsonValue } from "./workflow-domain";
import { canonicalJson, sha256 } from "./workflow-definition";

export const WORKFLOW_INLINE_VALUE_BYTES = 64 * 1024;
const WORKFLOW_ARTIFACT_PREFIX = "workflow-value:";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function artifactHash(artifactId: string): string {
  if (!artifactId.startsWith(WORKFLOW_ARTIFACT_PREFIX)) {
    throw new Error(`Unsupported workflow value artifact: ${artifactId}`);
  }
  const hash = artifactId.slice(WORKFLOW_ARTIFACT_PREFIX.length);
  if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid workflow value artifact: ${artifactId}`);
  return hash;
}

async function artifactRoot(dataDir: string): Promise<string> {
  const root = path.resolve(dataDir, "workflow-artifacts");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workflow artifact root must be a real directory: ${root}`);
  }
  return await fs.realpath(root);
}

export async function writeWorkflowValueArtifact(input: {
  dataDir: string;
  value: JsonValue;
  maxBytes: number;
}): Promise<string> {
  const value = jsonValueSchema.parse(input.value);
  const encoded = canonicalJson(value);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > input.maxBytes) {
    throw new Error(`Workflow value exceeds ${input.maxBytes} bytes`);
  }
  const hash = sha256(encoded);
  const artifactId = `${WORKFLOW_ARTIFACT_PREFIX}${hash}`;
  const root = await artifactRoot(input.dataDir);
  const artifactPath = path.join(root, `${hash}.json`);
  const existing = await fs.lstat(artifactPath).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.size > input.maxBytes) {
      throw new Error(`Invalid workflow value artifact: ${artifactId}`);
    }
    const stored = await fs.readFile(artifactPath, "utf8");
    if (sha256(stored) !== hash)
      throw new Error(`Workflow value artifact hash mismatch: ${artifactId}`);
    return artifactId;
  }

  const temporaryPath = path.join(root, `.${hash}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, artifactPath);
    await fs.chmod(artifactPath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if ((error instanceof Error && "code" in error && error.code === "EEXIST") || existing) {
      return await writeWorkflowValueArtifact(input);
    }
    throw error;
  }
  return artifactId;
}

export async function readWorkflowValueArtifact(input: {
  dataDir: string;
  artifactId: string;
  maxBytes: number;
}): Promise<JsonValue> {
  const hash = artifactHash(input.artifactId);
  const root = await artifactRoot(input.dataDir);
  const artifactPath = path.join(root, `${hash}.json`);
  const stats = await fs.lstat(artifactPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > input.maxBytes) {
    throw new Error(`Invalid workflow value artifact: ${input.artifactId}`);
  }
  const canonical = await fs.realpath(artifactPath);
  if (path.dirname(canonical) !== root) {
    throw new Error(`Workflow value artifact escapes its root: ${input.artifactId}`);
  }
  const encoded = await fs.readFile(canonical, "utf8");
  if (Buffer.byteLength(encoded, "utf8") > input.maxBytes || sha256(encoded) !== hash) {
    throw new Error(`Workflow value artifact hash mismatch: ${input.artifactId}`);
  }
  return jsonValueSchema.parse(JSON.parse(encoded));
}
