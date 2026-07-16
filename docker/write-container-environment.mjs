import { mkdirSync, renameSync, writeFileSync } from "node:fs";

const quote = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const protectedKeys = new Set([
  "HOME",
  "PATH",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "LILAC_UID",
  "LILAC_USER",
]);
const maxBytes = 1024 * 1024;
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const containsControlCharacter = (value) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });

const lines = [];
for (const [key, value] of Object.entries(process.env).sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  if (!keyPattern.test(key)) throw new Error(`Invalid container environment key: ${key}`);
  if (protectedKeys.has(key)) continue;
  if (containsControlCharacter(value)) {
    throw new Error(`Container environment value contains a control character: ${key}`);
  }
  lines.push(`${key}=${quote(value)}`);
}

const contents = `${lines.join("\n")}\n`;
if (Buffer.byteLength(contents) > maxBytes) {
  throw new Error(`Container environment exceeds ${maxBytes} bytes`);
}

mkdirSync("/run/lilac", { recursive: true, mode: 0o755 });
const temporaryPath = `/run/lilac/container.env.${process.pid}`;
writeFileSync(temporaryPath, contents, { mode: 0o600 });
renameSync(temporaryPath, "/run/lilac/container.env");
