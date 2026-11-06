import { nativeSessionId } from "../../../src/surface/native/native-protocol";
import { resolveRestrictedSessionTmpDir } from "../../../src/shared/attachment-utils";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, open, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { join, relative as relativePath } from "node:path";
import { tmpdir, homedir } from "node:os";
import { FileSystem } from "@stanley2058/lilac-fs";
import type { Result } from "better-result";
import { NativeStore } from "../../../src/surface/native/store";
import {
  NativeLiveFileService,
  rewriteNativePublishedFileLinks,
} from "../../../src/surface/native/resources-live";
function value<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw error;
    },
  });
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("published paths read latest bytes, reject unpublished IDs, and honor filesystem deny paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-files-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "Owner",
    }),
  );
  value(
    native.upsertUser({
      id: "outsider",
      providerId: "outsider",
      role: "participant",
      toolMode: "full",
      displayName: "Other",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "thread" }));
  const file = join(root, "notes.txt");
  await writeFile(file, "before");
  const reference = value(native.registerPublishedPath("owner", thread.id, file, root));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root, { denyPaths: [join(root, "private.txt")] }),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  expect(new TextDecoder().decode(value(await service.read("owner", reference.id)).bytes)).toBe(
    "before",
  );
  await writeFile(file, "after");
  expect(new TextDecoder().decode(value(await service.read("owner", reference.id)).bytes)).toBe(
    "after",
  );
  expect((await service.read("outsider", reference.id)).status).toBe("error");
  expect((await service.read("owner", file)).status).toBe("error");
  await writeFile(join(root, "private.txt"), "private");
  const denied = value(
    native.registerPublishedPath("owner", thread.id, join(root, "private.txt"), root),
  );
  expect((await service.read("owner", denied.id)).status).toBe("error");
  await rm(file);
  expect((await service.read("owner", reference.id)).status).toBe("error");
  native.close();
});

test("assistant file links publish stable authorized live previews without rewriting web URLs or code", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-links-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "Owner",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "thread" }));
  const path = join(root, "notes.txt");
  await writeFile(path, "latest");
  const original = `[Notes](${path}) [Site](https://example.com) \`[Code](/not-a-file)\``;
  const rewrite = () =>
    value(
      rewriteNativePublishedFileLinks({
        text: original,
        threadId: thread.id,
        actorId: "owner",
        cwd: root,
        register: (...args) => native.registerPublishedPath(...args),
      }),
    );
  const rewritten = rewrite();
  expect(rewrite()).toBe(rewritten);
  expect(rewritten).toContain("[Site](https://example.com)");
  expect(rewritten).toContain("`[Code](/not-a-file)`");
  const fileUrl = /\[Notes\]\(([^)]+)\)/u.exec(rewritten)?.[1];
  expect(fileUrl).toStartWith("/api/files/");
  const live = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const response = await live.handle(new Request(`http://local${fileUrl}`), "owner");
  expect(await response?.text()).toBe("latest");
  expect(response?.headers.get("content-disposition")).toStartWith("inline;");
  native.close();
});

test("text preview reads only a bounded prefix of a published file above the download limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-large-preview-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "Owner",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "large" }));
  const path = join(root, "large.txt");
  await using file = await open(path, "w");
  await file.write(Buffer.alloc(65_536, 97));
  await file.truncate(1_073_741_824);
  const reference = value(native.registerPublishedPath("owner", thread.id, path, root));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const response = await service.handle(
    new Request(`http://native/api/files/${reference.id}/preview`),
    "owner",
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    text: "a".repeat(65_536),
    byteLength: 1_073_741_824,
    truncated: true,
  });
  expect(
    (await service.handle(new Request(`http://native/api/files/${reference.id}`), "owner"))?.status,
  ).toBe(404);
  await file.write(Buffer.from([0]), 0, 1, 0);
  expect(
    (await service.handle(new Request(`http://native/api/files/${reference.id}/preview`), "owner"))
      ?.status,
  ).toBe(422);
  await rm(path);
  expect(
    (await service.handle(new Request(`http://native/api/files/${reference.id}/preview`), "owner"))
      ?.status,
  ).toBe(404);
  native.close();
});

