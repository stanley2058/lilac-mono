// client.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/core/serverSentEvents.gen.js
var createSseClient = ({ onRequest, onSseError, onSseEvent, responseTransformer, responseValidator, sseDefaultRetryDelay, sseMaxRetryAttempts, sseMaxRetryDelay, sseSleepFn, url, ...options }) => {
  let lastEventId;
  const sleep = sseSleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createStream = async function* () {
    let retryDelay = sseDefaultRetryDelay ?? 3000;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;
    while (true) {
      if (signal.aborted)
        break;
      attempt++;
      const headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
      if (lastEventId !== undefined) {
        headers.set("Last-Event-ID", lastEventId);
      }
      try {
        const requestInit = {
          redirect: "follow",
          ...options,
          body: options.serializedBody,
          headers,
          signal
        };
        let request = new Request(url, requestInit);
        if (onRequest) {
          request = await onRequest(url, requestInit);
        }
        const _fetch = options.fetch ?? globalThis.fetch;
        const response = await _fetch(request);
        if (!response.ok)
          throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
        if (!response.body)
          throw new Error("No body in SSE response");
        const reader = response.body.pipeThrough(new TextDecoderStream).getReader();
        let buffer = "";
        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {}
        };
        signal.addEventListener("abort", abortHandler);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done)
              break;
            buffer += value;
            buffer = buffer.replace(/\r\n/g, `
`).replace(/\r/g, `
`);
            const chunks = buffer.split(`

`);
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const lines = chunk.split(`
`);
              const dataLines = [];
              let eventName;
              for (const line of lines) {
                if (line.startsWith("data:")) {
                  dataLines.push(line.replace(/^data:\s*/, ""));
                } else if (line.startsWith("event:")) {
                  eventName = line.replace(/^event:\s*/, "");
                } else if (line.startsWith("id:")) {
                  lastEventId = line.replace(/^id:\s*/, "");
                } else if (line.startsWith("retry:")) {
                  const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10);
                  if (!Number.isNaN(parsed)) {
                    retryDelay = parsed;
                  }
                }
              }
              let data;
              let parsedJson = false;
              if (dataLines.length) {
                const rawData = dataLines.join(`
`);
                try {
                  data = JSON.parse(rawData);
                  parsedJson = true;
                } catch {
                  data = rawData;
                }
              }
              if (parsedJson) {
                if (responseValidator) {
                  await responseValidator(data);
                }
                if (responseTransformer) {
                  data = await responseTransformer(data);
                }
              }
              onSseEvent?.({
                data,
                event: eventName,
                id: lastEventId,
                retry: retryDelay
              });
              if (dataLines.length) {
                yield data;
              }
            }
          }
        } finally {
          signal.removeEventListener("abort", abortHandler);
          reader.releaseLock();
        }
        break;
      } catch (error) {
        onSseError?.(error);
        if (sseMaxRetryAttempts !== undefined && attempt >= sseMaxRetryAttempts) {
          break;
        }
        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), sseMaxRetryDelay ?? 30000);
        await sleep(backoff);
      }
    }
  };
  const stream = createStream();
  return { stream };
};

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/core/pathSerializer.gen.js
var separatorArrayExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var separatorArrayNoExplode = (style) => {
  switch (style) {
    case "form":
      return ",";
    case "pipeDelimited":
      return "|";
    case "spaceDelimited":
      return "%20";
    default:
      return ",";
  }
};
var separatorObjectExplode = (style) => {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var serializeArrayParam = ({ allowReserved, explode, name, style, value }) => {
  if (!explode) {
    const joinedValues2 = (allowReserved ? value : value.map((v) => encodeURIComponent(v))).join(separatorArrayNoExplode(style));
    switch (style) {
      case "label":
        return `.${joinedValues2}`;
      case "matrix":
        return `;${name}=${joinedValues2}`;
      case "simple":
        return joinedValues2;
      default:
        return `${name}=${joinedValues2}`;
    }
  }
  const separator = separatorArrayExplode(style);
  const joinedValues = value.map((v) => {
    if (style === "label" || style === "simple") {
      return allowReserved ? v : encodeURIComponent(v);
    }
    return serializePrimitiveParam({
      allowReserved,
      name,
      value: v
    });
  }).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};
var serializePrimitiveParam = ({ allowReserved, name, value }) => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error("Deeply-nested arrays/objects aren’t supported. Provide your own `querySerializer()` to handle these.");
  }
  return `${name}=${allowReserved ? value : encodeURIComponent(value)}`;
};
var serializeObjectParam = ({ allowReserved, explode, name, style, value, valueOnly }) => {
  if (value instanceof Date) {
    return valueOnly ? value.toISOString() : `${name}=${value.toISOString()}`;
  }
  if (style !== "deepObject" && !explode) {
    let values = [];
    Object.entries(value).forEach(([key, v]) => {
      values = [...values, key, allowReserved ? v : encodeURIComponent(v)];
    });
    const joinedValues2 = values.join(",");
    switch (style) {
      case "form":
        return `${name}=${joinedValues2}`;
      case "label":
        return `.${joinedValues2}`;
      case "matrix":
        return `;${name}=${joinedValues2}`;
      default:
        return joinedValues2;
    }
  }
  const separator = separatorObjectExplode(style);
  const joinedValues = Object.entries(value).map(([key, v]) => serializePrimitiveParam({
    allowReserved,
    name: style === "deepObject" ? `${name}[${key}]` : key,
    value: v
  })).join(separator);
  return style === "label" || style === "matrix" ? separator + joinedValues : joinedValues;
};

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/core/utils.gen.js
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var defaultPathSerializer = ({ path, url: _url }) => {
  let url = _url;
  const matches = _url.match(PATH_PARAM_RE);
  if (matches) {
    for (const match of matches) {
      let explode = false;
      let name = match.substring(1, match.length - 1);
      let style = "simple";
      if (name.endsWith("*")) {
        explode = true;
        name = name.substring(0, name.length - 1);
      }
      if (name.startsWith(".")) {
        name = name.substring(1);
        style = "label";
      } else if (name.startsWith(";")) {
        name = name.substring(1);
        style = "matrix";
      }
      const value = path[name];
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        url = url.replace(match, serializeArrayParam({ explode, name, style, value }));
        continue;
      }
      if (typeof value === "object") {
        url = url.replace(match, serializeObjectParam({
          explode,
          name,
          style,
          value,
          valueOnly: true
        }));
        continue;
      }
      if (style === "matrix") {
        url = url.replace(match, `;${serializePrimitiveParam({
          name,
          value
        })}`);
        continue;
      }
      const replaceValue = encodeURIComponent(style === "label" ? `.${value}` : value);
      url = url.replace(match, replaceValue);
    }
  }
  return url;
};
var getUrl = ({ baseUrl, path, query, querySerializer, url: _url }) => {
  const pathUrl = _url.startsWith("/") ? _url : `/${_url}`;
  let url = (baseUrl ?? "") + pathUrl;
  if (path) {
    url = defaultPathSerializer({ path, url });
  }
  let search = query ? querySerializer(query) : "";
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    url += `?${search}`;
  }
  return url;
};
function getValidRequestBody(options) {
  const hasBody = options.body !== undefined;
  const isSerializedBody = hasBody && options.bodySerializer;
  if (isSerializedBody) {
    if ("serializedBody" in options) {
      const hasSerializedBody = options.serializedBody !== undefined && options.serializedBody !== "";
      return hasSerializedBody ? options.serializedBody : null;
    }
    return options.body !== "" ? options.body : null;
  }
  if (hasBody) {
    return options.body;
  }
  return;
}

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/core/auth.gen.js
var getAuthToken = async (auth, callback) => {
  const token = typeof callback === "function" ? await callback(auth) : callback;
  if (!token) {
    return;
  }
  if (auth.scheme === "bearer") {
    return `Bearer ${token}`;
  }
  if (auth.scheme === "basic") {
    return `Basic ${btoa(token)}`;
  }
  return token;
};

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/core/bodySerializer.gen.js
var jsonBodySerializer = {
  bodySerializer: (body) => JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value)
};

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/client/utils.gen.js
var createQuerySerializer = ({ parameters = {}, ...args } = {}) => {
  const querySerializer = (queryParams) => {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === undefined || value === null) {
          continue;
        }
        const options = parameters[name] || args;
        if (Array.isArray(value)) {
          const serializedArray = serializeArrayParam({
            allowReserved: options.allowReserved,
            explode: true,
            name,
            style: "form",
            value,
            ...options.array
          });
          if (serializedArray)
            search.push(serializedArray);
        } else if (typeof value === "object") {
          const serializedObject = serializeObjectParam({
            allowReserved: options.allowReserved,
            explode: true,
            name,
            style: "deepObject",
            value,
            ...options.object
          });
          if (serializedObject)
            search.push(serializedObject);
        } else {
          const serializedPrimitive = serializePrimitiveParam({
            allowReserved: options.allowReserved,
            name,
            value
          });
          if (serializedPrimitive)
            search.push(serializedPrimitive);
        }
      }
    }
    return search.join("&");
  };
  return querySerializer;
};
var getParseAs = (contentType) => {
  if (!contentType) {
    return "stream";
  }
  const cleanContent = contentType.split(";")[0]?.trim();
  if (!cleanContent) {
    return;
  }
  if (cleanContent.startsWith("application/json") || cleanContent.endsWith("+json")) {
    return "json";
  }
  if (cleanContent === "multipart/form-data") {
    return "formData";
  }
  if (["application/", "audio/", "image/", "video/"].some((type) => cleanContent.startsWith(type))) {
    return "blob";
  }
  if (cleanContent.startsWith("text/")) {
    return "text";
  }
  return;
};
var checkForExistence = (options, name) => {
  if (!name) {
    return false;
  }
  if (options.headers.has(name) || options.query?.[name] || options.headers.get("Cookie")?.includes(`${name}=`)) {
    return true;
  }
  return false;
};
var setAuthParams = async ({ security, ...options }) => {
  for (const auth of security) {
    if (checkForExistence(options, auth.name)) {
      continue;
    }
    const token = await getAuthToken(auth, options.auth);
    if (!token) {
      continue;
    }
    const name = auth.name ?? "Authorization";
    switch (auth.in) {
      case "query":
        if (!options.query) {
          options.query = {};
        }
        options.query[name] = token;
        break;
      case "cookie":
        options.headers.append("Cookie", `${name}=${token}`);
        break;
      case "header":
      default:
        options.headers.set(name, token);
        break;
    }
  }
};
var buildUrl = (options) => getUrl({
  baseUrl: options.baseUrl,
  path: options.path,
  query: options.query,
  querySerializer: typeof options.querySerializer === "function" ? options.querySerializer : createQuerySerializer(options.querySerializer),
  url: options.url
});
var mergeConfigs = (a, b) => {
  const config = { ...a, ...b };
  if (config.baseUrl?.endsWith("/")) {
    config.baseUrl = config.baseUrl.substring(0, config.baseUrl.length - 1);
  }
  config.headers = mergeHeaders(a.headers, b.headers);
  return config;
};
var headersEntries = (headers) => {
  const entries = [];
  headers.forEach((value, key) => {
    entries.push([key, value]);
  });
  return entries;
};
var mergeHeaders = (...headers) => {
  const mergedHeaders = new Headers;
  for (const header of headers) {
    if (!header) {
      continue;
    }
    const iterator = header instanceof Headers ? headersEntries(header) : Object.entries(header);
    for (const [key, value] of iterator) {
      if (value === null) {
        mergedHeaders.delete(key);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          mergedHeaders.append(key, v);
        }
      } else if (value !== undefined) {
        mergedHeaders.set(key, typeof value === "object" ? JSON.stringify(value) : value);
      }
    }
  }
  return mergedHeaders;
};

