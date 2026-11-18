import { describe, expect, test } from "bun:test";
import { HtmlPreviewReply, htmlPreviewPaths, injectHtmlPreviewBootstrap } from "./html-preview";

describe("html preview fences", () => {
  test("finds single-path fences at any depth and ignores other code", () => {
    const text = [
      "```html-preview-file\n/tmp/a.html\n```",
      "- item\n\n  ```html-preview-file\n  ./b.html\n  ```",
      "> ```html-preview-file\n> /tmp/a.html\n> ```",
      "```html\n<p>not a preview</p>\n```",
      "```html-preview-file\n/tmp/one.html\n/tmp/two.html\n```",
      "```html-preview-file\n```",
    ].join("\n\n");
    expect(htmlPreviewPaths([text])).toEqual(["/tmp/a.html", "./b.html"]);
  });

  test("parses each message on its own, as web renders them", () => {
    expect(htmlPreviewPaths(["```ts\nunclosed", "```html-preview-file\n/tmp/c.html\n```"])).toEqual(
      ["/tmp/c.html"],
    );
  });

  test("keeps the messages a reset leaves on screen", () => {
    const reply = new HtmlPreviewReply("a1");
    reply.start("p1", "step-1");
    reply.append("p1", "first");
    reply.start("p2", "step-2");
    reply.append("p2", "retried");
    reply.reset("a2", "step-2");
    reply.start("p3", "step-2");
    reply.append("p3", "second");
    expect(reply.texts()).toEqual(["first", "second"]);
    reply.reset("a3");
    expect(reply.texts()).toEqual(["first"]);
  });

  test("starts a new message when a step reuses a part ID", () => {
    const reply = new HtmlPreviewReply("a1");
    reply.start("text", "step-1");
    reply.append("text", "```ts\nunclosed");
    reply.endStep();
    reply.start("text", "step-2");
    reply.append("text", "```html-preview-file\n/tmp/d.html\n```");
    expect(htmlPreviewPaths(reply.texts())).toEqual(["/tmp/d.html"]);
    reply.reset("a2", "step-2");
    expect(reply.texts()).toEqual(["```ts\nunclosed"]);
  });
});

describe("html preview bootstrap", () => {
  test("goes first in the head, before the page's own styles", () => {
    const page = injectHtmlPreviewBootstrap(
      "<!doctype html><html><head><style>:root{--x:1}</style></head><body></body></html>",
    );
    expect(page.indexOf('<style id="lilac-theme">')).toBeLessThan(page.indexOf(":root{--x:1}"));
    expect(page.startsWith("<!doctype html><html><head><meta charset")).toBe(true);
  });

  test("adds a head to a fragment, after any doctype", () => {
    expect(injectHtmlPreviewBootstrap("<!doctype html><p>hi</p>")).toMatch(
      /^<!doctype html><head><meta charset="utf-8">.*<\/head><p>hi<\/p>$/su,
    );
    expect(injectHtmlPreviewBootstrap("<p>hi</p>")).toMatch(/^<head>.*<\/head><p>hi<\/p>$/su);
  });
});
