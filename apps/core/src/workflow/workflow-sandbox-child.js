import { AsyncLocalStorage } from "node:async_hooks";

const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const MANIFEST_PREFIX = "/*lilac-workflow-call-sites:";
const HOST_KINDS = new Set(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]);
const bunRuntime = Bun;
const bufferFrom = Buffer.from.bind(Buffer);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SafePromise = Promise;
const jsonStringify = JSON.stringify.bind(JSON);
const jsonParse = JSON.parse.bind(JSON);
const arrayFrom = Array.from.bind(Array);
const arrayIsArray = Array.isArray.bind(Array);
const objectCreate = Object.create.bind(Object);
const objectDefineProperty = Object.defineProperty.bind(Object);
const objectFreeze = Object.freeze.bind(Object);
const reflectOwnKeys = Reflect.ownKeys.bind(Reflect);
const mapGet = Function.call.bind(Map.prototype.get);
const mapSet = Function.call.bind(Map.prototype.set);
const mapDelete = Function.call.bind(Map.prototype.delete);
const mapHas = Function.call.bind(Map.prototype.has);
const setAdd = Function.call.bind(Set.prototype.add);
const setDelete = Function.call.bind(Set.prototype.delete);
const setHas = Function.call.bind(Set.prototype.has);
const promiseAll = Promise.all.bind(Promise);
const promiseFinally = Function.call.bind(Promise.prototype.finally);
const stringStartsWith = Function.call.bind(String.prototype.startsWith);
const stringIndexOf = Function.call.bind(String.prototype.indexOf);
const stringSlice = Function.call.bind(String.prototype.slice);
const mathMax = Math.max.bind(Math);
const mathMin = Math.min.bind(Math);
const setExitCode = (code) => {
  process.exitCode = code;
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const contextStorage = new AsyncLocalStorage();
const pending = new Map();
const occurrences = new Map();
const activeCallSites = new Set();
let nextMessageId = 1;
let buffered = "";

function send(value) {
  const line = `${jsonStringify(value)}\n`;
  if (line.length > MAX_PROTOCOL_BYTES) throw new Error("Sandbox protocol output exceeded limit");
  bunRuntime.write(bunRuntime.stdout, encoder.encode(line));
}

function jsonClone(value, label) {
  const encoded = jsonStringify(value);
  if (encoded === undefined || encoded.length > MAX_PROTOCOL_BYTES) {
    throw new Error(`${label} is not bounded JSON`);
  }
  return jsonParse(encoded);
}

function parseCallSiteManifest(source) {
  if (!stringStartsWith(source, MANIFEST_PREFIX)) return new Map();
  const end = stringIndexOf(source, "*/");
  if (end < 0) throw new Error("Compiled workflow call-site manifest is malformed");
  const encoded = stringSlice(source, MANIFEST_PREFIX.length, end);
  const entries = jsonParse(bufferFrom(encoded, "base64url").toString("utf8"));
  if (!arrayIsArray(entries)) throw new Error("Compiled workflow call-site manifest is malformed");
  const manifest = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !setHas(HOST_KINDS, entry.kind) ||
      typeof entry.callSiteId !== "string" ||
      !/^wfcs:[a-f0-9]{32}$/u.test(entry.callSiteId) ||
      mapHas(manifest, entry.callSiteId)
    ) {
      throw new Error("Compiled workflow call-site manifest is malformed");
    }
    mapSet(manifest, entry.callSiteId, entry.kind);
  }
  return manifest;
}

function operationIdentity(callSiteId) {
  const context = contextStorage.getStore() ?? {
    path: "root",
    parentOperationPath: null,
    phase: null,
    depth: 0,
  };
  const key = `${context.path}:${callSiteId}`;
  const occurrence = mapGet(occurrences, key) ?? 0;
  mapSet(occurrences, key, occurrence + 1);
  return { context, occurrence, path: `${key}:${occurrence}` };
}

function hostCall(
  kind,
  callSiteId,
  input,
  allowedCallSites,
  identity = operationIdentity(callSiteId),
) {
  if (mapGet(allowedCallSites, callSiteId) !== kind) {
    throw new Error(`Workflow attempted unapproved call site ${kind}:${callSiteId}`);
  }
  const activeKey = `${identity.context.path}:${callSiteId}`;
  if (setHas(activeCallSites, activeKey)) {
    throw new Error(`Concurrent workflow call-site reuse is not deterministic: ${callSiteId}`);
  }
  setAdd(activeCallSites, activeKey);
  const id = nextMessageId++;
  const promise = new SafePromise((resolve, reject) => mapSet(pending, id, { resolve, reject }));
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
  return promiseFinally(promise, () => setDelete(activeCallSites, activeKey));
}