class Interceptors {
  fns = [];
  clear() {
    this.fns = [];
  }
  eject(id) {
    const index = this.getInterceptorIndex(id);
    if (this.fns[index]) {
      this.fns[index] = null;
    }
  }
  exists(id) {
    const index = this.getInterceptorIndex(id);
    return Boolean(this.fns[index]);
  }
  getInterceptorIndex(id) {
    if (typeof id === "number") {
      return this.fns[id] ? id : -1;
    }
    return this.fns.indexOf(id);
  }
  update(id, fn) {
    const index = this.getInterceptorIndex(id);
    if (this.fns[index]) {
      this.fns[index] = fn;
      return id;
    }
    return false;
  }
  use(fn) {
    this.fns.push(fn);
    return this.fns.length - 1;
  }
}
var createInterceptors = () => ({
  error: new Interceptors,
  request: new Interceptors,
  response: new Interceptors
});
var defaultQuerySerializer = createQuerySerializer({
  allowReserved: false,
  array: {
    explode: true,
    style: "form"
  },
  object: {
    explode: true,
    style: "deepObject"
  }
});
var defaultHeaders = {
  "Content-Type": "application/json"
};
var createConfig = (override = {}) => ({
  ...jsonBodySerializer,
  headers: defaultHeaders,
  parseAs: "auto",
  querySerializer: defaultQuerySerializer,
  ...override
});

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/client/client.gen.js
var createClient = (config = {}) => {
  let _config = mergeConfigs(createConfig(), config);
  const getConfig = () => ({ ..._config });
  const setConfig = (config2) => {
    _config = mergeConfigs(_config, config2);
    return getConfig();
  };
  const interceptors = createInterceptors();
  const beforeRequest = async (options) => {
    const opts = {
      ..._config,
      ...options,
      fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
      headers: mergeHeaders(_config.headers, options.headers),
      serializedBody: undefined
    };
    if (opts.security) {
      await setAuthParams({
        ...opts,
        security: opts.security
      });
    }
    if (opts.requestValidator) {
      await opts.requestValidator(opts);
    }
    if (opts.body !== undefined && opts.bodySerializer) {
      opts.serializedBody = opts.bodySerializer(opts.body);
    }
    if (opts.body === undefined || opts.serializedBody === "") {
      opts.headers.delete("Content-Type");
    }
    const url = buildUrl(opts);
    return { opts, url };
  };
  const request = async (options) => {
    const { opts, url } = await beforeRequest(options);
    const requestInit = {
      redirect: "follow",
      ...opts,
      body: getValidRequestBody(opts)
    };
    let request2 = new Request(url, requestInit);
    for (const fn of interceptors.request.fns) {
      if (fn) {
        request2 = await fn(request2, opts);
      }
    }
    const _fetch = opts.fetch;
    let response;
    try {
      response = await _fetch(request2);
    } catch (error2) {
      let finalError2 = error2;
      for (const fn of interceptors.error.fns) {
        if (fn) {
          finalError2 = await fn(error2, undefined, request2, opts);
        }
      }
      finalError2 = finalError2 || {};
      if (opts.throwOnError) {
        throw finalError2;
      }
      return opts.responseStyle === "data" ? undefined : {
        error: finalError2,
        request: request2,
        response: undefined
      };
    }
    for (const fn of interceptors.response.fns) {
      if (fn) {
        response = await fn(response, request2, opts);
      }
    }
    const result = {
      request: request2,
      response
    };
    if (response.ok) {
      const parseAs = (opts.parseAs === "auto" ? getParseAs(response.headers.get("Content-Type")) : opts.parseAs) ?? "json";
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        let emptyData;
        switch (parseAs) {
          case "arrayBuffer":
          case "blob":
          case "text":
            emptyData = await response[parseAs]();
            break;
          case "formData":
            emptyData = new FormData;
            break;
          case "stream":
            emptyData = response.body;
            break;
          case "json":
          default:
            emptyData = {};
            break;
        }
        return opts.responseStyle === "data" ? emptyData : {
          data: emptyData,
          ...result
        };
      }
      let data;
      switch (parseAs) {
        case "arrayBuffer":
        case "blob":
        case "formData":
        case "text":
          data = await response[parseAs]();
          break;
        case "json": {
          const text = await response.text();
          data = text ? JSON.parse(text) : {};
          break;
        }
        case "stream":
          return opts.responseStyle === "data" ? response.body : {
            data: response.body,
            ...result
          };
      }
      if (parseAs === "json") {
        if (opts.responseValidator) {
          await opts.responseValidator(data);
        }
        if (opts.responseTransformer) {
          data = await opts.responseTransformer(data);
        }
      }
      return opts.responseStyle === "data" ? data : {
        data,
        ...result
      };
    }
    const textError = await response.text();
    let jsonError;
    try {
      jsonError = JSON.parse(textError);
    } catch {}
    const error = jsonError ?? textError;
    let finalError = error;
    for (const fn of interceptors.error.fns) {
      if (fn) {
        finalError = await fn(error, response, request2, opts);
      }
    }
    finalError = finalError || {};
    if (opts.throwOnError) {
      throw finalError;
    }
    return opts.responseStyle === "data" ? undefined : {
      error: finalError,
      ...result
    };
  };
  const makeMethodFn = (method) => (options) => request({ ...options, method });
  const makeSseFn = (method) => async (options) => {
    const { opts, url } = await beforeRequest(options);
    return createSseClient({
      ...opts,
      body: opts.body,
      headers: opts.headers,
      method,
      onRequest: async (url2, init) => {
        let request2 = new Request(url2, init);
        for (const fn of interceptors.request.fns) {
          if (fn) {
            request2 = await fn(request2, opts);
          }
        }
        return request2;
      },
      serializedBody: getValidRequestBody(opts),
      url
    });
  };
  return {
    buildUrl,
    connect: makeMethodFn("CONNECT"),
    delete: makeMethodFn("DELETE"),
    get: makeMethodFn("GET"),
    getConfig,
    head: makeMethodFn("HEAD"),
    interceptors,
    options: makeMethodFn("OPTIONS"),
    patch: makeMethodFn("PATCH"),
    post: makeMethodFn("POST"),
    put: makeMethodFn("PUT"),
    request,
    setConfig,
    sse: {
      connect: makeSseFn("CONNECT"),
      delete: makeSseFn("DELETE"),
      get: makeSseFn("GET"),
      head: makeSseFn("HEAD"),
      options: makeSseFn("OPTIONS"),
      patch: makeSseFn("PATCH"),
      post: makeSseFn("POST"),
      put: makeSseFn("PUT"),
      trace: makeSseFn("TRACE")
    },
    trace: makeMethodFn("TRACE")
  };
};
// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/core/params.gen.js
var extraPrefixesMap = {
  $body_: "body",
  $headers_: "headers",
  $path_: "path",
  $query_: "query"
};
var extraPrefixes = Object.entries(extraPrefixesMap);
var buildKeyMap = (fields, map) => {
  if (!map) {
    map = new Map;
  }
  for (const config of fields) {
    if ("in" in config) {
      if (config.key) {
        map.set(config.key, {
          in: config.in,
          map: config.map
        });
      }
    } else if ("key" in config) {
      map.set(config.key, {
        map: config.map
      });
    } else if (config.args) {
      buildKeyMap(config.args, map);
    }
  }
  return map;
};
var stripEmptySlots = (params) => {
  for (const [slot, value] of Object.entries(params)) {
    if (value && typeof value === "object" && !Object.keys(value).length) {
      delete params[slot];
    }
  }
};
var buildClientParams = (args, fields) => {
  const params = {
    body: {},
    headers: {},
    path: {},
    query: {}
  };
  const map = buildKeyMap(fields);
  let config;
  for (const [index, arg] of args.entries()) {
    if (fields[index]) {
      config = fields[index];
    }
    if (!config) {
      continue;
    }
    if ("in" in config) {
      if (config.key) {
        const field = map.get(config.key);
        const name = field.map || config.key;
        if (field.in) {
          params[field.in][name] = arg;
        }
      } else {
        params.body = arg;
      }
    } else {
      for (const [key, value] of Object.entries(arg ?? {})) {
        const field = map.get(key);
        if (field) {
          if (field.in) {
            const name = field.map || key;
            params[field.in][name] = value;
          } else {
            params[field.map] = value;
          }
        } else {
          const extra = extraPrefixes.find(([prefix]) => key.startsWith(prefix));
          if (extra) {
            const [prefix, slot] = extra;
            params[slot][key.slice(prefix.length)] = value;
          } else if ("allowExtra" in config && config.allowExtra) {
            for (const [slot, allowed] of Object.entries(config.allowExtra)) {
              if (allowed) {
                params[slot][key] = value;
                break;
              }
            }
          }
        }
      }
    }
  }
  stripEmptySlots(params);
  return params;
};
// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/client.gen.js
var client = createClient(createConfig({ baseUrl: "http://localhost:4096" }));

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.js
class HeyApiClient {
  client;
  constructor(args) {
    this.client = args?.client ?? client;
  }
}

