import type { NativeRuntimeOptions } from "../../../src/surface/native/runtime";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createNativeIntegrationFixture, nativeFixtureTextResponse } from "./integration-fixture";
import { seedNativeBrowserFixture } from "./browser-seed";

const HTML_PREVIEW_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>';

// A CDN chart library, a local image the snapshot inlines, and the theme variables.
const HTML_PREVIEW_PAGE = `<!doctype html>
<html>
  <head>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
    <style>
      header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      header img { width: 20px; height: 20px; }
      h4 { margin: 0; font-weight: 600; }
      .stats { display: flex; gap: 12px; margin-top: 12px; }
      .stat { flex: 1; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius); }
      .stat b { display: block; font-size: 18px; }
      .stat span { color: var(--muted-foreground); font-size: 12px; }
    </style>
  </head>
  <body>
    <header><img src="./runner.svg" alt="" /><h4>Runs this week</h4></header>
    <div style="height: 220px"><canvas id="runs"></canvas></div>
    <div class="stats">
      <div class="stat"><b>312</b><span>Total runs</span></div>
      <div class="stat" style="color: var(--success)"><b>97.4%</b><span>Succeeded</span></div>
      <div class="stat"><b>81</b><span>Busiest day</span></div>
    </div>
    <script>
      const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const chart = new Chart(document.getElementById("runs"), {
        type: "bar",
        data: {
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          datasets: [{ data: [42, 68, 55, 81, 34, 18, 14], borderRadius: 6 }],
        },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
      function paint() {
        chart.data.datasets[0].backgroundColor = css("--chart-1");
        chart.options.scales.x.ticks.color = css("--muted-foreground");
        chart.options.scales.y.ticks.color = css("--muted-foreground");
        chart.options.scales.x.grid.color = "transparent";
        chart.options.scales.y.grid.color = css("--border");
        chart.update();
      }
      paint();
      new MutationObserver(paint).observe(document.getElementById("lilac-theme"), {
        childList: true,
        characterData: true,
        subtree: true,
      });
    </script>
  </body>
</html>
`;

const fixtureQuestions = [
  {
    id: "target",
    header: "Deploy target",
    question: "Where should I deploy the preview build?",
    options: [
      {
        id: "link",
        label: "Preview link",
        description: "Create an isolated link that expires in 7 days.",
      },
      {
        id: "staging",
        label: "Staging",
        description: "Replace the shared staging build. Teammates see it right away.",
      },
    ],
  },
  {
    id: "database",
    header: "Database",
    question: "Which data should the preview use?",
    options: [
      {
        id: "snapshot",
        label: "Nightly snapshot",
        description: "Copy last night's data with personal fields removed.",
      },
      { id: "empty", label: "Empty", description: "Start with the schema and fixture users only." },
      {
        id: "replica",
        label: "Read replica",
        description: "Read live production data. Writes stay disabled.",
      },
    ],
  },
  {
    id: "notify",
    header: "Notify",
    question: "Who should get the preview link?",
    options: [
      { id: "me", label: "Just me", description: "Send the link only to you." },
      { id: "team", label: "Team channel", description: "Post the link in #web-previews." },
    ],
  },
];

// Question replies use the ordinary input path with their original prompt context.
async function fixtureStream({ prompt }: Parameters<MockLanguageModelV4["doStream"]>[0]) {
  const last = prompt.at(-1);
  if (last?.role === "tool") return nativeFixtureTextResponse("NO_REPLY");
  const request = JSON.stringify(prompt.findLast((item) => item.role === "user"));
  if (request.includes("question_result") || request.includes("Reply to question "))
    return nativeFixtureTextResponse("Thanks. I'll continue with those choices.");
  if (/ask me/iu.test(request))
    return {
      stream: simulateReadableStream({
        chunks: [
          {
            type: "tool-call" as const,
            toolCallId: `ask_${crypto.randomUUID()}`,
            toolName: "question",
            input: JSON.stringify({
              questions: /one question/iu.test(request)
                ? fixtureQuestions.slice(0, 1)
                : fixtureQuestions,
            }),
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          },
        ],
      }),
    };
  return nativeFixtureTextResponse(
    /html preview/iu.test(request)
      ? "Here is this week's run summary.\n\n```html-preview-file\nhtml-preview/weekly-runs.html\n```\n\nThursday had the most runs."
      : "Fixture response.\n\nReady for the next message.",
  );
}

export const browserFixtureParticipant = {
  username: "participant",
  password: "native-participant-password",
};

export type BrowserFixtureClerkAuth = {
  secretKey: string;
  publishableKey: string;
  issuer: string;
  ownerProviderUserId: string;
  oauthClientId?: string;
};

