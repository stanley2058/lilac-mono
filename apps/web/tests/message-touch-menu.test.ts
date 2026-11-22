import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  messageContextMenuPolicy,
  shouldStartTouchMenu,
} from "../src/components/use-message-touch-menu";

class FakeNode {
  parentElement: FakeElement | null = null;
  children: FakeNode[] = [];
  ownerDocument: { getSelection: () => { isCollapsed: boolean } | null };

  constructor(ownerDocument: { getSelection: () => { isCollapsed: boolean } | null }) {
    this.ownerDocument = ownerDocument;
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    if (!(other instanceof FakeNode)) return false;
    let current: FakeNode | null = other.parentElement;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attributes: Record<string, string>;

  constructor(
    ownerDocument: { getSelection: () => { isCollapsed: boolean } | null },
    tagName: string,
    attributes: Record<string, string> = {},
  ) {
    super(ownerDocument);
    this.tagName = tagName.toLowerCase();
    this.attributes = attributes;
  }

  append<T extends FakeNode>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const trimmed = part.trim();
      if (trimmed === "a[href]") return this.tagName === "a" && "href" in this.attributes;
      if (trimmed === "[tabindex]") return "tabindex" in this.attributes;
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const [name, value] = trimmed.slice(1, -1).split("=");
        if (!name) return false;
        if (value === undefined) return name in this.attributes;
        return this.attributes[name] === value.replace(/^"|"$/g, "");
      }
      return this.tagName === trimmed;
    });
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

const globals = ["Node", "Element"] as const;
const originalDescriptors = globals.map((name) =>
  Object.getOwnPropertyDescriptor(globalThis, name),
);

beforeEach(() => {
  Object.defineProperties(globalThis, {
    Node: { configurable: true, value: FakeNode },
    Element: { configurable: true, value: FakeElement },
  });
});

afterEach(() => {
  globals.forEach((name, index) => {
    const descriptor = originalDescriptors[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});

function fixture(selectionCollapsed = true) {
  const doc = {
    getSelection: () => ({ isCollapsed: selectionCollapsed }),
  };
  const region = new FakeElement(doc, "div", { tabindex: "0" });
  const trigger = region.append(new FakeElement(doc, "div"));
  const paragraph = trigger.append(new FakeElement(doc, "p"));
  const link = paragraph.append(new FakeElement(doc, "a", { href: "https://example.com" }));
  const linkIcon = link.append(new FakeElement(doc, "span"));
  const linkText = link.append(new FakeNode(doc));
  const reactionTrigger = trigger.append(new FakeElement(doc, "button"));
  const portal = new FakeElement(doc, "div");
  const emojiButton = portal.append(new FakeElement(doc, "button"));
  const emojiGlyph = emojiButton.append(new FakeElement(doc, "span"));
  const emojiInput = portal.append(new FakeElement(doc, "input"));
  return {
    trigger: trigger as unknown as Element,
    paragraph: paragraph as unknown as Element,
    link: link as unknown as Element,
    linkIcon: linkIcon as unknown as Element,
    linkText: linkText as unknown as EventTarget,
    reactionTrigger: reactionTrigger as unknown as Element,
    portal: portal as unknown as Element,
    emojiButton: emojiButton as unknown as Element,
    emojiGlyph: emojiGlyph as unknown as Element,
    emojiInput: emojiInput as unknown as Element,
  };
}

describe("message touch and context menu targeting", () => {
  test("ignores touch events that bubble from portaled popovers", () => {
    const dom = fixture();
    expect(shouldStartTouchMenu(dom.trigger, dom.emojiGlyph)).toBe(false);
    expect(shouldStartTouchMenu(dom.trigger, dom.emojiButton)).toBe(false);
    expect(shouldStartTouchMenu(dom.trigger, dom.emojiInput)).toBe(false);
    expect(shouldStartTouchMenu(dom.trigger, dom.portal)).toBe(false);
  });

  test("ignores interactive controls inside the bubble while allowing plain bubble text", () => {
    const dom = fixture();
    expect(shouldStartTouchMenu(dom.trigger, dom.reactionTrigger)).toBe(false);
    expect(shouldStartTouchMenu(dom.trigger, dom.link)).toBe(false);
    expect(shouldStartTouchMenu(dom.trigger, dom.linkIcon)).toBe(false);
    expect(shouldStartTouchMenu(dom.trigger, dom.paragraph)).toBe(true);
  });

  test("delegates right-clicks on links and selections to the browser menu", () => {
    const dom = fixture(true);
    const mouse = { touchInput: false, isReleaseEvent: false };
    expect(messageContextMenuPolicy(dom.trigger, dom.link, mouse)).toBe("native");
    expect(messageContextMenuPolicy(dom.trigger, dom.linkIcon, mouse)).toBe("native");
    expect(messageContextMenuPolicy(dom.trigger, dom.linkText, mouse)).toBe("native");
    expect(messageContextMenuPolicy(dom.trigger, dom.paragraph, mouse)).toBe("menu");

    const selected = fixture(false);
    expect(messageContextMenuPolicy(selected.trigger, selected.paragraph, mouse)).toBe("native");
  });

  test("treats portaled contextmenu targets as outside the bubble trigger", () => {
    const dom = fixture(true);
    const mouse = { touchInput: false, isReleaseEvent: false };
    expect(messageContextMenuPolicy(dom.trigger, dom.emojiInput, mouse)).toBe("outside");
    expect(messageContextMenuPolicy(dom.trigger, dom.emojiButton, mouse)).toBe("outside");
  });

  test("keeps synthetic touch-release menus open while deferring native touch contextmenus", () => {
    const dom = fixture(true);
    expect(
      messageContextMenuPolicy(dom.trigger, dom.trigger, {
        touchInput: true,
        isReleaseEvent: true,
      }),
    ).toBe("menu");
    expect(
      messageContextMenuPolicy(dom.trigger, dom.paragraph, {
        touchInput: true,
        isReleaseEvent: false,
      }),
    ).toBe("native");
  });
});
