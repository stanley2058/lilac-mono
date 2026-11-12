import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startE2E, type E2E } from "./harness";

let e2e: E2E;
beforeAll(async () => {
  e2e = await startE2E();
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
}, 60_000);

test("the agent reads, edits and runs commands in the workspace through a web client", async () => {
  await writeFile(path.join(e2e.layout.workspace, "notes.txt"), "alpha\nkeep\n");
  const tag = e2e.model.script("workspace-edit", (request, model) => {
    switch (model.step) {
      case 0:
        expect(request.tools).toEqual(expect.arrayContaining(["bash", "read", "edit"]));
        return { toolCalls: [{ name: "read", args: { path: "notes.txt", format: "hashline" } }] };
      case 1: {
        // A model copies the anchor from the read output, so the two tools must agree on it.
        const anchor = /(\d+#[0-9a-f]+):alpha/u.exec(model.result("read"))?.[1];
        if (!anchor) throw new Error(`No hashline anchor in ${model.result("read")}`);
        return {
          toolCalls: [
            {
              name: "edit",
              args: { path: "notes.txt", edits: [{ op: "replace", pos: anchor, lines: ["beta"] }] },
            },
          ],
        };
      }
      case 2:
        return {
          toolCalls: [{ name: "bash", args: { command: "cat notes.txt && tools --list" } }],
        };
      default:
        const bash = model.json<{ stdout: string; exitCode: number }>("bash");
        expect(bash.exitCode).toBe(0);
        expect(bash.stdout).toContain("surface.messages.send");
        return { text: `Workspace now reads: ${bash.stdout.split("\n")[0]}` };
    }
  });
  const session = await e2e.session({ style: "web" });
  const threadId = await session.createThread("Workspace edit");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} Change alpha to beta and show me the tools.`);
  const [turn] = await session.settled(store, 1);

  expect(await readFile(path.join(e2e.layout.workspace, "notes.txt"), "utf8")).toBe("beta\nkeep\n");
  const requests = e2e.model.forScenario("workspace-edit");
  expect(requests).toHaveLength(4);
  const bashOutput = requests.at(-1)!.request.messages.at(-1);
  expect(bashOutput).toMatchObject({ role: "tool" });
  expect(JSON.stringify(bashOutput)).toContain("beta");
  expect(JSON.stringify(bashOutput)).toContain("surface.messages.send");

  expect(turn!.state).toBe("complete");
  expect(turn!.user).toContain("Change alpha to beta");
  expect(turn!.assistant).toContain("Workspace now reads: beta");
  expect(turn!.activities.filter((activity) => activity.kind === "tool")).toEqual([
    expect.objectContaining({ state: "complete" }),
    expect.objectContaining({ state: "complete" }),
    expect.objectContaining({ state: "complete" }),
  ]);
}, 60_000);
