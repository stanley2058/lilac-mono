import { reactionTooltip } from "../src/components/MessageReactions";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentPreviewBody } from "../src/components/ResourcePreview";
import { MarkdownWrapContext } from "../src/components/markdown-layout";
import { CodeBlock } from "../src/components/CodeBlock";
import {
  faviconUrl,
  previewUrl,
  LinkPreviewBody,
  LinkWithFavicon,
} from "../src/components/LinkWithFavicon";
import { initials } from "../src/components/ActorAvatar";
import { Message } from "../src/components/Timeline";
import { MessageIdentityContext } from "../src/components/message-identity";
import { MessageResourcesContext, type MessageResource } from "../src/components/message-resources";
import MarkdownContent from "../src/components/MarkdownContent";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";

describe("message presentation", () => {
  test("reaction tooltips show five names and the remaining count", () => {
    expect(
      reactionTooltip({
        emoji: "👍",
        count: 7,
        reacted: false,
        userNames: ["Alex", "Morgan", "Sam", "Jo", "Casey"],
        overflowCount: 2,
      }),
    ).toBe("Alex, Morgan, Sam, Jo, Casey, +2");
    expect(
      reactionTooltip({
        emoji: "👍",
        count: 1,
        reacted: true,
        userNames: ["Alex"],
        overflowCount: 0,
      }),
    ).toBe("Alex");
  });

  test("linked Discord messages use the viewer alignment and keep the source label", () => {
    const html = renderToStaticMarkup(
      <MessageIdentityContext
        value={{
          viewerId: "viewer",
          agent: { displayName: "Lilac" },
          users: new Map([["viewer", { displayName: "Stanley" }]]),
        }}
      >
        <Message
          message={{
            id: "discord-message",
            role: "user",
            metadata: { authorId: "viewer", authorDisplayName: "Stanley (Discord)" },
            parts: [{ type: "text", text: "Hello" }],
          }}
          resourceUrl={(id) => id}
          canEdit={false}
          onAction={() => {}}
          onReaction={() => {}}
        />
      </MessageIdentityContext>,
    );
    expect(html).toContain('data-slot="message" data-align="end"');
    expect(html).toContain('aria-label="Stanley (Discord)"');
  });
  test("external authors use their display names without a native user lookup", () => {
    for (const name of ["Lilac (Discord)", "Stanley (Discord)"]) {
      const html = renderToStaticMarkup(
        <Message
          message={{
            id: "external",
            role: "user",
            metadata: { authorId: "external-user", authorDisplayName: name },
            parts: [{ type: "text", text: "Hello" }],
          }}
          resourceUrl={(id) => id}
          canEdit={false}
          onAction={() => {}}
          onReaction={() => {}}
        />,
      );
      expect(html).toContain(`aria-label="${name}"`);
      expect(html).not.toContain("Participant");
    }
  });
  test("bubbles use participant and agent names with avatar fallback", () => {
    const html = renderToStaticMarkup(
      <MessageIdentityContext
        value={{
          agent: { displayName: "Lilac" },
          users: new Map([["owner-id", { displayName: "Stanley Wang" }]]),
        }}
      >
        <Message
          message={{
            id: "m1",
            role: "user",
            metadata: { authorId: "owner-id" },
            parts: [{ type: "text", text: "Hello" }],
          }}
          resourceUrl={(id) => `/api/resources/${id}`}
          canEdit
          onAction={() => {}}
          onReaction={() => {}}
        />
      </MessageIdentityContext>,
    );
    expect(html).toContain('data-slot="bubble"');
    expect(html).toContain('aria-label="Stanley Wang"');
    expect(html).not.toContain("owner-id");
    expect(initials("Stanley Wang")).toBe("SW");
    expect(initials("Lilac (Discord)")).toBe("L");
    expect(initials("Stanley Wang (Discord)")).toBe("SW");
    expect(initials("Stanley (GitHub)")).toBe("S");
    expect(initials("  ")).toBe("?");
    expect(initials("🦊 Fox")).toBe("🦊F");
  });
  test("only the viewer is right aligned and text uses the matching message card", () => {
    for (const [role, authorId, self] of [
      ["user", "viewer", true],
      ["user", "other", false],
      ["assistant", "lilac", false],
    ] as const) {
      const message: DisplayMessage = {
        id: "message",
        role,
        metadata: { authorId, createdAt: 1_700_000_000_000 },
        parts: [{ type: "text", text: "Visible content" }],
      };
      const html = renderToStaticMarkup(
        <MessageIdentityContext
          value={{ viewerId: "viewer", agent: { displayName: "Lilac" }, users: new Map() }}
        >
          <Message
            message={message}
            resourceUrl={(id) => `/api/resources/${id}`}
            canEdit
            onAction={() => {}}
            onReaction={() => {}}
          />
        </MessageIdentityContext>,
      );
      expect(html).toContain(`data-slot="message" data-align="${self ? "end" : "start"}"`);
      expect(html).toContain('data-slot="bubble"');
      expect(html).toContain('aria-label="Copy message"');
      const controls = html.slice(html.indexOf('data-ui="message-controls"'));
      const timeIndex = controls.indexOf("<time");
      const copyIndex = controls.indexOf('aria-label="Copy message"');
      expect(self ? timeIndex < copyIndex : copyIndex < timeIndex).toBe(true);
      expect(html.indexOf('data-slot="message-avatar"')).toBeLessThan(
        html.indexOf('data-slot="message-content"'),
      );
    }
  });
  test("user images precede text and files follow it in one bubble", () => {
    const html = renderToStaticMarkup(
      <Message
        message={{
          id: "m2",
          role: "user",
          parts: [
            {
              type: "data-resource",
              id: "r1",
              data: {
                resourceId: "file",
                name: "note.txt",
                mediaType: "text/plain",
                size: 10,
                state: "ready",
              },
            },
            { type: "text", text: "See the attached notes." },
            {
              type: "data-resource",
              id: "r2",
              data: {
                resourceId: "image",
                name: "photo.png",
                mediaType: "image/png",
                size: 100,
                state: "ready",
              },
            },
            {
              type: "data-resource",
              id: "r3",
              data: {
                resourceId: "image2",
                name: "other.png",
                mediaType: "image/png",
                size: 100,
                state: "ready",
              },
            },
          ],
        }}
        resourceUrl={(id) => `/api/resources/${id}`}
        canEdit
        onAction={() => {}}
        onReaction={() => {}}
      />,
    );
    expect(html.match(/data-slot="bubble"/gu)).toHaveLength(1);
    expect(html.indexOf('data-ui="message-image-attachments"')).toBeLessThan(
      html.indexOf("See the attached notes."),
    );
    expect(html.indexOf('aria-label="Preview other.png"')).toBeLessThan(
      html.indexOf("See the attached notes."),
    );
    expect(html.indexOf("See the attached notes.")).toBeLessThan(
      html.indexOf('data-ui="message-attachments"'),
    );
    expect(html.indexOf('data-slot="bubble-content"')).toBeLessThan(
      html.indexOf('data-ui="message-attachments"'),
    );
  });
  test("assistant attachment cards preserve activity and compaction boundaries", () => {
    const resource = (id: string, image: boolean): DisplayPart => ({
      type: "data-resource",
      id,
      data: {
        resourceId: id,
        name: `${id}.${image ? "png" : "txt"}`,
        mediaType: image ? "image/png" : "text/plain",
        size: 10,
        state: "ready",
      },
    });
    const html = renderToStaticMarkup(
      <Message
        message={{
          id: "assistant-mixed",
          role: "assistant",
          parts: [
            resource("file-a", false),
            { type: "text", text: "First segment" },
            resource("image-a", true),
            {
              type: "data-activity",
              id: "tool",
              data: { kind: "tool", label: "Boundary tool", state: "complete" },
            },
            resource("file-b", false),
            resource("image-b", true),
            { type: "text", text: "Second segment" },
            { type: "data-compaction", id: "compaction", data: { state: "complete" } },
            { type: "text", text: "Third segment" },
            resource("file-c", false),
            resource("image-c", true),
          ],
        }}
        resourceUrl={(id) => `/api/resources/${id}`}
        canEdit
        onAction={() => {}}
        onReaction={() => {}}
      />,
    );
    expect(html.match(/data-slot="bubble"/gu)).toHaveLength(3);
    const order = [
      'aria-label="Preview image-a.png"',
      "First segment",
      'aria-label="Preview file-a.txt"',
      "Boundary tool",
      'aria-label="Preview image-b.png"',
      "Second segment",
      'aria-label="Preview file-b.txt"',
      "Context compaction",
      'aria-label="Preview image-c.png"',
      "Third segment",
      'aria-label="Preview file-c.txt"',
    ];
    for (let index = 1; index < order.length; index++) {
      expect(html.indexOf(order[index - 1]!)).toBeGreaterThan(-1);
      expect(html.indexOf(order[index - 1]!)).toBeLessThan(html.indexOf(order[index]!));
    }
  });
  test("only message-associated attachment references become preview chips", () => {
    const resource: MessageResource = {
      resourceId: "known",
      name: "note.txt",
      mediaType: "text/plain",
      size: 10,
      state: "ready",
    };
    const html = renderToStaticMarkup(
      <MessageResourcesContext
        value={new Map([["/api/resources/known", { resource, href: "/api/resources/known" }]])}
      >
        <MarkdownContent text="Review [note.txt](/api/resources/known) and [other.txt](/api/resources/unknown)." />
      </MessageResourcesContext>,
    );
    expect(html).toContain('aria-label="Preview note.txt"');
    expect(html).not.toContain('aria-label="Preview other.txt"');
    expect(html).toContain('href="/api/resources/unknown"');
    expect(html).not.toContain('href="/api/resources/known"');
  });
  test("code retains plain source and accessible copy/wrap controls before highlighting", () => {
    const html = renderToStaticMarkup(<CodeBlock source={'echo "<script>"'} language="bash" />);
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('aria-label="Wrap code"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  test("preview requests preserve page identity but omit fragments and reject credentials", () => {
    expect(previewUrl("https://example.com/article?edition=2#section")).toBe(
      "https://example.com/article?edition=2",
    );
    for (const href of [
      "https://user:secret@example.com",
      "file:///a",
      "mailto:a@example.com",
      "/relative",
      undefined,
    ])
      expect(previewUrl(href)).toBeUndefined();
  });
  test("preview cards escape page text and omit missing images", () => {
    const html = renderToStaticMarkup(
      <LinkPreviewBody
        hostname="example.com"
        preview={{ title: "<script>bad</script>", description: "A short description." }}
      />,
    );
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain("A short description.");
    expect(html).toContain("example.com");
    expect(html).not.toContain("<img");
    const image = renderToStaticMarkup(
      <LinkPreviewBody
        hostname="example.com"
        preview={{ image: "https://example.com/share.png" }}
      />,
    );
    expect(image).toContain('src="/api/remote-image?url=https%3A%2F%2Fexample.com%2Fshare.png"');
    expect(image).toContain('referrerPolicy="no-referrer"');
  });
  test("favicon URLs use only HTTP origins and drop paths, query and credentials", () => {
    expect(faviconUrl("https://user:password@example.com/a?private=1#x")).toBe(
      "https://example.com/favicon.ico",
    );
    for (const href of [
      "mailto:a@example.com",
      "javascript:alert(1)",
      "file:///x",
      "/relative",
      undefined,
    ])
      expect(faviconUrl(href)).toBeUndefined();
  });
  test("GitHub links use the black favicon on light themes and the white one on dark themes", () => {
    const html = renderToStaticMarkup(
      <LinkWithFavicon href="https://github.com/octocat">GitHub</LinkWithFavicon>,
    );
    const themed = [...html.matchAll(/<img [^>]*>/g)].map(([image]) => [
      image.match(/data-favicon-theme="([^"]*)"/)?.[1],
      image.match(/src="([^"]*)"/)?.[1],
    ]);
    expect(themed).toEqual([
      [
        "light",
        "/api/remote-image?url=https%3A%2F%2Fgithub.githubassets.com%2Ffavicons%2Ffavicon.png",
      ],
      [
        "dark",
        "/api/remote-image?url=https%3A%2F%2Fgithub.githubassets.com%2Ffavicons%2Ffavicon-dark.png",
      ],
    ]);
    expect(html).not.toContain("github.com/favicon.ico");
  });
  test("file preview fallback escapes text and both loading states retain truncation and download", async () => {
    // A fresh process keeps the lazy FileCode module cold regardless of test order.
    const child = Bun.spawn([process.execPath, "tests/fixtures/file-preview-render.tsx"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const { cold, warm } = JSON.parse(stdout) as { cold: string; warm: string };
    expect(cold).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
    expect(cold).toContain('data-ui="code-fallback"');
    expect(warm).toContain('aria-label="File contents"');
    expect(warm).not.toContain('data-ui="code-fallback"');
    for (const html of [cold, warm]) {
      expect(html).toContain("Showing the first 64 KB.");
      expect(html).toContain("Download source.ts");
      expect(html).not.toContain("<script>");
    }
  });
  test("file preview exposes binary errors", () => {
    const error = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="file.bin"
        href="/api/resources/id"
        kind="text"
        text={{ status: "error", message: "Text preview is unavailable for this binary file." }}
      />,
    );
    expect(error).toContain('role="status"');
    expect(error).toContain("binary file");
  });
});

test("file preview code stays wrapped while chat code retains its wrap control", () => {
  const wrapped = renderToStaticMarkup(
    <MarkdownWrapContext value={true}>
      <CodeBlock source="const longLine = 'content';" language="typescript" />
    </MarkdownWrapContext>,
  );
  expect(wrapped).toContain('data-wrap="true"');
  expect(wrapped).not.toContain('aria-label="Wrap code"');
  expect(wrapped).toContain('aria-label="Copy code"');
  const chat = renderToStaticMarkup(<CodeBlock source="code" language="text" />);
  expect(chat).toContain('aria-label="Wrap code"');
});