class HeyApiRegistry {
  defaultKey = "default";
  instances = new Map;
  get(key) {
    const instance = this.instances.get(key ?? this.defaultKey);
    if (!instance) {
      throw new Error(`No SDK client found. Create one with "new OpencodeClient()" to fix this error.`);
    }
    return instance;
  }
  set(value, key) {
    this.instances.set(key ?? this.defaultKey, value);
  }
}

class Config extends HeyApiClient {
  get(options) {
    return (options?.client ?? this.client).get({
      url: "/global/config",
      ...options
    });
  }
  update(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ key: "config", map: "body" }] }]);
    return (options?.client ?? this.client).patch({
      url: "/global/config",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Global extends HeyApiClient {
  health(options) {
    return (options?.client ?? this.client).get({
      url: "/global/health",
      ...options
    });
  }
  event(options) {
    return (options?.client ?? this.client).sse.get({
      url: "/global/event",
      ...options
    });
  }
  dispose(options) {
    return (options?.client ?? this.client).post({
      url: "/global/dispose",
      ...options
    });
  }
  _config;
  get config() {
    return this._config ??= new Config({ client: this.client });
  }
}

class Auth extends HeyApiClient {
  remove(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "path", key: "providerID" }] }]);
    return (options?.client ?? this.client).delete({
      url: "/auth/{providerID}",
      ...options,
      ...params
    });
  }
  set(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "providerID" },
          { key: "auth", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).put({
      url: "/auth/{providerID}",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Project extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/project",
      ...options,
      ...params
    });
  }
  current(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/project/current",
      ...options,
      ...params
    });
  }
  update(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "projectID" },
          { in: "query", key: "directory" },
          { in: "body", key: "name" },
          { in: "body", key: "icon" },
          { in: "body", key: "commands" }
        ]
      }
    ]);
    return (options?.client ?? this.client).patch({
      url: "/project/{projectID}",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Pty extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/pty",
      ...options,
      ...params
    });
  }
  create(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "command" },
          { in: "body", key: "args" },
          { in: "body", key: "cwd" },
          { in: "body", key: "title" },
          { in: "body", key: "env" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/pty",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  remove(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "ptyID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).delete({
      url: "/pty/{ptyID}",
      ...options,
      ...params
    });
  }
  get(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "ptyID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/pty/{ptyID}",
      ...options,
      ...params
    });
  }
  update(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "ptyID" },
          { in: "query", key: "directory" },
          { in: "body", key: "title" },
          { in: "body", key: "size" }
        ]
      }
    ]);
    return (options?.client ?? this.client).put({
      url: "/pty/{ptyID}",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  connect(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "ptyID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/pty/{ptyID}/connect",
      ...options,
      ...params
    });
  }
}

