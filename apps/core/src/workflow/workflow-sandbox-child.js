import { AsyncLocalStorage } from "node:async_hooks";

const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const bunRuntime = Bun;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const setExitCode = (code) => {
  process.exitCode = code;
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const contextStorage = new AsyncLocalStorage();
const pending = new Map();
const occurrences = new Map();
let nextMessageId = 1;
let buffered = "";

function send(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (line.length > MAX_PROTOCOL_BYTES) throw new Error("Sandbox protocol output exceeded limit");
  bunRuntime.write(bunRuntime.stdout, encoder.encode(line));
}

function jsonClone(value, label) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > MAX_PROTOCOL_BYTES) {
    throw new Error(`${label} is not bounded JSON`);
  }
  return JSON.parse(encoded);
}

function operationIdentity(callSiteId) {
  const context = contextStorage.getStore() ?? {
    path: "root",
    parentOperationPath: null,
    phase: null,
    depth: 0,
  };
  const key = `${context.path}:${callSiteId}`;
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return { context, occurrence, path: `${key}:${occurrence}` };
}

function hostCall(kind, callSiteId, input, identity = operationIdentity(callSiteId)) {
  const id = nextMessageId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({
    type: "call",
    id,
    kind,
    callSiteId,
    occurrence: identity.occurrence,
    path: identity.path,
    parentPath: identity.context.parentOperationPath,
    phase: identity.context.phase,
    depth: identity.context.depth,
    input: jsonClone(input, "Host call input"),
  });
  return promise;
}

async function agent(callSiteId, prompt, options = {}) {
  return await hostCall("agent", callSiteId, { prompt, options });
}

async function parallel(callSiteId, promises, options = {}) {
  const identity = operationIdentity(callSiteId);
  await hostCall("parallel", callSiteId, { count: promises.length, options }, identity);
  return await Promise.all(promises);
}

async function pipeline(callSiteId, items, callback, options = {}) {
  const identity = operationIdentity(callSiteId);
  await hostCall("pipeline", callSiteId, { items, options }, identity);
  const concurrency = Math.max(1, Math.min(items.length || 1, options.concurrency ?? 1));
  const results = Array.from({ length: items.length });
  let index = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index < items.length) {
        const current = index++;
        const childContext = {
          path: `${identity.path}:item:${current}`,
          parentOperationPath: identity.path,
          phase: identity.context.phase,
          depth: identity.context.depth + 1,
        };
        results[current] = await contextStorage.run(childContext, () =>
          callback(items[current], current),
        );
      }
    }),
  );
  return results;
}

async function phase(callSiteId, name, callback) {
  const identity = operationIdentity(callSiteId);
  await hostCall("phase", callSiteId, { name }, identity);
  return await contextStorage.run(
    {
      path: identity.path,
      parentOperationPath: identity.path,
      phase: name,
      depth: identity.context.depth + 1,
    },
    callback,
  );
}

async function waitForReply(callSiteId, options = {}) {
  return await hostCall("waitForReply", callSiteId, options);
}

async function sleep(callSiteId, durationOrTimestamp) {
  return await hostCall("sleep", callSiteId, durationOrTimestamp);
}

function lockDownGlobals() {
  const constructors = [
    Object.getPrototypeOf(function () {}).constructor,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const constructor of constructors) {
    try {
      Object.defineProperty(constructor.prototype, "constructor", { value: undefined });
    } catch {}
  }
  for (const name of [
    "Bun",
    "process",
    "fetch",
    "WebSocket",
    "EventSource",
    "Worker",
    "Function",
    "eval",
    "Date",
    "crypto",
    "console",
    "performance",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "global",
    "self",
    "require",
    "module",
    "Deno",
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {}
  }
  Object.defineProperty(Math, "random", {
    value: () => {
      throw new Error("Math.random is unavailable in deterministic workflows");
    },
  });
}

async function start(message) {
  const sandboxGlobal = {};
  lockDownGlobals();
  const evaluate = new AsyncFunction(
    "globalThis",
    "Bun",
    "process",
    "fetch",
    "WebSocket",
    "EventSource",
    "Worker",
    "Function",
    "blockedEval",
    "Date",
    "crypto",
    "console",
    "performance",
    "setTimeout",
    "setInterval",
    "queueMicrotask",
    "global",
    "self",
    "require",
    "module",
    "Deno",
    `"use strict";\n${message.source}\nreturn globalThis.__lilacWorkflow;`,
  );
  const definition = await evaluate(
    sandboxGlobal,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  if (!definition || typeof definition.run !== "function")
    throw new Error("Compiled workflow is invalid");
  const result = await contextStorage.run(
    { path: "root", parentOperationPath: null, phase: null, depth: 0 },
    () =>
      definition.run({
        args: jsonClone(message.args, "Workflow arguments"),
        agent,
        parallel,
        pipeline,
        phase,
        waitForReply,
        sleep,
      }),
  );
  send({ type: "result", result: jsonClone(result ?? null, "Workflow result") });
}

function handle(message) {
  if (message.type === "start") {
    void start(message).catch((error) => {
      send({ type: "error", error: error instanceof Error ? error.message : String(error) });
      setExitCode(1);
    });
    return;
  }
  if (message.type !== "resolve" && message.type !== "reject") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.type === "resolve") waiter.resolve(message.value);
  else waiter.reject(new Error(message.error));
}

for await (const chunk of bunRuntime.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  if (buffered.length > MAX_PROTOCOL_BYTES)
    throw new Error("Sandbox protocol input exceeded limit");
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
}
