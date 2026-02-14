import fssync from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { applyHunks, parsePatch } from "../../tools/apply-patch/apply-patch-core";
import { FileSystem, type FileEdit, type EditFileResult } from "../../tools/fs/fs-impl";

function ok(value: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

function fail(error: unknown): void {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}

function expandTilde(inputPath: string): string {
  if (inputPath !== "~" && !inputPath.startsWith("~/")) return inputPath;
  const home = process.env.HOME ?? "";
  if (inputPath === "~") return home;
  return path.join(home, inputPath.slice(2));
}

function resolveInputPath(inputPath: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(process.cwd(), expanded);
}

function isDeniedPath(resolvedPath: string, denyAbs: readonly string[]): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const deny of denyAbs) {
    if (normalized === deny) return true;
    if (normalized.startsWith(`${deny}${path.sep}`)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Number(value);
}

function normalizeEditOutput(result: EditFileResult): EditFileResult {
  if (result.success) {
    return {
      success: true,
      resolvedPath: result.resolvedPath,
      oldHash: result.oldHash,
      newHash: result.newHash,
      changesMade: result.changesMade,
      replacementsMade: result.replacementsMade,
    };
  }

  return {
    success: false,
    resolvedPath: result.resolvedPath,
    currentHash: result.currentHash,
    error: result.error,
  };
}

async function opReadText(input: Record<string, unknown>, fsTool: FileSystem): Promise<unknown> {
  const readRes = await fsTool.readFile({
    path: String(input["path"] ?? ""),
    startLine: numberOrUndefined(input["startLine"]),
    maxLines: numberOrUndefined(input["maxLines"]),
    maxCharacters: numberOrUndefined(input["maxCharacters"]),
    format: input["format"] === "numbered" ? "numbered" : "raw",
  });
  return readRes;
}

async function opReadBytes(
  input: Record<string, unknown>,
  denyAbs: readonly string[],
): Promise<unknown> {
  const resolvedPath = resolveInputPath(String(input["path"] ?? ""));
  if (isDeniedPath(resolvedPath, denyAbs)) {
    return {
      ok: false,
      resolvedPath,
      error: `Access denied: '${resolvedPath}' is blocked for readFile`,
    };
  }

  const maxBytes = numberOrUndefined(input["maxBytes"]) ?? 10_000_000;
  try {
    const stats = await fs.stat(resolvedPath);
    if (stats.size > maxBytes) {
      return {
        ok: false,
        resolvedPath,
        error: `Remote file too large (${stats.size} bytes). Max allowed is ${maxBytes}.`,
      };
    }

    const bytes = await fs.readFile(resolvedPath);
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      ok: true,
      resolvedPath,
      fileHash,
      bytesLength: bytes.byteLength,
      base64: Buffer.from(bytes).toString("base64"),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, resolvedPath, error: msg };
  }
}

async function opGlob(input: Record<string, unknown>, fsTool: FileSystem): Promise<unknown> {
  const patterns = Array.isArray(input["patterns"]) ? input["patterns"].map((p) => String(p)) : [];
  const maxEntries = numberOrUndefined(input["maxEntries"]);
  const mode = input["mode"] === "detailed" ? "detailed" : "default";
  return await fsTool.glob({
    patterns,
    maxEntries,
    mode,
  });
}

async function opGrep(input: Record<string, unknown>, fsTool: FileSystem): Promise<unknown> {
  const fileExtensions = Array.isArray(input["fileExtensions"])
    ? input["fileExtensions"].map((e) => String(e).replace(/^\./, ""))
    : [];
  const mode = input["mode"] === "detailed" ? "detailed" : "default";

  return await fsTool.grep({
    pattern: String(input["pattern"] ?? ""),
    regex: Boolean(input["regex"]),
    maxResults: numberOrUndefined(input["maxResults"]),
    fileExtensions,
    includeContextLines: numberOrUndefined(input["includeContextLines"]),
    mode,
  });
}

async function opEdit(
  input: Record<string, unknown>,
  fsTool: FileSystem,
  denyAbs: readonly string[],
): Promise<unknown> {
  const pathInput = String(input["path"] ?? "");
  const resolvedPath = resolveInputPath(pathInput);
  if (isDeniedPath(resolvedPath, denyAbs)) {
    return {
      success: false,
      resolvedPath,
      error: {
        code: "PERMISSION",
        message: `Access denied: '${resolvedPath}' is blocked for editFile`,
      },
    };
  }

  const edits = Array.isArray(input["edits"]) ? (input["edits"] as FileEdit[]) : [];
  const expectedHashRaw = input["expectedHash"];
  const expectedHash =
    typeof expectedHashRaw === "string" && expectedHashRaw.length > 0 ? expectedHashRaw : undefined;

  if (expectedHash) {
    const editRes = await fsTool.editFile({ path: pathInput, edits, expectedHash });
    return normalizeEditOutput(editRes);
  }

  const readRes = await fsTool.readFile({
    path: pathInput,
    startLine: 1,
    maxLines: 1,
    maxCharacters: 1,
    format: "raw",
  });
  if (!readRes.success) {
    return readRes;
  }

  const editRes = await fsTool.editFile({
    path: pathInput,
    edits,
    expectedHash: readRes.fileHash,
  });
  return normalizeEditOutput(editRes);
}

async function opApplyPatch(
  input: Record<string, unknown>,
  denyPaths: readonly string[],
): Promise<unknown> {
  const patchText = String(input["patchText"] ?? "");
  const hunks = parsePatch(patchText);
  return await applyHunks(process.cwd(), hunks, { denyPaths });
}

function readJsonFromStdin(): unknown {
  const raw = fssync.readFileSync(0, "utf8");
  if (!raw || raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  try {
    const parsedRaw = readJsonFromStdin();
    const parsed = isRecord(parsedRaw) ? parsedRaw : {};
    const input = isRecord(parsed["input"]) ? parsed["input"] : {};
    const op = String(parsed["op"] ?? "");
    const denyPaths = Array.isArray(parsed["denyPaths"])
      ? parsed["denyPaths"].map((p) => String(p))
      : [];
    const denyAbs = denyPaths.map((p) => path.resolve(expandTilde(p)));

    const fsTool = new FileSystem(process.cwd(), { denyPaths });

    if (op === "fs.read_text") {
      ok(await opReadText(input, fsTool));
      return;
    }
    if (op === "fs.read_bytes") {
      ok(await opReadBytes(input, denyAbs));
      return;
    }
    if (op === "fs.glob") {
      ok(await opGlob(input, fsTool));
      return;
    }
    if (op === "fs.grep") {
      ok(await opGrep(input, fsTool));
      return;
    }
    if (op === "fs.edit") {
      ok(await opEdit(input, fsTool, denyAbs));
      return;
    }
    if (op === "apply_patch") {
      ok(await opApplyPatch(input, denyPaths));
      return;
    }

    fail(`Unknown op: ${op}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

main();
