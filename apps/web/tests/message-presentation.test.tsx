import { reactionTooltip } from "../src/components/MessageReactions";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentPreviewBody } from "../src/components/ResourcePreview";
import { CodeBlock } from "../src/components/CodeBlock";
import {
  faviconUrl,
  previewUrl,
  LinkPreviewBody,
  LinkWithFavicon,
} from "../src/components/LinkWithFavicon";
import { initials } from "../src/components/ActorAvatar";
import { MessageResourcesContext, type MessageResource } from "../src/components/message-resources";
import MarkdownContent from "../src/components/MarkdownContent";

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

  test("avatar fallback initials use participant and agent names", () => {
    expect(initials("Stanley Wang")).toBe("SW");
    expect(initials("Lilac (Discord)")).toBe("L");
    expect(initials("Stanley Wang (Discord)")).toBe("SW");
    expect(initials("Stanley (GitHub)")).toBe("S");
    expect(initials("  ")).toBe("?");
    expect(initials("🦊 Fox")).toBe("🦊F");
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