test("inline path resolution expands paths and enforces thread and filesystem permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-native-resolver-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  for (const id of ["owner", "reader", "outsider", "restricted"])
    value(
      native.upsertUser({
        id,
        providerId: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: id === "restricted" ? "restricted" : "full",
        displayName: id,
      }),
    );
  const thread = value(native.createThread("owner", { commandId: "resolve" }));
  value(native.shareThread("owner", { threadId: thread.id, userId: "reader", grant: "read" }));
  value(native.shareThread("owner", { threadId: thread.id, userId: "restricted", grant: "edit" }));
  await writeFile(join(root, "example.md"), "# Example");
  await writeFile(join(root, "private.txt"), "denied");
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root, { denyPaths: [join(root, "private.txt")] }),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const relative = value(await service.resolve("owner", thread.id, "./example.md"));
  expect(relative.path).toBe(join(root, "example.md"));
  expect(relative.name).toBe("example.md");
  expect(relative.href).toStartWith("/api/files/");
  expect(value(await service.resolve("owner", thread.id, relative.path))).toEqual(relative);
  const response = await service.handle(
    new Request(`http://native${relative.href}/preview`),
    "reader",
  );
  expect(await response?.json()).toMatchObject({ text: "# Example", truncated: false });
  for (const actor of ["reader", "outsider", "restricted"])
    expect((await service.resolve(actor, thread.id, relative.path)).status).toBe("error");
  for (const path of ["./missing.md", "./private.txt"])
    expect((await service.resolve("owner", thread.id, path)).status).toBe("error");
  const homeRelative = `~/${relativePath(homedir(), join(root, "example.md"))}`;
  expect(value(await service.resolve("owner", thread.id, homeRelative))).toEqual(relative);
  native.close();
});

test("restricted file resolution uses the thread's virtual tmp directory exactly once", async () => {
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "limited",
      providerId: "limited",
      role: "participant",
      toolMode: "restricted",
      displayName: "Limited",
    }),
  );
  const thread = value(native.createThread("limited", { commandId: "restricted-resolve" }));
  const root = resolveRestrictedSessionTmpDir(nativeSessionId(thread.id));
  directories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "example.txt"), "session file");
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const file = value(await service.resolve("limited", thread.id, "./example.txt"));
  expect(file.path).toBe("/tmp/example.txt");
  const response = await service.handle(new Request(`http://native${file.href}`), "limited");
  expect(await response?.text()).toBe("session file");
  for (const path of ["~/.bashrc", "/etc/passwd", "../example.txt", "/tmp/../etc/passwd"])
    expect((await service.resolve("limited", thread.id, path)).status).toBe("error");
  native.close();
});

test("workspace editing reads whole UTF-8 files, checks revisions, and preserves access boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-editor-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  for (const id of ["owner", "outsider"])
    value(
      native.upsertUser({
        id,
        providerId: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
        displayName: id,
      }),
    );
  const thread = value(native.createThread("owner", { commandId: "editor-test", title: "Editor" }));
  const file = join(root, "config.yaml");
  const secret = join(root, "secret.txt");
  const initial = "# long file\n".repeat(7000);
  await writeFile(file, initial);
  await writeFile(secret, "secret");
  await writeFile(join(root, "binary.bin"), new Uint8Array([0, 255]));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root, { denyPaths: [secret] }),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const tree = value(await service.tree("owner", thread.id));
  expect(tree.paths).toContain("config.yaml");
  expect(tree.paths).not.toContain("secret.txt");
  const doc = value(await service.document("owner", thread.id, "config.yaml"));
  expect(doc.text).toBe(initial);
  const saved = value(
    await service.saveDocument("owner", {
      threadId: thread.id,
      path: file,
      expectedRevision: doc.revision,
      text: "enabled: true\n",
    }),
  );
  expect(saved.revision).not.toBe(doc.revision);
  expect(value(await service.document("owner", thread.id, file)).text).toBe("enabled: true\n");
  await writeFile(file, "agent: changed\n");
  expect(
    (
      await service.saveDocument("owner", {
        threadId: thread.id,
        path: file,
        expectedRevision: saved.revision,
        text: "stale\n",
      })
    ).isErr(),
  ).toBe(true);
  expect(value(await service.document("owner", thread.id, file)).text).toBe("agent: changed\n");
  expect((await service.document("outsider", thread.id, file)).isErr()).toBe(true);
  expect((await service.tree("outsider", thread.id)).isErr()).toBe(true);
  expect(
    (
      await service.saveDocument("outsider", {
        threadId: thread.id,
        path: file,
        expectedRevision: saved.revision,
        text: "no",
      })
    ).isErr(),
  ).toBe(true);
  expect((await service.document("owner", thread.id, secret)).isErr()).toBe(true);
  expect((await service.document("owner", thread.id, "binary.bin")).isErr()).toBe(true);
  await rm(file);
  expect(
    (
      await service.saveDocument("owner", {
        threadId: thread.id,
        path: file,
        expectedRevision: saved.revision,
        text: "no recreation",
      })
    ).isErr(),
  ).toBe(true);
});

