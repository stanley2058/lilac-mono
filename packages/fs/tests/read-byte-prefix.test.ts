import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSystem } from "../src";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-byte-prefix-"));
  roots.push(root);
  return root;
}

test("prefix reads cap allocations and return original size for files above whole-file limit", async () => {
  const root = await fixture();
  const file = path.join(root, "large.txt");
  await using handle = await open(file, "w");
  await handle.write(Buffer.alloc(65_536, 97));
  await handle.truncate(1_073_741_824);
  const fs = new FileSystem(root);
  const prefix = await fs.readFileBytes({ path: file, prefixBytes: 65_536, maxBytes: 65_536 });
  expect(prefix.success).toBe(true);
  if (!prefix.success) throw new Error(prefix.error.message);
  expect(prefix.bytes.length).toBe(65_536);
  expect(prefix.bytes.toString()).toBe("a".repeat(65_536));
  expect(prefix.bytesLength).toBe(65_536);
  expect(prefix.totalBytes).toBe(1_073_741_824);
  const complete = await fs.readFileBytes({ path: file, maxBytes: 65_536 });
  expect(complete).toMatchObject({ success: false, error: { code: "MEDIA_TOO_LARGE" } });
});

test("prefix reads preserve deny-path checks including symlink targets", async () => {
  const root = await fixture();
  const denied = path.join(root, "private.txt");
  await writeFile(denied, "secret");
  await symlink(denied, path.join(root, "alias.txt"));
  const fs = new FileSystem(root, { denyPaths: [denied] });
  for (const file of [denied, "alias.txt"]) {
    const result = await fs.readFileBytes({ path: file, prefixBytes: 4 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("PERMISSION");
  }
});

test("prefix limits are strict and whole-file results retain their existing shape", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "small.txt"), "hello");
  const fs = new FileSystem(root);
  for (const prefixBytes of [0, 65_537, 1.5, NaN, Infinity])
    expect((await fs.readFileBytes({ path: "small.txt", prefixBytes })).success).toBe(false);
  const short = await fs.readFileBytes({ path: "small.txt", prefixBytes: 10 });
  expect(short).toMatchObject({ success: true, bytesLength: 5, totalBytes: 5 });
  const complete = await fs.readFileBytes({ path: "small.txt" });
  expect(complete).toMatchObject({ success: true, bytesLength: 5 });
  expect(complete).not.toHaveProperty("totalBytes");
});
