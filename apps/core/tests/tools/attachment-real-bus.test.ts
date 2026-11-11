import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import {
  lilacEventTypes,
  outReqTopic,
  type EvtAgentOutputResponseBinaryData,
} from "@stanley2058/lilac-event-bus";
import { attachmentTools } from "../../src/tools/attachment";
import {
  AttachmentOutputLifecycleError,
  type AttachmentOutputLifecycle,
} from "../../src/tools/attachment-output-lifecycle";
import { Attachment } from "../../src/tool-server/tools/attachment";
import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("attachment tools through the production Redis bus", () => {
  for (const level of ["level1", "level2"] as const) {
    it(`${level} registers a durable blob and delivers a readable binary output handle`, async () => {
      const fixture = await createRealCoreBusFixture();
      cleanups.push(() => fixture.close());
      const requestDeliveryId = crypto.randomUUID();
      const context = {
        requestId: `attachment:${level}`,
        requestDeliveryId,
        sessionId: "attachment-session",
        requestClient: "discord" as const,
        cwd: fixture.directory,
      };
      const text = "Attachment bytes survive a real Redis round trip.\n";
      const filename = join(fixture.directory, "report.txt");
      await writeFile(filename, text);
      const outputLifecycle: AttachmentOutputLifecycle = {
        registerOutputHandle(input) {
          return fixture.coordinator
            .registerOutputHandle({
              requestDeliveryId: input.requestDeliveryId!,
              handle: input.handle,
              metadata: { mimeType: input.mimeType, filename: input.filename },
            })
            .map(() => undefined)
            .mapError((error) => new AttachmentOutputLifecycleError({ message: error.message }));
        },
      };
      const received = Promise.withResolvers<EvtAgentOutputResponseBinaryData>();
      const subscription = requireBusOk(
        await fixture.bus.subscribeTopic(
          outReqTopic(context.requestId),
          { mode: "tail", offset: { type: "begin" } },
          async (message) => {
            expect(message.headers).toMatchObject({
              request_id: context.requestId,
              session_id: context.sessionId,
              request_client: "discord",
            });
            if (message.type === lilacEventTypes.EvtAgentOutputResponseBinary)
              received.resolve(message.data);
            return Result.ok(undefined);
          },
          () => "commit",
        ),
      );
      try {
        requireBusOk(
          await fixture.bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: "Make an attachment" }],
            },
            {
              headers: {
                request_id: context.requestId,
                session_id: context.sessionId,
                request_client: "discord",
              },
            },
          ),
        );
        expect(
          requireBusOk(await fixture.coordinator.handleDelivery(requestDeliveryId)).disposition,
        ).toBe("accepted");
        if (level === "level1") {
          const tool = attachmentTools({
            bus: fixture.bus,
            blobStore: fixture.blobs,
            outputLifecycle,
            cwd: fixture.directory,
          })["attachment.add_files"];
          const result = await tool.execute!(
            { paths: [filename], filenames: ["shared.txt"], mimeTypes: ["text/plain"] },
            {
              toolCallId: "attachment",
              messages: [],
              context,
            },
          );
          expect(result).toMatchObject({
            ok: true,
            attachments: [{ filename: "shared.txt", bytes: Buffer.byteLength(text) }],
          });
        } else {
          const tool = new Attachment({
            bus: fixture.bus,
            blobStore: fixture.blobs,
            outputLifecycle,
          });
          const result = requireBusOk(
            await tool.call(
              "attachment.add_files",
              {
                paths: [filename],
                filenames: ["shared.txt"],
                mimeTypes: ["text/plain"],
              },
              { context },
            ),
          );
          expect(result).toMatchObject({
            ok: true,
            attachments: [{ filename: "shared.txt", bytes: Buffer.byteLength(text) }],
          });
        }
        const output = await withBusDeadline(received.promise, `${level} attachment output`);
        expect(output).toMatchObject({
          filename: "shared.txt",
          mimeType: "text/plain",
          blob: { version: 1 },
        });
        expect(requireBusOk(fixture.store.listOutputsForRequest(context.requestId))).toMatchObject([
          { requestDeliveryId, target: { kind: "handle", blob: output.blob } },
        ]);
        const reference = requireBusOk(
          await fixture.blobs.resolve(output.blob, { timeoutMs: 5_000 }),
        );
        const opened = requireBusOk(await fixture.blobs.open(reference));
        expect(await new Response(opened.stream).text()).toBe(text);
        requireBusOk(await opened.completion);
      } finally {
        requireBusOk(await subscription.stop());
        await fixture.close();
      }
    });
  }
});
