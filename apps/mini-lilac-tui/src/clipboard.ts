import { execFile, spawn } from "node:child_process";
import { open, rm } from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 3_000;
const FORCE_KILL_DELAY_MS = 100;
export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

export class ClipboardImageTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Clipboard image exceeds ${maxBytes} bytes`);
    this.name = "ClipboardImageTooLargeError";
  }
}

export interface ClipboardImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png";
}

function command(
  name: string,
  args: readonly string[],
  options: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const maxBytes = options.maxBytes ?? MAX_CLIPBOARD_IMAGE_BYTES;
    const child = spawn(name, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;
    let childExited = false;
    let terminationError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | undefined, bytes?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (error) reject(error);
      else resolve(bytes ?? new Uint8Array());
    };
    const terminate = (error: Error) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      child.stdout.pause();
      if (childExited) {
        child.stdout.destroy();
        finish(error);
        return;
      }
      child.kill();
      forceKill = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
    };
    const timeout = setTimeout(() => {
      terminate(new Error(`${name} timed out`));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.on("error", (error: Error) => {
      finish(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminationError !== undefined) return;
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        chunks.length = 0;
        terminate(new ClipboardImageTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    child.on("exit", () => {
      childExited = true;
      if (terminationError !== undefined) {
        child.stdout.destroy();
        finish(terminationError);
      }
    });
    child.on("close", (code) => {
      if (terminationError) {
        finish(terminationError);
      } else if (code === 0) {
        finish(undefined, Buffer.concat(chunks, bytesRead));
      } else {
        finish(new Error(`${name} exited with code ${code}`));
      }
    });
  });
}

async function readBoundedFile(file: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    if ((await handle.stat()).size > maxBytes) throw new ClipboardImageTooLargeError(maxBytes);
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let totalBytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) throw new ClipboardImageTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}

function ignoreUnavailableClipboard(error: unknown): undefined {
  if (error instanceof ClipboardImageTooLargeError) throw error;
  return undefined;
}

/** Read an image clipboard using native platform tools, without reading clipboard text. */
export async function readClipboardImage(): Promise<ClipboardImage | undefined> {
  if (platform() === "darwin") {
    const file = join(tmpdir(), `mini-lilac-clipboard-${process.pid}-${crypto.randomUUID()}.png`);
    try {
      await exec(
        "osascript",
        [
          "-e",
          'set imageData to the clipboard as "PNGf"',
          "-e",
          `set fileRef to open for access POSIX file "${file}" with write permission`,
          "-e",
          "set eof fileRef to 0",
          "-e",
          "write imageData to fileRef",
          "-e",
          "close access fileRef",
        ],
        { timeout: 3_000 },
      );
      const bytes = await readBoundedFile(file, MAX_CLIPBOARD_IMAGE_BYTES);
      return bytes.length > 0 ? { bytes, mediaType: "image/png" } : undefined;
    } catch (error) {
      return ignoreUnavailableClipboard(error);
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $stdout = [Console]::OpenStandardOutput(); $img.Save($stdout, [System.Drawing.Imaging.ImageFormat]::Png); $stdout.Flush() }";
    const bytes = await command("powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      script,
    ]).catch(ignoreUnavailableClipboard);
    if (bytes === undefined || bytes.length === 0) return undefined;
    return { bytes, mediaType: "image/png" };
  }

  if (platform() === "linux") {
    const wayland = await command("wl-paste", ["-t", "image/png"]).catch(
      ignoreUnavailableClipboard,
    );
    if (wayland !== undefined && wayland.length > 0) {
      return { bytes: wayland, mediaType: "image/png" };
    }
    const x11 = await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(
      ignoreUnavailableClipboard,
    );
    if (x11 !== undefined && x11.length > 0) return { bytes: x11, mediaType: "image/png" };
  }

  return undefined;
}

export const __clipboardInternals = { command, readBoundedFile };
