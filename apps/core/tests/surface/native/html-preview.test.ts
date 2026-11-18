import { expect, test } from "bun:test";
import { htmlPreviewHref } from "@stanley2058/lilac-client-protocol";
import { MockLanguageModelV4 } from "ai/test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createNativeIntegrationFixture,
  integrationValue,
  nativeFixtureTextResponse,
} from "./integration-fixture";
import type { NativeStore } from "../../../src/surface/native/store";

function waitForStore(store: NativeStore, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = store.subscribeChanges(() => {
      if (!predicate()) return;
      stop();
      resolve();
    });
  });
}

test("a reply's html-preview-file fence serves the page saved when the turn ended", async () => {
  let fixture: Awaited<ReturnType<typeof createNativeIntegrationFixture>> | undefined;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const root = fixture!.workspaceRoot;
      await writeFile(path.join(root, "dot.png"), new Uint8Array([137, 80, 78, 71]));
      await writeFile(
        path.join(root, "chart.html"),
        '<!doctype html><html><head><script src="https://cdn.example.com/chart.js"></script></head><body><img src="./dot.png"><p>Saved page</p></body></html>',
      );
      return nativeFixtureTextResponse(
        "Here is the chart.\n\n```html-preview-file\nchart.html\n```\n\n```html-preview-file\nmissing.html\n```",
      );
    },
  });
  fixture = await createNativeIntegrationFixture({
    model,
    additionalLocalUsers: [
      {
        userId: "participant",
        username: "participant",
        password: "native-participant-password",
        sessionLifetimeSeconds: 60,
      },
    ],
  });
  try {
    const { client } = fixture.connect();
    const viewer = (await client.bootstrap.get({})).viewer;
    const thread = await client.threads.create({ commandId: crypto.randomUUID(), title: "Chart" });
    const receipt = await client.inputs.submit({
      threadId: thread.id,
      text: "Draw a chart",
      mode: "prompt",
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      attachmentIds: [],
      skillIds: [],
    });
    const settled = () => {
      const snapshot = integrationValue(fixture!.store.sync(viewer.id, thread.id));
      return (
        snapshot.kind === "window" &&
        snapshot.slots.some((slot) => slot.kind === "ready" && slot.state === "complete")
      );
    };
    await waitForStore(fixture.store, settled);
    expect(integrationValue(fixture.store.getInput(receipt.inputId)).turnId).toBeDefined();
    // The saved copy no longer depends on the files the agent wrote.
    await rm(path.join(fixture.workspaceRoot, "chart.html"));
    await rm(path.join(fixture.workspaceRoot, "dot.png"));
    const snapshot = await client.threads.sync({ threadId: thread.id });
    if (snapshot.kind !== "window") throw new Error("Expected native window");
    const reply = snapshot.slots
      .flatMap((slot) => (slot.kind === "ready" ? slot.messages : []))
      .find((message) =>
        message.parts.some((part) => part.type === "text" && part.text.includes("chart.html")),
      );
    if (!reply) throw new Error("Missing preview reply");
    const preview = (target: string, token = fixture!.token) =>
      fetch(
        new URL(
          htmlPreviewHref({ threadId: thread.id, messageId: reply.id, path: target }).slice(1),
          fixture!.url,
        ),
        { headers: { authorization: `Bearer ${token}` } },
      );

    const page = await preview("chart.html");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups",
    );
    const html = await page.text();
    expect(html).toContain('<style id="lilac-theme">');
    expect(html).toContain('<script src="https://cdn.example.com/chart.js">');
    // Core saves only the named file; the page's local references stay as written.
    expect(html).toContain('<img src="./dot.png">');
    expect(html).toContain("<p>Saved page</p>");

    const missing = await preview("missing.html");
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain("Preview unavailable: File is missing or unreadable");

    const unknown = await preview("other.html");
    expect(unknown.status).toBe(404);

    const participant = await fixture.loginAs("participant", "native-participant-password");
    expect((await preview("chart.html", participant)).status).not.toBe(200);
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