class Config2 extends HeyApiClient {
  get(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/config",
      ...options,
      ...params
    });
  }
  update(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { key: "config", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).patch({
      url: "/config",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  providers(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/config/providers",
      ...options,
      ...params
    });
  }
}

class Tool extends HeyApiClient {
  ids(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/experimental/tool/ids",
      ...options,
      ...params
    });
  }
  list(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "provider" },
          { in: "query", key: "model" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/experimental/tool",
      ...options,
      ...params
    });
  }
}

class Worktree extends HeyApiClient {
  remove(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { key: "worktreeRemoveInput", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).delete({
      url: "/experimental/worktree",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/experimental/worktree",
      ...options,
      ...params
    });
  }
  create(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { key: "worktreeCreateInput", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/experimental/worktree",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  reset(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { key: "worktreeResetInput", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/experimental/worktree/reset",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Resource extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/experimental/resource",
      ...options,
      ...params
    });
  }
}

class Experimental extends HeyApiClient {
  _resource;
  get resource() {
    return this._resource ??= new Resource({ client: this.client });
  }
}

class Session extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "roots" },
          { in: "query", key: "start" },
          { in: "query", key: "search" },
          { in: "query", key: "limit" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session",
      ...options,
      ...params
    });
  }
  create(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "parentID" },
          { in: "body", key: "title" },
          { in: "body", key: "permission" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  status(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/session/status",
      ...options,
      ...params
    });
  }
  delete(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).delete({
      url: "/session/{sessionID}",
      ...options,
      ...params
    });
  }
  get(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session/{sessionID}",
      ...options,
      ...params
    });
  }
  update(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "title" },
          { in: "body", key: "time" }
        ]
      }
    ]);
    return (options?.client ?? this.client).patch({
      url: "/session/{sessionID}",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  children(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session/{sessionID}/children",
      ...options,
      ...params
    });
  }
  todo(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session/{sessionID}/todo",
      ...options,
      ...params
    });
  }
  init(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "modelID" },
          { in: "body", key: "providerID" },
          { in: "body", key: "messageID" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/init",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  fork(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "messageID" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/fork",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  abort(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/abort",
      ...options,
      ...params
    });
  }
  unshare(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).delete({
      url: "/session/{sessionID}/share",
      ...options,
      ...params
    });
  }
  share(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/share",
      ...options,
      ...params
    });
  }
  diff(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "query", key: "messageID" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session/{sessionID}/diff",
      ...options,
      ...params
    });
  }
  summarize(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "providerID" },
          { in: "body", key: "modelID" },
          { in: "body", key: "auto" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/summarize",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  messages(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "query", key: "limit" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session/{sessionID}/message",
      ...options,
      ...params
    });
  }
  prompt(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "messageID" },
          { in: "body", key: "model" },
          { in: "body", key: "agent" },
          { in: "body", key: "noReply" },
          { in: "body", key: "tools" },
          { in: "body", key: "system" },
          { in: "body", key: "variant" },
          { in: "body", key: "parts" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/message",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  message(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "path", key: "messageID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/session/{sessionID}/message/{messageID}",
      ...options,
      ...params
    });
  }
  promptAsync(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "messageID" },
          { in: "body", key: "model" },
          { in: "body", key: "agent" },
          { in: "body", key: "noReply" },
          { in: "body", key: "tools" },
          { in: "body", key: "system" },
          { in: "body", key: "variant" },
          { in: "body", key: "parts" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/prompt_async",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  command(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "messageID" },
          { in: "body", key: "agent" },
          { in: "body", key: "model" },
          { in: "body", key: "arguments" },
          { in: "body", key: "command" },
          { in: "body", key: "variant" },
          { in: "body", key: "parts" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/command",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  shell(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "agent" },
          { in: "body", key: "model" },
          { in: "body", key: "command" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/shell",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  revert(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "messageID" },
          { in: "body", key: "partID" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/revert",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  unrevert(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/unrevert",
      ...options,
      ...params
    });
  }
}

class Part extends HeyApiClient {
  delete(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "path", key: "messageID" },
          { in: "path", key: "partID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).delete({
      url: "/session/{sessionID}/message/{messageID}/part/{partID}",
      ...options,
      ...params
    });
  }
  update(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "path", key: "messageID" },
          { in: "path", key: "partID" },
          { in: "query", key: "directory" },
          { key: "part", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).patch({
      url: "/session/{sessionID}/message/{messageID}/part/{partID}",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Permission extends HeyApiClient {
  respond(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "sessionID" },
          { in: "path", key: "permissionID" },
          { in: "query", key: "directory" },
          { in: "body", key: "response" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/session/{sessionID}/permissions/{permissionID}",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  reply(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "requestID" },
          { in: "query", key: "directory" },
          { in: "body", key: "reply" },
          { in: "body", key: "message" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/permission/{requestID}/reply",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/permission",
      ...options,
      ...params
    });
  }
}

class Question extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/question",
      ...options,
      ...params
    });
  }
  reply(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "requestID" },
          { in: "query", key: "directory" },
          { in: "body", key: "answers" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/question/{requestID}/reply",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  reject(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "requestID" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/question/{requestID}/reject",
      ...options,
      ...params
    });
  }
}

class Oauth extends HeyApiClient {
  authorize(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "providerID" },
          { in: "query", key: "directory" },
          { in: "body", key: "method" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/provider/{providerID}/oauth/authorize",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  callback(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "providerID" },
          { in: "query", key: "directory" },
          { in: "body", key: "method" },
          { in: "body", key: "code" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/provider/{providerID}/oauth/callback",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Provider extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/provider",
      ...options,
      ...params
    });
  }
  auth(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/provider/auth",
      ...options,
      ...params
    });
  }
  _oauth;
  get oauth() {
    return this._oauth ??= new Oauth({ client: this.client });
  }
}

class Find extends HeyApiClient {
  text(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "pattern" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/find",
      ...options,
      ...params
    });
  }
  files(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "query" },
          { in: "query", key: "dirs" },
          { in: "query", key: "type" },
          { in: "query", key: "limit" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/find/file",
      ...options,
      ...params
    });
  }
  symbols(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "query" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/find/symbol",
      ...options,
      ...params
    });
  }
}

class File extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "path" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/file",
      ...options,
      ...params
    });
  }
  read(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "query", key: "path" }
        ]
      }
    ]);
    return (options?.client ?? this.client).get({
      url: "/file/content",
      ...options,
      ...params
    });
  }
  status(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/file/status",
      ...options,
      ...params
    });
  }
}

