import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

const original = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { visibilityState: "visible", addEventListener: () => {} },
});
const { closeConnectionNotice, connectionNoticeDelay, showConnectionNotice } =
  await import("../src/use-connection-notice");
const { toast } = await import("../src/components/ui/toast");
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "document", original);
  else Reflect.deleteProperty(globalThis, "document");
});

type ToastLook = {
  id?: string;
  title?: string;
  description?: string;
  type?: string;
  timeout?: number;
  actionProps?: { children?: unknown; disabled?: boolean; onClick?: (event: never) => void };
};
type ToastEvent = { action: string; options: ToastLook & { updates?: ToastLook } };
const manager = toast as unknown as {
  " subscribe": (listener: (event: ToastEvent) => void) => () => void;
};
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  closeConnectionNotice("test");
});
function record() {
  const events: ToastEvent[] = [];
  stops.push(manager[" subscribe"]((event) => events.push(event)));
  return events;
}
function nextUpdate() {
  return new Promise<ToastEvent>((resolve) => {
    const stop = manager[" subscribe"]((event) => {
      if (event.action !== "update") return;
      stop();
      resolve(event);
    });
  });
}

test("a freshly loaded page gives its first connection the resume grace period", () => {
  expect(connectionNoticeDelay()).toBeGreaterThan(2_000);
  expect(connectionNoticeDelay(performance.now() + 60_000)).toBe(1_000);
});

test("every connection problem uses one format and only retryable ones offer Retry", () => {
  const events = record();
  showConnectionNotice({ reason: "This device is offline." }, "test");
  showConnectionNotice({ reason: "Reconnecting…", retry: async () => {} }, "test");
  const [offline, retryable] = events.map((event) => event.options);
  expect(offline).toMatchObject({
    id: "test",
    title: "Not connected",
    description: "This device is offline.",
    type: "offline",
    timeout: 0,
  });
  expect(offline?.actionProps).toBeUndefined();
  expect(retryable).toMatchObject({
    id: "test",
    title: "Not connected",
    description: "Reconnecting…",
    type: "offline",
  });
  expect(retryable?.actionProps?.children).toBe("Retry");
});

test("Retry shows a spinner and disables the button until the attempt fails", async () => {
  const events = record();
  let settle = () => {};
  const attempt = new Promise<void>((resolve) => (settle = resolve));
  showConnectionNotice({ reason: "Reconnecting…", retry: () => attempt }, "test");
  const add = events.find((event) => event.action === "add");
  add?.options.actionProps?.onClick?.({} as never);
  expect(events.at(-1)?.options.updates).toMatchObject({
    type: "loading",
    actionProps: { disabled: true },
  });
  const restored = nextUpdate();
  settle();
  const { options } = await restored;
  expect(options.updates?.type).toBe("offline");
  expect(options.updates?.actionProps?.disabled).toBeUndefined();
  expect(options.updates?.actionProps?.children).toBe("Retry");
});

test("a retry that outlives its notice leaves the next notice alone", async () => {
  const feedback = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
    run();
    return 0;
  }) as never);
  stops.push(() => feedback.mockRestore());
  const events = record();
  let settle = () => {};
  const attempt = new Promise<void>((resolve) => (settle = resolve));
  showConnectionNotice({ reason: "Reconnecting…", retry: () => attempt }, "test");
  events.find((event) => event.action === "add")?.options.actionProps?.onClick?.({} as never);
  showConnectionNotice({ reason: "This device is offline." }, "test");
  const count = events.length;
  settle();
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  expect(events.slice(count)).toEqual([]);
});
