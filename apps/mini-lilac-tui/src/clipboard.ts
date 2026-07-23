import { execFile, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ClipboardImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png";
}

function command(name: string, args: readonly string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(name, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${name} timed out`));
    }, 3_000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${name} exited with code ${code}`));
    });
  });
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
      const bytes = await readFile(file);
      return bytes.length > 0 ? { bytes, mediaType: "image/png" } : undefined;
    } catch {
      return undefined;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Write([System.Convert]::ToBase64String($ms.ToArray())) }";
    const encoded = await command("powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      script,
    ]).catch(() => undefined);
    if (encoded === undefined || encoded.length === 0) return undefined;
    return {
      bytes: Buffer.from(Buffer.from(encoded).toString().trim(), "base64"),
      mediaType: "image/png",
    };
  }

  if (platform() === "linux") {
    const wayland = await command("wl-paste", ["-t", "image/png"]).catch(() => undefined);
    if (wayland !== undefined && wayland.length > 0) {
      return { bytes: wayland, mediaType: "image/png" };
    }
    const x11 = await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(
      () => undefined,
    );
    if (x11 !== undefined && x11.length > 0) return { bytes: x11, mediaType: "image/png" };
  }

  return undefined;
}
