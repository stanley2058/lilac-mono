import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startE2E, type E2E, type ModelProvider, type ModelView } from "./harness";

/** The model's edit step, using whichever edit tool Core offers for this provider. */
function editAlphaToBeta(model: ModelView) {
  if (model.request.tools.includes("patch"))
    return {
      name: "patch",
      args: {
        patchText:
          "*** Begin Patch\n*** Update File: notes.txt\n@@\n-alpha\n+beta\n keep\n*** End Patch",
      },
    };
  // A model copies the anchor from the read output, so the two tools must agree on it.
  const anchor = /(\d+#[0-9a-f]+):alpha/u.exec(model.result("read"))?.[1];
  if (!anchor) throw new Error(`No hashline anchor in ${model.result("read")}`);
  return {
    name: "edit",
    args: { path: "notes.txt", edits: [{ op: "replace", pos: anchor, lines: ["beta"] }] },
  };
}

const providers = ["chat-completions", "responses-sse", "responses-ws"] as const satisfies ModelProvider[];

describe.each(providers)("over %s", (provider) => {
  let e2e: E2E;
  beforeAll(async () => {
    e2e = await startE2E({ provider });
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
          expect(request.tools).toEqual(expect.arrayContaining(["bash", "read"]));
          expect(request.tools.some((tool) => tool === "edit" || tool === "patch")).toBe(true);
          // Hashline anchors exist only alongside the hashline edit tool.
          return {
            toolCalls: [
              {
                name: "read",
                args: {
                  path: "notes.txt",
                  ...(request.tools.includes("edit") ? { format: "hashline" } : {}),
                },
              },
            ],
          };
        case 1:
          expect(model.result("read")).toContain("alpha");
          return { toolCalls: [editAlphaToBeta(model)] };
        case 2:
          return {
            toolCalls: [{ name: "bash", args: { command: "cat notes.txt && tools --list" } }],
          };
        default: {
          const bash = model.json<{ stdout: string; exitCode: number }>("bash");
          expect(bash.exitCode).toBe(0);
          expect(bash.stdout).toContain("surface.messages.send");
          return { text: `Workspace now reads: ${bash.stdout.split("\n")[0]}` };
        }
      }
    });
    const session = await e2e.session({ style: "web" });
    const threadId = await session.createThread("Workspace edit");
    const store = session.watch(threadId);
    await session.send(threadId, `${tag} Change alpha to beta and show me the tools.`);
    const [turn] = await session.settled(store, 1);

    expect(await readFile(path.join(e2e.layout.workspace, "notes.txt"), "utf8")).toBe(
      "beta\nkeep\n",
    );
    const requests = e2e.model.forScenario("workspace-edit");
    expect(requests.map((entry) => entry.request.protocol)).toEqual(requests.map(() => provider));
    expect(requests).toHaveLength(4);
    // The WebSocket adapter continues from the previous response instead of resending history.
    if (provider === "responses-ws")
      expect(
        requests.map(
          (entry) =>
            typeof (entry.request.raw as { previous_response_id?: unknown }).previous_response_id,
        ),
      ).toEqual(["undefined", "string", "string", "string"]);
    expect(turn!.state).toBe("complete");
    expect(turn!.user).toContain("Change alpha to beta");
    expect(turn!.assistant).toContain("Workspace now reads: beta");
    expect(turn!.activities.filter((activity) => activity.kind === "tool")).toEqual([
      expect.objectContaining({ state: "complete" }),
      expect.objectContaining({ state: "complete" }),
      expect.objectContaining({ state: "complete" }),
    ]);
  }, 60_000);

  test("a second prompt carries the first exchange as history", async () => {
    const tag = e2e.model.script("history", (_request, model) => {
      if (model.lastUserText.includes("second")) {
        const earlier = model.request.messages.filter((message) => message.role === "assistant");
        return { text: `I said: ${earlier.map((message) => message.text).join(" | ")}` };
      }
      if (model.step === 0)
        return { toolCalls: [{ name: "bash", args: { command: "echo history-tool" } }] };
      return { text: "First reply." };
    });
    const session = await e2e.session({ style: "bearer" });
    const threadId = await session.createThread("History");
    const store = session.watch(threadId);
    await session.send(threadId, `${tag} first`);
    await session.settled(store, 1);
    await session.send(threadId, `${tag} second`);
    const turns = await session.settled(store, 2);
    expect(turns[1]!.assistant).toContain("I said:");
    expect(turns[1]!.assistant).toContain("First reply.");
    const second = e2e.model.forScenario("history").at(-1)!.request;
    expect(JSON.stringify(second.messages)).toContain("history-tool");
  }, 60_000);
});
