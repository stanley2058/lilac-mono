import { $ } from "bun";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import {
  env,
  ensurePromptWorkspace,
  getCoreConfig,
  resolveCoreConfigPath,
  resolvePromptDir,
  seedCoreConfig,
} from "@stanley2058/lilac-utils";

import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";
import { chromium } from "playwright";

const bootstrapInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  overwriteConfig: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overwrite core-config.yaml if it exists"),
  overwritePrompts: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overwrite prompt files under dataDir/prompts"),
});

const playwrightInputSchema = z.object({
  withDeps: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, attempts to install OS deps via Playwright (requires root).",
    ),
});

const reloadConfigInputSchema = z.object({
  mode: z
    .enum(["cache", "restart"])
    .optional()
    .default("cache")
    .describe(
      "cache: force reload config cache; restart: exit process for supervisor restart",
    ),
});

const allInputSchema = z.object({
  dataDir: z.string().optional().describe("Override DATA_DIR for this call"),
  overwriteConfig: z.boolean().optional().default(false),
  overwritePrompts: z.boolean().optional().default(false),
  playwrightWithDeps: z.boolean().optional().default(false),
  restart: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, exits the process at the end"),
});

async function pathExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSystemChromiumExecutable(): Promise<string | null> {
  const fromEnv =
    process.env.LILAC_CHROMIUM_PATH ?? process.env.CHROMIUM_PATH ?? null;
  if (fromEnv && (await pathExecutable(fromEnv))) return fromEnv;

  const fromWhich =
    Bun.which("chromium") ??
    Bun.which("chromium-browser") ??
    Bun.which("google-chrome") ??
    Bun.which("google-chrome-stable") ??
    null;

  if (fromWhich && (await pathExecutable(fromWhich))) return fromWhich;

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of candidates) {
    if (await pathExecutable(c)) return c;
  }

  return null;
}

function isRootUser(): boolean {
  try {
    return typeof process.getuid === "function" && process.getuid() === 0;
  } catch {
    return false;
  }
}

async function ensurePlaywrightChromiumInstalled(options: {
  withDeps: boolean;
}): Promise<{ installed: boolean; executablePath: string }> {
  const pwPath = chromium.executablePath();
  const exists = await Bun.file(pwPath).exists();
  if (exists) {
    return { installed: false, executablePath: pwPath };
  }

  if (options.withDeps && !isRootUser()) {
    throw new Error(
      "Playwright --with-deps requires root. Re-run as root or omit withDeps.",
    );
  }

  if (options.withDeps) {
    await $`bunx playwright install chromium --with-deps`;
  } else {
    await $`bunx playwright install chromium`;
  }

  const nowExists = await Bun.file(pwPath).exists();
  if (!nowExists) {
    throw new Error(
      `Playwright install completed, but chromium still missing at ${pwPath}`,
    );
  }

  return { installed: true, executablePath: pwPath };
}

function scheduleRestart(): { ok: true; scheduled: true } {
  // Give the HTTP response a moment to flush.
  setTimeout(() => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(0);
    }
  }, 250);
  return { ok: true as const, scheduled: true as const };
}

