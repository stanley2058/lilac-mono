import { RightPanelTabs } from "../src/components/FileViewer";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttachmentPreviewBody,
  ReadyAttachment,
  attachmentKind,
  isMarkdownAttachment,
  isWithinContainedImage,
} from "../src/components/ResourcePreview";

describe("attachment viewer", () => {
  test("PDF filenames remain previewable when upload metadata has no specific media type", () => {
    expect(attachmentKind("", "notes.pdf")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "NOTES.PDF")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "archive.bin")).toBe("text");
    expect(attachmentKind("image/png", "notes.pdf")).toBe("image");
  });
  test("Markdown and MDX have raw/rendered controls without executing MDX", () => {
    for (const name of ["notes.md", "README.MARKDOWN", "demo.mdx"])
      expect(isMarkdownAttachment(name)).toBe(true);
    expect(isMarkdownAttachment("notes.md.txt")).toBe(false);
    const html = renderToStaticMarkup(
      <AttachmentPreviewBody
        name="demo.mdx"
        href="/api/resources/md"
        kind="text"
        text={{
          status: "ready",
          text: "# Heading\n<script>window.secret = 1</script>\n<Component />",
          truncated: true,
        }}
      />,
    );
    expect(html).toContain('aria-label="Preview Markdown"');
    expect(html).toContain('aria-label="Word wrap"');
    expect(html).toContain("Showing the first 64 KB");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<Component");
  });
});

test("image hit testing excludes object-fit letterboxing and respects zoomed bounds", () => {
  const bounds = { left: 10, top: 20, width: 400, height: 400 };
  expect(isWithinContainedImage({ x: 210, y: 30 }, bounds, { width: 800, height: 400 })).toBe(
    false,
  );
  expect(isWithinContainedImage({ x: 210, y: 220 }, bounds, { width: 800, height: 400 })).toBe(
    true,
  );
  expect(isWithinContainedImage({ x: 20, y: 220 }, bounds, { width: 400, height: 800 })).toBe(
    false,
  );
  expect(isWithinContainedImage({ x: 210, y: 220 }, bounds, { width: 400, height: 800 })).toBe(
    true,
  );
  expect(isWithinContainedImage({ x: 210, y: 220 }, bounds, { width: 0, height: 0 })).toBe(false);
  expect(
    isWithinContainedImage(
      { x: 210, y: 220 },
      { left: -100, top: -100, width: 800, height: 800 },
      { width: 800, height: 400 },
    ),
  ).toBe(true);
});

test("saved file tabs defer their bodies until the panel and tab become active", () => {
  const tabs = {
    items: [
      { id: "agents", type: "agents" as const },
      {
        id: "file",
        type: "file" as const,
        target: { type: "path" as const, path: "/a.md", name: "a.md" },
      },
    ],
    activeId: "agents",
  };
  for (const visible of [true, false]) {
    const html = renderToStaticMarkup(
      <RightPanelTabs
        tabs={tabs}
        visible={visible}
        onFocus={() => {}}
        onClose={() => {}}
        onAgents={() => {}}
        renderTab={(tab) => <div>{`body:${tab.id}`}</div>}
      />,
    );
    expect(html.includes("body:agents")).toBe(visible);
    expect(html).not.toContain("body:file");
  }
});

test("unavailable retained images render a placeholder without requesting image bytes", () => {
  const html = renderToStaticMarkup(
    <ReadyAttachment
      data={{
        resourceId: "expired",
        name: "image.png",
        mediaType: "image/png",
        size: 100,
        state: "failed",
        error: "File unavailable",
      }}
      href="/api/resources/expired"
    />,
  );
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("<img");
});