class Auth2 extends HeyApiClient {
  remove(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "name" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).delete({
      url: "/mcp/{name}/auth",
      ...options,
      ...params
    });
  }
  start(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "name" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/mcp/{name}/auth",
      ...options,
      ...params
    });
  }
  callback(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "name" },
          { in: "query", key: "directory" },
          { in: "body", key: "code" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/mcp/{name}/auth/callback",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  authenticate(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "name" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/mcp/{name}/auth/authenticate",
      ...options,
      ...params
    });
  }
}

class Mcp extends HeyApiClient {
  status(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/mcp",
      ...options,
      ...params
    });
  }
  add(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "name" },
          { in: "body", key: "config" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/mcp",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  connect(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "name" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/mcp/{name}/connect",
      ...options,
      ...params
    });
  }
  disconnect(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "path", key: "name" },
          { in: "query", key: "directory" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/mcp/{name}/disconnect",
      ...options,
      ...params
    });
  }
  _auth;
  get auth() {
    return this._auth ??= new Auth2({ client: this.client });
  }
}

class Control extends HeyApiClient {
  next(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/tui/control/next",
      ...options,
      ...params
    });
  }
  response(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { key: "body", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/tui/control/response",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
}

class Tui extends HeyApiClient {
  appendPrompt(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "text" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/tui/append-prompt",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  openHelp(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/tui/open-help",
      ...options,
      ...params
    });
  }
  openSessions(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/tui/open-sessions",
      ...options,
      ...params
    });
  }
  openThemes(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/tui/open-themes",
      ...options,
      ...params
    });
  }
  openModels(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/tui/open-models",
      ...options,
      ...params
    });
  }
  submitPrompt(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/tui/submit-prompt",
      ...options,
      ...params
    });
  }
  clearPrompt(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/tui/clear-prompt",
      ...options,
      ...params
    });
  }
  executeCommand(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "command" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/tui/execute-command",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  showToast(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "title" },
          { in: "body", key: "message" },
          { in: "body", key: "variant" },
          { in: "body", key: "duration" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/tui/show-toast",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  publish(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { key: "body", map: "body" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/tui/publish",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  selectSession(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "sessionID" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/tui/select-session",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  _control;
  get control() {
    return this._control ??= new Control({ client: this.client });
  }
}

class Instance extends HeyApiClient {
  dispose(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).post({
      url: "/instance/dispose",
      ...options,
      ...params
    });
  }
}

class Path extends HeyApiClient {
  get(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/path",
      ...options,
      ...params
    });
  }
}

class Vcs extends HeyApiClient {
  get(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/vcs",
      ...options,
      ...params
    });
  }
}

class Command extends HeyApiClient {
  list(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/command",
      ...options,
      ...params
    });
  }
}

class App extends HeyApiClient {
  log(parameters, options) {
    const params = buildClientParams([parameters], [
      {
        args: [
          { in: "query", key: "directory" },
          { in: "body", key: "service" },
          { in: "body", key: "level" },
          { in: "body", key: "message" },
          { in: "body", key: "extra" }
        ]
      }
    ]);
    return (options?.client ?? this.client).post({
      url: "/log",
      ...options,
      ...params,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        ...params.headers
      }
    });
  }
  agents(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/agent",
      ...options,
      ...params
    });
  }
  skills(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/skill",
      ...options,
      ...params
    });
  }
}

class Lsp extends HeyApiClient {
  status(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/lsp",
      ...options,
      ...params
    });
  }
}

class Formatter extends HeyApiClient {
  status(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).get({
      url: "/formatter",
      ...options,
      ...params
    });
  }
}

class Event extends HeyApiClient {
  subscribe(parameters, options) {
    const params = buildClientParams([parameters], [{ args: [{ in: "query", key: "directory" }] }]);
    return (options?.client ?? this.client).sse.get({
      url: "/event",
      ...options,
      ...params
    });
  }
}

class OpencodeClient extends HeyApiClient {
  static __registry = new HeyApiRegistry;
  constructor(args) {
    super(args);
    OpencodeClient.__registry.set(this, args?.key);
  }
  _global;
  get global() {
    return this._global ??= new Global({ client: this.client });
  }
  _auth;
  get auth() {
    return this._auth ??= new Auth({ client: this.client });
  }
  _project;
  get project() {
    return this._project ??= new Project({ client: this.client });
  }
  _pty;
  get pty() {
    return this._pty ??= new Pty({ client: this.client });
  }
  _config;
  get config() {
    return this._config ??= new Config2({ client: this.client });
  }
  _tool;
  get tool() {
    return this._tool ??= new Tool({ client: this.client });
  }
  _worktree;
  get worktree() {
    return this._worktree ??= new Worktree({ client: this.client });
  }
  _experimental;
  get experimental() {
    return this._experimental ??= new Experimental({ client: this.client });
  }
  _session;
  get session() {
    return this._session ??= new Session({ client: this.client });
  }
  _part;
  get part() {
    return this._part ??= new Part({ client: this.client });
  }
  _permission;
  get permission() {
    return this._permission ??= new Permission({ client: this.client });
  }
  _question;
  get question() {
    return this._question ??= new Question({ client: this.client });
  }
  _provider;
  get provider() {
    return this._provider ??= new Provider({ client: this.client });
  }
  _find;
  get find() {
    return this._find ??= new Find({ client: this.client });
  }
  _file;
  get file() {
    return this._file ??= new File({ client: this.client });
  }
  _mcp;
  get mcp() {
    return this._mcp ??= new Mcp({ client: this.client });
  }
  _tui;
  get tui() {
    return this._tui ??= new Tui({ client: this.client });
  }
  _instance;
  get instance() {
    return this._instance ??= new Instance({ client: this.client });
  }
  _path;
  get path() {
    return this._path ??= new Path({ client: this.client });
  }
  _vcs;
  get vcs() {
    return this._vcs ??= new Vcs({ client: this.client });
  }
  _command;
  get command() {
    return this._command ??= new Command({ client: this.client });
  }
  _app;
  get app() {
    return this._app ??= new App({ client: this.client });
  }
  _lsp;
  get lsp() {
    return this._lsp ??= new Lsp({ client: this.client });
  }
  _formatter;
  get formatter() {
    return this._formatter ??= new Formatter({ client: this.client });
  }
  _event;
  get event() {
    return this._event ??= new Event({ client: this.client });
  }
}

// ../../node_modules/.bun/@opencode-ai+sdk@1.1.49/node_modules/@opencode-ai/sdk/dist/v2/client.js
function createOpencodeClient(config) {
  if (!config?.fetch) {
    const customFetch = (req) => {
      req.timeout = false;
      return fetch(req);
    };
    config = {
      ...config,
      fetch: customFetch
    };
  }
  if (config?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(config.directory);
    const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory;
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodedDirectory
    };
  }
  const client2 = createClient(config);
  return new OpencodeClient({ client: client2 });
}
// client.ts
function isRecord(x) {
  return typeof x === "object" && x !== null;
}
function toInt(x) {
  if (typeof x === "number" && Number.isFinite(x))
    return Math.trunc(x);
  if (typeof x === "string" && x.trim().length > 0) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}