function createHostApis(allowedCallSites) {
  const agent = async (callSiteId, prompt, options = {}) =>
    await hostCall("agent", callSiteId, { prompt, options }, allowedCallSites);
  const parallel = async (callSiteId, promises) => {
    const identity = operationIdentity(callSiteId);
    await hostCall("parallel", callSiteId, { count: promises.length }, allowedCallSites, identity);
    return await promiseAll(promises);
  };
  const pipeline = async (callSiteId, items, callback, options = {}) => {
    const identity = operationIdentity(callSiteId);
    await hostCall("pipeline", callSiteId, { items, options }, allowedCallSites, identity);
    const concurrency = mathMax(1, mathMin(items.length || 1, options.concurrency ?? 1));
    const results = arrayFrom({ length: items.length });
    let index = 0;
    await promiseAll(
      arrayFrom({ length: concurrency }, async () => {
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
  };
  const phase = async (callSiteId, name, callback) => {
    const identity = operationIdentity(callSiteId);
    await hostCall("phase", callSiteId, { name }, allowedCallSites, identity);
    return await contextStorage.run(
      {
        path: identity.path,
        parentOperationPath: identity.path,
        phase: name,
        depth: identity.context.depth + 1,
      },
      callback,
    );
  };
  const waitForReply = async (callSiteId, options = {}) =>
    await hostCall("waitForReply", callSiteId, options, allowedCallSites);
  const sleep = async (callSiteId, durationOrTimestamp) =>
    await hostCall("sleep", callSiteId, durationOrTimestamp, allowedCallSites);
  return objectFreeze({ agent, parallel, pipeline, phase, waitForReply, sleep });
}

function lockDownPrimordials() {
  const constructors = [
    Object.getPrototypeOf(function () {}).constructor,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const constructor of constructors) {
    try {
      objectDefineProperty(constructor.prototype, "constructor", { value: undefined });
    } catch {}
    objectFreeze(constructor.prototype);
    objectFreeze(constructor);
  }
  try {
    objectDefineProperty(globalThis, "eval", {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {}
  objectDefineProperty(Math, "random", {
    value: () => {
      throw new Error("Math.random is unavailable in deterministic workflows");
    },
  });
  const primordials = [
    Object,
    Array,
    String,
    Number,
    Boolean,
    BigInt,
    Symbol,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    ArrayBuffer,
    DataView,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
  ];
  for (const primordial of primordials) {
    let prototype = primordial.prototype;
    while (prototype) {
      objectFreeze(prototype);
      prototype = Object.getPrototypeOf(prototype);
    }
    objectFreeze(primordial);
  }
  objectFreeze(JSON);
  objectFreeze(Math);
}

async function start(message) {
  const allowedCallSites = parseCallSiteManifest(message.source);
  const hostApis = createHostApis(allowedCallSites);
  const sandboxGlobal = objectCreate(null);
  const safeGlobalNames = new Set([
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "BigInt",
    "Symbol",
    "JSON",
    "Math",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "ArrayBuffer",
    "DataView",
    "Uint8Array",
    "Int8Array",
    "Uint16Array",
    "Int16Array",
    "Uint32Array",
    "Int32Array",
    "Float32Array",
    "Float64Array",
    "parseInt",
    "parseFloat",
    "isFinite",
    "isNaN",
    "encodeURI",
    "encodeURIComponent",
    "decodeURI",
    "decodeURIComponent",
  ]);
  const globalNames = reflectOwnKeys(globalThis).filter(
    (name) =>
      typeof name === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) &&
      name !== "globalThis" &&
      name !== "eval",
  );
  const safeNames = globalNames.filter((name) => setHas(safeGlobalNames, name));
  const blockedNames = globalNames.filter((name) => !setHas(safeGlobalNames, name));
  const safeValues = safeNames.map((name) => globalThis[name]);
  lockDownPrimordials();
  const evaluate = new AsyncFunction(
    "globalThis",
    ...safeNames,
    ...blockedNames,
    `"use strict";\n${message.source}\nreturn globalThis.__lilacWorkflow;`,
  );
  const definition = await evaluate(
    sandboxGlobal,
    ...safeValues,
    ...blockedNames.map(() => undefined),
  );
  if (!definition || typeof definition.run !== "function") {
    throw new Error("Compiled workflow is invalid");
  }
  const result = await contextStorage.run(
    { path: "root", parentOperationPath: null, phase: null, depth: 0 },
    () =>
      definition.run({
        args: jsonClone(message.args, "Workflow arguments"),
        ...hostApis,
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
  const waiter = mapGet(pending, message.id);
  if (!waiter) return;
  mapDelete(pending, message.id);
  if (message.type === "resolve") waiter.resolve(message.value);
  else waiter.reject(new Error(message.error));
}

for await (const chunk of bunRuntime.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  if (buffered.length > MAX_PROTOCOL_BYTES) {
    throw new Error("Sandbox protocol input exceeded limit");
  }
  while (true) {
    const newline = stringIndexOf(buffered, "\n");
    if (newline < 0) break;
    const line = stringSlice(buffered, 0, newline);
    buffered = stringSlice(buffered, newline + 1);
    if (line) handle(jsonParse(line));
  }
}
