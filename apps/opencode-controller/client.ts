import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createOpencodeClient,
  type AssistantMessage,
  type Message,
  type Part,
  type PermissionRule,
  type Session,
} from "@opencode-ai/sdk/v2";

declare const PACKAGE_VERSION: string;

type PermissionAutoResponse = "once" | "always";

type PromptResult = {
  ok: boolean;
  sessionID: string;
  userMessageID: string;
  assistant?: {
    messageID: string;
    text: string;
    error?: unknown;
    modelID?: string;
    providerID?: string;
    agent?: string;
    tokens?: unknown;
    cost?: number;
    finish?: string;
  };
  events: {
    permissionsAutoApproved: number;
    permissionsAutoFailed: number;
    questionsAutoRejected: number;
  };
  meta: {
    directory: string;
    baseUrl: string;
    agent?: string;
    model?: string;
    variant?: string;
    timeoutMs: number;
    ensureServer: boolean;
  };
  error?: unknown;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function toInt(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === "string" && x.trim().length > 0) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function toBool(x: unknown): boolean | null {
  if (typeof x === "boolean") return x;
  if (typeof x === "string") {
    const v = x.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return null;
}

function parseFlags(args: readonly string[]): {
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
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

function getStringFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function getBoolFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: boolean,
): boolean {
  const v = flags[key];
  if (v === undefined) return defaultValue;
  if (typeof v === "boolean") return v;
  const parsed = toBool(v);
  return parsed ?? defaultValue;
}

function getIntFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: number,
): number {
  const v = flags[key];
  if (v === undefined) return defaultValue;
  const parsed = toInt(v);
  return parsed ?? defaultValue;
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printJson(obj: unknown) {
  process.stdout.write(JSON.stringify(obj));
  process.stdout.write("\n");
}

function parseModelSpec(spec: string): { providerID: string; modelID: string } {
  const idx = spec.indexOf("/");
  if (idx === -1) {
    throw new Error(
      `Invalid --model '${spec}'. Expected 'provider/model' (e.g. 'anthropic/claude-sonnet-4-20250514').`,
    );
  }
  const providerID = spec.slice(0, idx).trim();
  const modelID = spec.slice(idx + 1).trim();
  if (!providerID || !modelID) {
    throw new Error(
      `Invalid --model '${spec}'. Expected 'provider/model' (non-empty provider and model).`,
    );
  }
  return { providerID, modelID };
}

function denyQuestionsRuleset(): PermissionRule[] {
  return [{ permission: "question", pattern: "*", action: "deny" }];
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ensureServer(params: {
  baseUrl: string;
  directory: string;
  ensure: boolean;
  opencodeBin: string;
  serverStartTimeoutMs: number;
}): Promise<{
  client: ReturnType<typeof createOpencodeClient>;
  started: boolean;
}> {
  const client = createOpencodeClient({
    baseUrl: params.baseUrl,
    directory: params.directory,
  });

  const healthOk = await (async () => {
    try {
      const res = await client.global.health();
      return Boolean(res.data?.healthy) && !res.error;
    } catch {
      return false;
    }
  })();

  if (healthOk) return { client, started: false };
  if (!params.ensure) {
    throw new Error(
      `OpenCode server is not reachable at ${params.baseUrl} (and --no-ensure-server was set).`,
    );
  }

  const u = new URL(params.baseUrl);
  const hostname = u.hostname || "127.0.0.1";
  const port = u.port ? Number(u.port) : 4096;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid base URL port in ${params.baseUrl}`);
  }

  const child = spawn(
    params.opencodeBin,
    ["serve", "--hostname", hostname, "--port", String(port)],
    {
      stdio: "ignore",
      detached: true,
      env: process.env,
    },
  );

  let spawnError: string | null = null;
  child.once("error", (err: unknown) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < params.serverStartTimeoutMs) {
    if (spawnError !== null) {
      throw new Error(
        `Failed to spawn '${params.opencodeBin} serve': ${spawnError}`,
      );
    }
    try {
      const res = await client.global.health();
      if (res.data?.healthy && !res.error) return { client, started: true };
    } catch {
      // Keep polling.
    }
    await sleep(200);
  }

  throw new Error(
    `Started '${params.opencodeBin} serve' but server did not become healthy at ${params.baseUrl} within ${params.serverStartTimeoutMs}ms.`,
  );
}

async function selectSession(params: {
  client: ReturnType<typeof createOpencodeClient>;
  directory: string;
  sessionID?: string;
  title?: string;
  cont: boolean;
  denyQuestionsOnCreate: boolean;
}): Promise<{ session: Session; created: boolean }> {
  const { client } = params;

  if (params.sessionID) {
    const res = await client.session.get({ sessionID: params.sessionID });
    if (res.error || !res.data) {
      throw new Error(
        `Failed to load session '${params.sessionID}': ${JSON.stringify(res.error)}`,
      );
    }
    return { session: res.data, created: false };
  }

  if (params.title) {
    const list = await client.session.list({
      directory: params.directory,
      roots: true,
      search: params.title,
      limit: 50,
    });

    if (list.error) {
      throw new Error(
        `Failed to list sessions for title lookup: ${JSON.stringify(list.error)}`,
      );
    }

    const sessions = Array.isArray(list.data) ? list.data : [];
    const found = sessions.find((s) => s.title === params.title);
    if (found) return { session: found, created: false };

    const createRes = await client.session.create({
      title: params.title,
      ...(params.denyQuestionsOnCreate
        ? { permission: denyQuestionsRuleset() }
        : {}),
    });
    if (createRes.error || !createRes.data) {
      throw new Error(
        `Failed to create session '${params.title}': ${JSON.stringify(createRes.error)}`,
      );
    }
    return { session: createRes.data, created: true };
  }

  if (params.cont) {
    const list = await client.session.list({
      directory: params.directory,
      roots: true,
      limit: 1,
    });
    if (list.error) {
      throw new Error(
        `Failed to list sessions for --continue: ${JSON.stringify(list.error)}`,
      );
    }
    const s = Array.isArray(list.data) ? list.data[0] : undefined;
    if (s) return { session: s, created: false };
  }

  const createRes = await client.session.create({
    ...(params.denyQuestionsOnCreate
      ? { permission: denyQuestionsRuleset() }
      : {}),
  });
  if (createRes.error || !createRes.data) {
    throw new Error(
      `Failed to create session: ${JSON.stringify(createRes.error)}`,
    );
  }
  return { session: createRes.data, created: true };
}

function pickAssistantText(parts: readonly Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p.ignored ? "" : p.text))
    .filter((s) => s.length > 0)
    .join("");
}

function findAssistantMessageForUserMessage(params: {
  userMessageID: string;
  messages: Array<{ info: Message; parts: Part[] }>;
}): { info: AssistantMessage; parts: Part[] } | null {
  let best: { info: AssistantMessage; parts: Part[] } | null = null;
  let bestCreated = -1;

  for (const m of params.messages) {
    if (m.info.role !== "assistant") continue;
    const parentID = m.info.parentID;
    if (parentID !== params.userMessageID) continue;

    const created =
      typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    if (!best || created >= bestCreated) {
      best = { info: m.info, parts: m.parts };
      bestCreated = created;
    }
  }

  return best;
}

async function runPrompt(params: {
  baseUrl: string;
  directory: string;
  ensureServer: boolean;
  opencodeBin: string;
  timeoutMs: number;
  permissionResponse: PermissionAutoResponse;
  autoRejectQuestions: boolean;
  denyQuestionsOnCreate: boolean;
  sessionID?: string;
  title?: string;
  cont: boolean;
  agent?: string;
  model?: string;
  variant?: string;
  text: string;
}): Promise<PromptResult> {
  const out: PromptResult = {
    ok: false,
    sessionID: "",
    userMessageID: "",
    events: {
      permissionsAutoApproved: 0,
      permissionsAutoFailed: 0,
      questionsAutoRejected: 0,
    },
    meta: {
      directory: params.directory,
      baseUrl: params.baseUrl,
      agent: params.agent,
      model: params.model,
      variant: params.variant,
      timeoutMs: params.timeoutMs,
      ensureServer: params.ensureServer,
    },
  };

  let sessionError: unknown | undefined;

  try {
    const ensured = await ensureServer({
      baseUrl: params.baseUrl,
      directory: params.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 10_000,
    });

    const client = ensured.client;

    const { session } = await selectSession({
      client,
      directory: params.directory,
      sessionID: params.sessionID,
      title: params.title,
      cont: params.cont,
      denyQuestionsOnCreate: params.denyQuestionsOnCreate,
    });

    out.sessionID = session.id;

    const userMessageID = `lilac_${randomUUID()}`;
    out.userMessageID = userMessageID;

    const sse = new AbortController();
    const events = await client.event.subscribe(
      { directory: params.directory },
      { signal: sse.signal },
    );

    const respondedPermissions = new Set<string>();
    const respondedQuestions = new Set<string>();
    let promptSent = false;
    let sawBusyAfterPrompt = false;
    const sentAt = Date.now();

    const closeEvents = () => {
      try {
        sse.abort();
      } catch {
        // Ignore.
      }
    };

    const done = (async () => {
      for await (const event of events.stream) {
        if (event.type === "permission.asked") {
          const perm = event.properties;
          if (perm?.sessionID !== session.id) continue;
          const permId = typeof perm?.id === "string" ? perm.id : null;
          if (!permId) continue;
          if (respondedPermissions.has(permId)) continue;
          respondedPermissions.add(permId);

          try {
            await client.permission.reply({
              requestID: permId,
              reply: params.permissionResponse,
            });
            out.events.permissionsAutoApproved++;
          } catch (e) {
            out.events.permissionsAutoFailed++;
            // Keep going; session may surface an error later.
          }
          continue;
        }

        if (event.type === "question.asked") {
          if (!params.autoRejectQuestions) continue;
          const q = event.properties;
          if (q?.sessionID !== session.id) continue;
          const requestID = typeof q?.id === "string" ? q.id : null;
          if (!requestID) continue;
          if (respondedQuestions.has(requestID)) continue;
          respondedQuestions.add(requestID);
          try {
            await client.question.reject({ requestID });
            out.events.questionsAutoRejected++;
          } catch {
            // Ignore.
          }
          continue;
        }

        if (event.type === "session.status") {
          const p = event.properties;
          if (p?.sessionID !== session.id) continue;
          if (!promptSent) continue;
          if (p?.status?.type === "busy") sawBusyAfterPrompt = true;
          continue;
        }

        if (event.type === "session.error") {
          const p = event.properties;
          if (p?.sessionID !== session.id) continue;
          sessionError = p?.error ?? p;
          throw new Error("OpenCode session.error");
        }

        if (event.type === "session.idle") {
          const p = event.properties;
          if (p?.sessionID !== session.id) continue;
          if (!promptSent) continue;

          // If we haven't observed any busy status, wait a short grace period.
          if (!sawBusyAfterPrompt && Date.now() - sentAt < 500) continue;
          return;
        }
      }
    })();

    promptSent = true;

    const model = params.model ? parseModelSpec(params.model) : undefined;

    const accepted = await client.session.promptAsync({
      sessionID: session.id,
      messageID: userMessageID,
      agent: params.agent ?? "build",
      ...(model ? { model } : {}),
      ...(params.variant ? { variant: params.variant } : {}),
      parts: [{ type: "text", text: params.text }],
    });
    if (accepted.error) {
      closeEvents();
      throw new Error(
        `OpenCode prompt_async rejected: ${JSON.stringify(accepted.error)}`,
      );
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        closeEvents();
        client.session.abort({ sessionID: session.id }).catch(() => {});
        reject(
          new Error(
            `Timeout waiting for session.idle after ${params.timeoutMs}ms`,
          ),
        );
      }, params.timeoutMs);
      // Avoid keeping the process alive.
      t.unref?.();
    });

    await Promise.race([done, timeoutPromise]);
    closeEvents();

    const msgs = await client.session.messages({
      sessionID: session.id,
      limit: 200,
    });
    if (msgs.error || !msgs.data) {
      throw new Error(
        `Failed to fetch session messages: ${JSON.stringify(msgs.error)}`,
      );
    }

    const match = findAssistantMessageForUserMessage({
      userMessageID,
      messages: msgs.data,
    });

    if (!match) {
      throw new Error(
        `Could not find assistant message for user message '${userMessageID}'.`,
      );
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
      finish: match.info.finish,
    };

    out.ok = match.info.error === undefined;
    if (!out.ok) out.error = match.info.error;
    return out;
  } catch (e) {
    out.ok = false;
    out.error =
      sessionError ?? (isRecord(e) && "message" in e ? e.message : String(e));
    return out;
  }
}

function help(): string {
  return [
    "lilac-opencode (OpenCode controller)",
    "",
    "Usage:",
    "  lilac-opencode sessions list [--directory <path>] [--roots] [--limit <n>] [--search <term>] [--base-url <url>] [--no-ensure-server]",
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
    "Notes:",
    "  - Output is always JSON.",
    "  - If --text is omitted and stdin is piped, stdin is used as the message.",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help")) {
    printJson({ ok: true, help: help(), version: PACKAGE_VERSION });
    return;
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    printJson({ ok: true, version: PACKAGE_VERSION });
    return;
  }

  const cmd = argv[0] ?? "";

  if (cmd === "sessions") {
    const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "list";
    const rest = sub === "list" ? argv.slice(2) : argv.slice(1);
    const { flags } = parseFlags(rest);

    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const baseUrl = getStringFlag(flags, "base-url") ?? "http://127.0.0.1:4096";
    const ensure = getBoolFlag(flags, "ensure-server", true);
    const opencodeBin = getStringFlag(flags, "opencode-bin") ?? "opencode";

    try {
      const { client } = await ensureServer({
        baseUrl,
        directory,
        ensure,
        opencodeBin,
        serverStartTimeoutMs: 10_000,
      });
      const roots = getBoolFlag(flags, "roots", false);
      const limit = toInt(getStringFlag(flags, "limit")) ?? undefined;
      const search = getStringFlag(flags, "search");

      const res = await client.session.list({
        directory,
        ...(roots ? { roots: true } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(search ? { search } : {}),
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
        error: e instanceof Error ? e.message : String(e),
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
    const cont =
      sessionID === undefined && title === undefined
        ? true
        : getBoolFlag(flags, "continue", false);

    const agent = getStringFlag(flags, "agent") ?? "build";
    const model = getStringFlag(flags, "model");
    const variant = getStringFlag(flags, "variant");

    const permRespRaw = getStringFlag(flags, "permission-response") ?? "always";
    const permissionResponse: PermissionAutoResponse =
      permRespRaw === "once" ? "once" : "always";

    const autoRejectQuestions = getBoolFlag(
      flags,
      "auto-reject-questions",
      true,
    );
    const denyQuestionsOnCreate = getBoolFlag(
      flags,
      "deny-questions-on-create",
      true,
    );

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
      text,
    });

    printJson(res);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printJson({ ok: false, error: `Unknown command '${cmd}'.`, help: help() });
  process.exitCode = 1;
}

await main();
