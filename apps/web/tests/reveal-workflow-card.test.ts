import { afterEach, beforeEach, expect, test } from "bun:test";
import { revealWorkflowCard } from "../src/components/reveal-workflow-card";

let frames: (() => void)[] = [];
const originals = ["requestAnimationFrame", "cancelAnimationFrame", "CSS"] as const;
const descriptors = originals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));

beforeEach(() => {
  frames = [];
  Object.defineProperties(globalThis, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: () => void) => frames.push(callback),
    },
    cancelAnimationFrame: { configurable: true, value: () => (frames = []) },
    CSS: { configurable: true, value: { escape: (value: string) => value } },
  });
});

afterEach(() => {
  originals.forEach((name, index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});

function runFrame() {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame();
}

/** A viewport whose card sits `cardAt` pixels down its content. */
function fixture(cardAt = 1_000, options: { mounted?: boolean; maxScroll?: number } = {}) {
  const document = new EventTarget();
  const viewport = Object.assign(new EventTarget(), {
    ownerDocument: document,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () =>
      state.mounted
        ? { getBoundingClientRect: () => ({ top: cardAt - viewport.scrollTop }) }
        : null,
  });
  const state = { mounted: options.mounted ?? true, seeks: 0 };
  const stop = revealWorkflowCard({
    viewport: viewport as unknown as HTMLElement,
    messageId: "card",
    topInset: 48,
    seek: () => {
      state.seeks += 1;
    },
  });
  return { viewport, document, state, stop };
}

test("moves the card below the header and stops once the position holds", () => {
  const { viewport } = fixture();
  runFrame();
  expect(viewport.scrollTop).toBe(944);
  for (let index = 0; index < 5; index += 1) runFrame();
  expect(frames).toEqual([]);
});

test("keeps seeking until the card's row mounts", () => {
  const { viewport, state } = fixture(1_000, { mounted: false });
  runFrame();
  runFrame();
  expect(state.seeks).toBe(2);
  expect(viewport.scrollTop).toBe(0);
  state.mounted = true;
  runFrame();
  expect(viewport.scrollTop).toBe(944);
});

test.each([
  ["wheel", "viewport"],
  ["pointerdown", "viewport"],
  ["keydown", "document"],
] as const)("a viewer's %s stops the reveal so their scroll is kept", (type, source) => {
  const { viewport, document } = fixture();
  runFrame();
  (source === "viewport" ? viewport : document).dispatchEvent(new Event(type));
  viewport.scrollTop = 500;
  runFrame();
  expect(viewport.scrollTop).toBe(500);
  expect(frames).toEqual([]);
});

test("gives up when the card never appears", () => {
  const { state } = fixture(1_000, { mounted: false });
  for (let index = 0; index < 400; index += 1) runFrame();
  expect(frames).toEqual([]);
  expect(state.seeks).toBe(180);
});