test("competing saves against one revision let only the first write land", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-editor-race-"));
  directories.push(root);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "owner",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "editor-race" }));
  const file = join(root, "notes.txt");
  await writeFile(file, "start\n");
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const { revision } = value(await service.document("owner", thread.id, file));
  const results = await Promise.all(
    ["first\n", "second\n"].map((text) =>
      service.saveDocument("owner", {
        threadId: thread.id,
        path: file,
        expectedRevision: revision,
        text,
      }),
    ),
  );
  expect(results.map((result) => result.isOk())).toEqual([true, false]);
  expect(await readFile(file, "utf8")).toBe("first\n");
  native.close();
});

test("restricted editing rejects symlinks that leave the session directory", async () => {
  const outside = await mkdtemp(join(tmpdir(), "lilac-editor-outside-"));
  directories.push(outside);
  const target = join(outside, "target.txt");
  await writeFile(target, "outside");
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "limited",
      providerId: "limited",
      role: "participant",
      toolMode: "restricted",
      displayName: "Limited",
    }),
  );
  const thread = value(native.createThread("limited", { commandId: "restricted-editor" }));
  const root = resolveRestrictedSessionTmpDir(nativeSessionId(thread.id));
  directories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "inside.txt"), "inside");
  await symlink(target, join(root, "link.txt"));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  expect(value(await service.document("limited", thread.id, "/tmp/inside.txt")).text).toBe(
    "inside",
  );
  expect((await service.document("limited", thread.id, "/tmp/link.txt")).isErr()).toBe(true);
  expect(
    (
      await service.saveDocument("limited", {
        threadId: thread.id,
        path: "/tmp/link.txt",
        expectedRevision: "any",
        text: "overwritten",
      })
    ).isErr(),
  ).toBe(true);
  expect(await readFile(target, "utf8")).toBe("outside");
  native.close();
});

test("editing keeps deny paths for symlinks inside denied directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "lilac-editor-deny-"));
  const outside = await mkdtemp(join(tmpdir(), "lilac-editor-deny-target-"));
  directories.push(root, outside);
  const target = join(outside, "target.txt");
  await writeFile(target, "outside");
  await mkdir(join(root, "private"));
  const link = join(root, "private", "link.txt");
  await symlink(target, link);
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  value(
    native.upsertUser({
      id: "owner",
      providerId: "owner",
      role: "owner",
      toolMode: "full",
      displayName: "owner",
    }),
  );
  const thread = value(native.createThread("owner", { commandId: "editor-deny" }));
  const service = new NativeLiveFileService({
    native,
    filesystem: new FileSystem(root, { denyPaths: [join(root, "private")] }),
    toolRoot: root,
    remoteDenyPaths: [],
  });
  const { revision } = value(await service.document("owner", thread.id, target));
  expect((await service.document("owner", thread.id, link)).isErr()).toBe(true);
  expect(
    (
      await service.saveDocument("owner", {
        threadId: thread.id,
        path: link,
        expectedRevision: revision,
        text: "overwritten",
      })
    ).isErr(),
  ).toBe(true);
  expect(await readFile(target, "utf8")).toBe("outside");
  native.close();
});