export class Onboarding implements ServerTool {
  id = "onboarding";

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "onboarding.bootstrap",
        name: "Onboarding Bootstrap",
        description:
          "Bootstrap DATA_DIR (core-config.yaml + prompts/*). Hidden by default.",
        shortInput: zodObjectToCliLines(bootstrapInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(bootstrapInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.playwright",
        name: "Onboarding Playwright",
        description:
          "Ensure Chromium is available for Playwright (prefer system chromium; fallback to Playwright install). Hidden by default.",
        shortInput: zodObjectToCliLines(playwrightInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(playwrightInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.reload_tools",
        name: "Onboarding Reload Tools",
        description:
          "Reload tool instances (calls POST /reload on the local tool server). Hidden by default.",
        shortInput: [],
        input: [],
        hidden: true,
      },
      {
        callableId: "onboarding.reload_config",
        name: "Onboarding Reload Config",
        description:
          "Reload core config cache (or restart process). Hidden by default.",
        shortInput: zodObjectToCliLines(reloadConfigInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(reloadConfigInputSchema),
        hidden: true,
      },
      {
        callableId: "onboarding.restart",
        name: "Onboarding Restart",
        description:
          "Exit the process (docker/systemd should restart it). Hidden by default.",
        shortInput: [],
        input: [],
        hidden: true,
      },
      {
        callableId: "onboarding.all",
        name: "Onboarding All",
        description:
          "Run bootstrap + playwright check/install + config reload (and optional restart). Hidden by default.",
        shortInput: zodObjectToCliLines(allInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(allInputSchema),
        hidden: true,
      },
    ];
  }

  async call(callableId: string, rawInput: Record<string, unknown>) {
    if (callableId === "onboarding.bootstrap") {
      const input = bootstrapInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;

      const ensuredDirs: string[] = [];
      for (const sub of ["prompts", "skills", "secret"]) {
        const p = path.join(dataDir, sub);
        await fs.mkdir(p, { recursive: true });
        ensuredDirs.push(p);
      }

      const config = await seedCoreConfig({
        dataDir,
        overwrite: input.overwriteConfig,
      });

      const prompts = await ensurePromptWorkspace({
        dataDir,
        overwrite: input.overwritePrompts,
      });

      return {
        ok: true as const,
        dataDir,
        ensuredDirs,
        config,
        prompts,
      };
    }

    if (callableId === "onboarding.playwright") {
      const input = playwrightInputSchema.parse(rawInput);

      const systemPath = await findSystemChromiumExecutable();
      if (systemPath) {
        return {
          ok: true as const,
          strategy: "system" as const,
          executablePath: systemPath,
          installed: false,
          notes: [
            "Using system chromium.",
            "If Playwright fails to launch, try onboarding.playwright withDeps=true as root or use Playwright-managed chromium.",
          ],
        };
      }

      const pw = await ensurePlaywrightChromiumInstalled({
        withDeps: input.withDeps,
      });

      return {
        ok: true as const,
        strategy: "playwright" as const,
        executablePath: pw.executablePath,
        installed: pw.installed,
        notes: [
          "System chromium not found; using Playwright-managed chromium.",
        ],
      };
    }

    if (callableId === "onboarding.reload_tools") {
      const port = Number(env.toolServer.port ?? 8080);
      const res = await fetch(`http://127.0.0.1:${port}/reload`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(`POST /reload failed: ${res.status} ${res.statusText}`);
      }
      return { ok: true as const };
    }

    if (callableId === "onboarding.reload_config") {
      const input = reloadConfigInputSchema.parse(rawInput);

      if (input.mode === "restart") {
        return scheduleRestart();
      }

      const cfg = await getCoreConfig({ forceReload: true });
      return {
        ok: true as const,
        mode: "cache" as const,
        dataDir: env.dataDir,
        coreConfigPath: resolveCoreConfigPath(),
        promptDir: resolvePromptDir(),
        discord: {
          tokenEnv: cfg.surface.discord.tokenEnv,
          botName: cfg.surface.discord.botName,
        },
      };
    }

    if (callableId === "onboarding.restart") {
      return scheduleRestart();
    }

    if (callableId === "onboarding.all") {
      const input = allInputSchema.parse(rawInput);
      const dataDir = input.dataDir ?? env.dataDir;

      const bootstrap = (await this.call("onboarding.bootstrap", {
        dataDir,
        overwriteConfig: input.overwriteConfig,
        overwritePrompts: input.overwritePrompts,
      })) as unknown;

      const playwright = (await this.call("onboarding.playwright", {
        withDeps: input.playwrightWithDeps,
      })) as unknown;

      const reloadConfig = (await this.call("onboarding.reload_config", {
        mode: "cache",
      })) as unknown;

      const restart = input.restart ? scheduleRestart() : undefined;

      return {
        ok: true as const,
        bootstrap,
        playwright,
        reloadConfig,
        restart,
      };
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }
}