function toBool(x) {
  if (typeof x === "boolean")
    return x;
  if (typeof x === "string") {
    const v = x.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes")
      return true;
    if (v === "false" || v === "0" || v === "no")
      return false;
  }
  return null;
}
function parseFlags(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0;i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    if (a.startsWith("--no-")) {
      flags[a.slice("--no-".length)] = false;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
      continue;
    }
    flags[key] = true;
  }
  return { flags, positionals };
}
function getStringFlag(flags, key) {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
function getBoolFlag(flags, key, defaultValue) {
  const v = flags[key];
  if (v === undefined)
    return defaultValue;
  if (typeof v === "boolean")
    return v;
  const parsed = toBool(v);
  return parsed ?? defaultValue;
}
function getIntFlag(flags, key, defaultValue) {
  const v = flags[key];
  if (v === undefined)
    return defaultValue;
  const parsed = toInt(v);
  return parsed ?? defaultValue;
}
async function readStdinText() {
  if (process.stdin.isTTY)
    return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function printJson(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.stdout.write(`
`);
}
function parseModelSpec(spec) {
  const idx = spec.indexOf("/");
  if (idx === -1) {
    throw new Error(`Invalid --model '${spec}'. Expected 'provider/model' (e.g. 'anthropic/claude-sonnet-4-20250514').`);
  }
  const providerID = spec.slice(0, idx).trim();
  const modelID = spec.slice(idx + 1).trim();
  if (!providerID || !modelID) {
    throw new Error(`Invalid --model '${spec}'. Expected 'provider/model' (non-empty provider and model).`);
  }
  return { providerID, modelID };
}
function denyQuestionsRuleset() {
  return [{ permission: "question", pattern: "*", action: "deny" }];
}
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
async function ensureServer(params) {
  const client3 = createOpencodeClient({
    baseUrl: params.baseUrl,
    directory: params.directory
  });
  const healthOk = await (async () => {
    try {
      const res = await client3.global.health();
      return Boolean(res.data?.healthy) && !res.error;
    } catch {
      return false;
    }
  })();
  if (healthOk)
    return { client: client3, started: false };
  if (!params.ensure) {
    throw new Error(`OpenCode server is not reachable at ${params.baseUrl} (and --no-ensure-server was set).`);
  }
  const u = new URL(params.baseUrl);
  const hostname = u.hostname || "127.0.0.1";
  const port = u.port ? Number(u.port) : 4096;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid base URL port in ${params.baseUrl}`);
  }
  const child = spawn(params.opencodeBin, ["serve", "--hostname", hostname, "--port", String(port)], {
    stdio: "ignore",
    detached: true,
    env: process.env
  });
  let spawnError = null;
  child.once("error", (err) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });
  child.unref();
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.serverStartTimeoutMs) {
    if (spawnError !== null) {
      throw new Error(`Failed to spawn '${params.opencodeBin} serve': ${spawnError}`);
    }
    try {
      const res = await client3.global.health();
      if (res.data?.healthy && !res.error)
        return { client: client3, started: true };
    } catch {}
    await sleep(200);
  }
  throw new Error(`Started '${params.opencodeBin} serve' but server did not become healthy at ${params.baseUrl} within ${params.serverStartTimeoutMs}ms.`);
}
async function selectSession(params) {
  const { client: client3 } = params;
  if (params.sessionID) {
    const res = await client3.session.get({ sessionID: params.sessionID });
    if (res.error || !res.data) {
      throw new Error(`Failed to load session '${params.sessionID}': ${JSON.stringify(res.error)}`);
    }
    return { session: res.data, created: false };
  }
  if (params.title) {
    const list = await client3.session.list({
      directory: params.directory,
      search: params.title,
      limit: 50
    });
    if (list.error) {
      throw new Error(`Failed to list sessions for title lookup: ${JSON.stringify(list.error)}`);
    }
    const sessions = Array.isArray(list.data) ? list.data : [];
    const found = sessions.find((s) => s.title === params.title);
    if (found)
      return { session: found, created: false };
    const createRes2 = await client3.session.create({
      title: params.title,
      ...params.denyQuestionsOnCreate ? { permission: denyQuestionsRuleset() } : {}
    });
    if (createRes2.error || !createRes2.data) {
      throw new Error(`Failed to create session '${params.title}': ${JSON.stringify(createRes2.error)}`);
    }
    return { session: createRes2.data, created: true };
  }
  if (params.cont) {
    const list = await client3.session.list({
      directory: params.directory,
      roots: true,
      limit: 1
    });
    if (list.error) {
      throw new Error(`Failed to list sessions for --continue: ${JSON.stringify(list.error)}`);
    }
    const s = Array.isArray(list.data) ? list.data[0] : undefined;
    if (s)
      return { session: s, created: false };
  }
  const createRes = await client3.session.create({
    ...params.denyQuestionsOnCreate ? { permission: denyQuestionsRuleset() } : {}
  });
  if (createRes.error || !createRes.data) {
    throw new Error(`Failed to create session: ${JSON.stringify(createRes.error)}`);
  }
  return { session: createRes.data, created: true };
}
async function resolveExistingSession(params) {
  const { client: client3 } = params;
  if (params.sessionID) {
    const res = await client3.session.get({ sessionID: params.sessionID });
    if (res.error || !res.data) {
      throw new Error(`Failed to load session '${params.sessionID}': ${JSON.stringify(res.error)}`);
    }
    return res.data;
  }
  if (params.title) {
    const list = await client3.session.list({
      directory: params.directory,
      search: params.title,
      limit: 50
    });
    if (list.error) {
      throw new Error(`Failed to list sessions for title lookup: ${JSON.stringify(list.error)}`);
    }
    const sessions = Array.isArray(list.data) ? list.data : [];
    const found = sessions.find((s) => s.title === params.title);
    if (found)
      return found;
    throw new Error(`No session found with exact title '${params.title}'.`);
  }
  if (params.cont) {
    const list = await client3.session.list({
      directory: params.directory,
      roots: true,
      limit: 1
    });
    if (list.error) {
      throw new Error(`Failed to list sessions for --continue: ${JSON.stringify(list.error)}`);
    }
    const s = Array.isArray(list.data) ? list.data[0] : undefined;
    if (s)
      return s;
    throw new Error(`No sessions found in directory '${params.directory}'.`);
  }
  throw new Error("Missing session selector (session-id/title/--continue).");
}
function buildRecentRuns(params) {
  const maxRuns = Math.max(0, Math.trunc(params.maxRuns));
  const maxChars = Math.max(0, Math.trunc(params.maxCharsPerMessage));
  let truncated = false;
  const assistantByParent = new Map;
  for (const m of params.messages) {
    if (m.info.role !== "assistant")
      continue;
    const parentID = m.info.parentID;
    if (!parentID)
      continue;
    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    const prev = assistantByParent.get(parentID);
    const prevCreated = typeof prev?.info.time?.created === "number" ? prev.info.time.created : -1;
    if (!prev || created >= prevCreated) {
      assistantByParent.set(parentID, { info: m.info, parts: m.parts });
    }
  }
  const runs = [];
  for (const m of params.messages) {
    if (m.info.role !== "user")
      continue;
    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    const userText = pickUserText(m.parts);
    const tUser = truncateText(userText, maxChars);
    truncated = truncated || tUser.truncated;
    const a = assistantByParent.get(m.info.id);
    const assistant = a ? (() => {
      const aCreated = typeof a.info.time?.created === "number" ? a.info.time.created : 0;
      const aText = pickAssistantText(a.parts);
      const tAsst = truncateText(aText, maxChars);
      truncated = truncated || tAsst.truncated;
      return {
        messageID: a.info.id,
        created: aCreated,
        text: tAsst.text,
        error: a.info.error
      };
    })() : null;
    runs.push({
      user: {
        messageID: m.info.id,
        created,
        text: tUser.text
      },
      assistant
    });
  }
  return {
    runs: maxRuns === 0 ? [] : runs.slice(-maxRuns),
    truncated
  };
}
async function runSnapshot(params) {
  const out = {
    ok: false,
    sessionID: "",
    meta: {
      directory: params.directory,
      baseUrl: params.baseUrl,
      ensureServer: params.ensureServer
    }
  };
  try {
    const ensured = await ensureServer({
      baseUrl: params.baseUrl,
      directory: params.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 1e4
    });
    const client3 = ensured.client;
    const session = await resolveExistingSession({
      client: client3,
      directory: params.directory,
      sessionID: params.sessionID,
      title: params.title,
      cont: params.cont
    });
    out.sessionID = session.id;
    out.session = {
      id: session.id,
      title: session.title,
      directory: session.directory,
      parentID: session.parentID,
      time: {
        created: session.time.created,
        updated: session.time.updated,
        archived: session.time.archived
      },
      ...session.summary ? {
        summary: {
          additions: session.summary.additions,
          deletions: session.summary.deletions,
          files: session.summary.files
        }
      } : {}
    };
    const todosRes = await client3.session.todo({ sessionID: session.id });
    if (todosRes.error) {
      throw new Error(`Failed to fetch session todos: ${JSON.stringify(todosRes.error)}`);
    }
    const todosAll = Array.isArray(todosRes.data) ? todosRes.data : [];
    const remaining = todosAll.filter(isTodoRemaining);
    const pending = remaining.filter((t) => t.status === "pending").length;
    const inProgress = remaining.filter((t) => t.status === "in_progress").length;
    const other = remaining.length - pending - inProgress;
    out.todo = {
      remaining: {
        total: remaining.length,
        pending,
        in_progress: inProgress,
        other
      },
      ...params.includeTodos ? {
        items: remaining.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status,
          priority: t.priority
        }))
      } : {}
    };
    const limit = Math.max(1, Math.trunc(params.messagesLimit));
    const msgs = await client3.session.messages({
      sessionID: session.id,
      limit
    });
    if (msgs.error || !msgs.data) {
      throw new Error(`Failed to fetch session messages: ${JSON.stringify(msgs.error)}`);
    }
    const recent = buildRecentRuns({
      messages: msgs.data,
      maxRuns: params.maxRuns,
      maxCharsPerMessage: params.maxCharsPerMessage
    });
    out.recent = { runs: recent.runs };
    out.truncation = {
      maxCharsPerMessage: params.maxCharsPerMessage,
      maxRuns: params.maxRuns,
      fetchedMessagesLimit: limit,
      truncated: recent.truncated
    };
    out.ok = true;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = isRecord(e) && "message" in e ? e.message : String(e);
    return out;
  }
}
function pickAssistantText(parts) {
  return parts.filter((p) => p.type === "text").map((p) => p.ignored ? "" : p.text).filter((s) => s.length > 0).join("");
}
function pickUserText(parts) {
  return parts.filter((p) => p.type === "text").map((p) => p.ignored ? "" : p.text).filter((s) => s.length > 0).join("");
}
function truncateText(text, maxChars) {
  if (maxChars <= 0)
    return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars)
    return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
function isTodoRemaining(t) {
  const s = typeof t.status === "string" ? t.status : "";
  return s !== "completed" && s !== "cancelled";
}
function findAssistantMessageForUserMessage(params) {
  let best = null;
  let bestCreated = -1;
  for (const m of params.messages) {
    if (m.info.role !== "assistant")
      continue;
    const parentID = m.info.parentID;
    if (parentID !== params.userMessageID)
      continue;
    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    if (!best || created >= bestCreated) {
      best = { info: m.info, parts: m.parts };
      bestCreated = created;
    }
  }
  return best;
}
async function runPrompt(params) {
  const out = {
    ok: false,
    sessionID: "",
    userMessageID: "",
    events: {
      permissionsAutoApproved: 0,
      permissionsAutoFailed: 0,
      questionsAutoRejected: 0
    },
    meta: {
      directory: params.directory,
      baseUrl: params.baseUrl,
      agent: params.agent,
      model: params.model,
      variant: params.variant,
      timeoutMs: params.timeoutMs,
      ensureServer: params.ensureServer
    }
  };
  let sessionError;
  try {
    const ensured = await ensureServer({
      baseUrl: params.baseUrl,
      directory: params.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 1e4
    });
    const client3 = ensured.client;
    const { session } = await selectSession({
      client: client3,
      directory: params.directory,
      sessionID: params.sessionID,
      title: params.title,
      cont: params.cont,
      denyQuestionsOnCreate: params.denyQuestionsOnCreate
    });
    out.sessionID = session.id;
    const userMessageID = `lilac_${randomUUID()}`;
    out.userMessageID = userMessageID;
    const sse = new AbortController;
    const events = await client3.event.subscribe({ directory: params.directory }, { signal: sse.signal });
    const respondedPermissions = new Set;
    const respondedQuestions = new Set;
    let promptSent = false;
    let sawBusyAfterPrompt = false;
    const sentAt = Date.now();
    const closeEvents = () => {
      try {
        sse.abort();
      } catch {}
    };
    const done = (async () => {
      for await (const event of events.stream) {
        if (event.type === "permission.asked") {
          const perm = event.properties;
          if (perm?.sessionID !== session.id)
            continue;
          const permId = typeof perm?.id === "string" ? perm.id : null;
          if (!permId)
            continue;
          if (respondedPermissions.has(permId))
            continue;
          respondedPermissions.add(permId);
          try {
            await client3.permission.reply({
              requestID: permId,
              reply: params.permissionResponse
            });
            out.events.permissionsAutoApproved++;
          } catch (e) {
            out.events.permissionsAutoFailed++;
          }
          continue;
        }
        if (event.type === "question.asked") {
          if (!params.autoRejectQuestions)
            continue;
          const q = event.properties;
          if (q?.sessionID !== session.id)
            continue;
          const requestID = typeof q?.id === "string" ? q.id : null;
          if (!requestID)
            continue;
          if (respondedQuestions.has(requestID))
            continue;
          respondedQuestions.add(requestID);
          try {
            await client3.question.reject({ requestID });
            out.events.questionsAutoRejected++;
          } catch {}
          continue;
        }
        if (event.type === "session.status") {
          const p = event.properties;
          if (p?.sessionID !== session.id)
            continue;
          if (!promptSent)
            continue;
          if (p?.status?.type === "busy")
            sawBusyAfterPrompt = true;
          continue;
        }
        if (event.type === "session.error") {
          const p = event.properties;
          if (p?.sessionID !== session.id)
            continue;
          sessionError = p?.error ?? p;
          throw new Error("OpenCode session.error");
        }
        if (event.type === "session.idle") {
          const p = event.properties;
          if (p?.sessionID !== session.id)
            continue;
          if (!promptSent)
            continue;
          if (!sawBusyAfterPrompt && Date.now() - sentAt < 500)
            continue;
          return;
        }
      }
    })();
    promptSent = true;
    const model = params.model ? parseModelSpec(params.model) : undefined;
    const accepted = await client3.session.promptAsync({
      sessionID: session.id,
      messageID: userMessageID,
      agent: params.agent ?? "build",
      ...model ? { model } : {},
      ...params.variant ? { variant: params.variant } : {},
      parts: [{ type: "text", text: params.text }]
    });
    if (accepted.error) {
      closeEvents();
      throw new Error(`OpenCode prompt_async rejected: ${JSON.stringify(accepted.error)}`);
    }
    const timeoutPromise = new Promise((_, reject) => {
      const t = setTimeout(() => {
        closeEvents();
        client3.session.abort({ sessionID: session.id }).catch(() => {});
        reject(new Error(`Timeout waiting for session.idle after ${params.timeoutMs}ms`));
      }, params.timeoutMs);
      t.unref?.();
    });
    await Promise.race([done, timeoutPromise]);
    closeEvents();
    const msgs = await client3.session.messages({
      sessionID: session.id,
      limit: 200
    });
    if (msgs.error || !msgs.data) {
      throw new Error(`Failed to fetch session messages: ${JSON.stringify(msgs.error)}`);
    }
    const match = findAssistantMessageForUserMessage({
      userMessageID,
      messages: msgs.data
    });
    if (!match) {
      throw new Error(`Could not find assistant message for user message '${userMessageID}'.`);
    }
    const text = pickAssistantText(match.parts);
    out.assistant = {
      messageID: match.info.id,
      text,
      error: match.info.error,
      modelID: match.info.modelID,
      providerID: match.info.providerID,
      agent: match.info.agent,
      tokens: match.info.tokens,
      cost: match.info.cost,
      finish: match.info.finish
    };
    out.ok = match.info.error === undefined;
    if (!out.ok)
      out.error = match.info.error;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = sessionError ?? (isRecord(e) && "message" in e ? e.message : String(e));
    return out;
  }
}
function help() {
  return [
    "lilac-opencode (OpenCode controller)",
    "",
    "Usage:",
    "  lilac-opencode sessions list [--directory <path>] [--roots] [--limit <n>] [--search <term>] [--base-url <url>] [--no-ensure-server]",
    "  lilac-opencode sessions snapshot [--directory <path>] [--session-id <id> | --title <title> | --continue] [--runs <n>] [--max-chars <n>] [--messages-limit <n>] [--include-todos] [--base-url <url>] [--no-ensure-server]",
    "  lilac-opencode prompt --text <msg> [--directory <path>] [--session-id <id> | --title <title> | --continue] [--agent <name>] [--model <provider/model>] [--variant <v>]",
    "",
    "Global flags:",
    "  --base-url=<url>            Default: http://127.0.0.1:4096",
    "  --directory=<path>          Default: cwd",
    "  --ensure-server/--no-ensure-server  Default: true",
    "  --opencode-bin=<path>       Default: opencode",
    "  --timeout-ms=<n>            Default: 600000 (10 min)",
    "",
    "Prompt flags:",
    "  --session-id=<id>           Use exact OpenCode session ID",
    "  --title=<title>             Find or create session by exact title",
    "  --continue                  Use newest root session in directory (default)",
    "  --permission-response=<once|always>  Default: always",
    "  --auto-reject-questions/--no-auto-reject-questions  Default: true",
    "  --deny-questions-on-create/--no-deny-questions-on-create Default: true",
    "",
    "Snapshot flags:",
    "  --runs=<n>                  Default: 6",
    "  --max-chars=<n>             Default: 1200 (per user/assistant text)",
    "  --messages-limit=<n>        Default: 120",
    "  --include-todos             Include remaining todo items (default: counts only)",
    "",
    "Notes:",
    "  - Output is always JSON.",
    "  - If --text is omitted and stdin is piped, stdin is used as the message."
  ].join(`
`);
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help")) {
    printJson({ ok: true, help: help(), version: "0.0.3" });
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    printJson({ ok: true, version: "0.0.3" });
    return;
  }
  const cmd = argv[0] ?? "";
  if (cmd === "sessions") {
    const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "list";
    const rest = sub === "list" || sub === "snapshot" ? argv.slice(2) : argv.slice(1);
    const { flags } = parseFlags(rest);
    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const baseUrl = getStringFlag(flags, "base-url") ?? "http://127.0.0.1:4096";
    const ensure = getBoolFlag(flags, "ensure-server", true);
    const opencodeBin = getStringFlag(flags, "opencode-bin") ?? "opencode";
    try {
      if (sub === "snapshot") {
        const sessionID = getStringFlag(flags, "session-id");
        const title = getStringFlag(flags, "title");
        const cont = sessionID === undefined && title === undefined ? true : getBoolFlag(flags, "continue", false);
        const maxRuns = getIntFlag(flags, "runs", 6);
        const maxCharsPerMessage = getIntFlag(flags, "max-chars", 1200);
        const messagesLimit = getIntFlag(flags, "messages-limit", 120);
        const includeTodos = getBoolFlag(flags, "include-todos", false);
        const res2 = await runSnapshot({
          baseUrl,
          directory,
          ensureServer: ensure,
          opencodeBin,
          sessionID,
          title,
          cont,
          maxRuns,
          maxCharsPerMessage,
          messagesLimit,
          includeTodos
        });
        printJson(res2);
        if (!res2.ok)
          process.exitCode = 1;
        return;
      }
      const { client: client3 } = await ensureServer({
        baseUrl,
        directory,
        ensure,
        opencodeBin,
        serverStartTimeoutMs: 1e4
      });
      const roots = getBoolFlag(flags, "roots", false);
      const limit = toInt(getStringFlag(flags, "limit")) ?? undefined;
      const search = getStringFlag(flags, "search");
      const res = await client3.session.list({
        directory,
        ...roots ? { roots: true } : {},
        ...typeof limit === "number" ? { limit } : {},
        ...search ? { search } : {}
      });
      if (res.error) {
        printJson({ ok: false, error: res.error });
        process.exitCode = 1;
        return;
      }
      printJson({ ok: true, sessions: res.data ?? [] });
      return;
    } catch (e) {
      printJson({
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      });
      process.exitCode = 1;
      return;
    }
  }
  if (cmd === "prompt") {
    const { flags } = parseFlags(argv.slice(1));
    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const baseUrl = getStringFlag(flags, "base-url") ?? "http://127.0.0.1:4096";
    const ensure = getBoolFlag(flags, "ensure-server", true);
    const opencodeBin = getStringFlag(flags, "opencode-bin") ?? "opencode";
    const timeoutMs = getIntFlag(flags, "timeout-ms", 20 * 60 * 1000);
    const sessionID = getStringFlag(flags, "session-id");
    const title = getStringFlag(flags, "title");
    const cont = sessionID === undefined && title === undefined ? true : getBoolFlag(flags, "continue", false);
    const agent = getStringFlag(flags, "agent") ?? "build";
    const model = getStringFlag(flags, "model");
    const variant = getStringFlag(flags, "variant");
    const permRespRaw = getStringFlag(flags, "permission-response") ?? "always";
    const permissionResponse = permRespRaw === "once" ? "once" : "always";
    const autoRejectQuestions = getBoolFlag(flags, "auto-reject-questions", true);
    const denyQuestionsOnCreate = getBoolFlag(flags, "deny-questions-on-create", true);
    const textFlag = getStringFlag(flags, "text");
    const stdinText = await readStdinText();
    const text = (textFlag ?? stdinText).trim();
    if (text.length === 0) {
      printJson({ ok: false, error: "Missing --text and no stdin provided." });
      process.exitCode = 1;
      return;
    }
    const res = await runPrompt({
      baseUrl,
      directory,
      ensureServer: ensure,
      opencodeBin,
      timeoutMs,
      permissionResponse,
      autoRejectQuestions,
      denyQuestionsOnCreate,
      sessionID,
      title,
      cont,
      agent,
      model,
      variant,
      text
    });
    printJson(res);
    if (!res.ok)
      process.exitCode = 1;
    return;
  }
  printJson({ ok: false, error: `Unknown command '${cmd}'.`, help: help() });
  process.exitCode = 1;
}
await main();