export async function startNativeBrowserFixture(
  mcpRegistry?: NativeRuntimeOptions["mcpRegistry"],
  options: { port?: number; webOrigins?: string[]; clerk?: BrowserFixtureClerkAuth } = {},
) {
  const port = options.port ?? Number(process.env.TEST_NATIVE_PORT ?? 8789);
  const clerk = options.clerk;
  let threads: ReturnType<typeof seedNativeBrowserFixture> | undefined;
  const fixture = await createNativeIntegrationFixture({
    mcpRegistry,
    // Prompts that mention an HTML preview get a reply with a saved chart page.
    model: new MockLanguageModelV4({ modelId: "native-fixture", doStream: fixtureStream }),
    questions: true,
    port,
    allowedOrigins: [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(options.webOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"]),
    ],
    ...(clerk
      ? {
          installationSecrets: {
            clerkSecretKey: clerk.secretKey,
            clerkPublishableKey: clerk.publishableKey,
          },
          publishableKey: clerk.publishableKey,
        }
      : {
          password: process.env.TEST_NATIVE_PASSWORD ?? "native-fixture-password",
          additionalLocalUsers: [
            {
              userId: "participant",
              ...browserFixtureParticipant,
              sessionLifetimeSeconds: 60,
            },
          ],
        }),
    seed(store, transcript, database) {
      threads = seedNativeBrowserFixture(store, { transcript, database });
    },
    async prepare({ workspaceRoot, dataDir, config }) {
      config.configVersion = 3;
      config.models.catalog = {
        providers: {
          openai: "enabled",
          codex: "enabled",
          "claude-code": "enabled",
          vercel: "enabled",
        },
      };
      if (clerk) {
        config.surface.native.installationId = "native-clerk-browser-fixture";
        config.surface.native.publicUrl = `http://localhost:${port}`;
        config.surface.native.auth = {
          provider: "clerk",
          ownerId: "owner",
          ownerProviderUserId: clerk.ownerProviderUserId,
          clerkIssuer: clerk.issuer,
          ...(clerk.oauthClientId ? { clerkOAuthClientId: clerk.oauthClientId } : {}),
        };
      }
      await mkdir(path.join(workspaceRoot, "html-preview"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "html-preview", "runner.svg"), HTML_PREVIEW_ICON);
      await writeFile(
        path.join(workspaceRoot, "html-preview", "weekly-runs.html"),
        HTML_PREVIEW_PAGE,
      );
      await writeFile(
        path.join(workspaceRoot, "example.md"),
        "# File viewer\n\n> [!NOTE]\n> Preview uses the chat renderer.\n\n```ts\nexport const ready = true;\n```\n",
      );
      await writeFile(
        path.join(workspaceRoot, "example.ts"),
        Array.from(
          { length: 180 },
          (_, index) =>
            `export const item${index + 1} = "A long line that wraps naturally in the narrow file viewer without stretching the panel.";`,
        ).join("\n"),
      );
      config.models.def["fixture-fast"] = {
        model: "openai/native-fixture-fast",
        comment: "Fast deterministic response",
      };
      config.models.def["fixture-deep"] = {
        model: "openai/native-fixture-deep",
        comment: "Alternate deterministic response",
      };
      config.models.main = { model: "fixture-fast" };
      for (const [name, description] of [
        ["review", "Review changes for correctness and missing tests"],
        ["explain", "Explain a module using a diagram and short examples"],
      ]) {
        const directory = path.join(workspaceRoot, ".agents", "skills", name!);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the supplied user request and report a concise result.\n`,
        );
      }
      const commandDirectory = path.join(dataDir, "cmds", "fixture-status");
      await mkdir(commandDirectory, { recursive: true });
      await writeFile(
        path.join(commandDirectory, "def.json"),
        JSON.stringify({
          name: "fixture-status",
          description: "Show deterministic browser fixture status",
          args: [],
        }),
      );
      await writeFile(
        path.join(commandDirectory, "index.ts"),
        'export function execute() { return { type: "text", value: "The isolated browser fixture is ready." }; }\n',
      );
    },
  });
  if (!threads) throw new Error("Browser fixture data was not seeded");
  const links = Object.fromEntries(
    Object.entries(threads)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, threadId]) => [name, `${fixture.url}?thread=${encodeURIComponent(threadId)}`]),
  );
  return { ...fixture, threads, links };
}

if (import.meta.main) {
  const fixture = await startNativeBrowserFixture();
  console.info(
    JSON.stringify(
      {
        kind: "native-browser-fixture-ready",
        url: fixture.url,
        username: fixture.username,
        links: fixture.links,
        historyTurns: fixture.threads.historyTurns,
      },
      null,
      2,
    ),
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void fixture.close().then(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
