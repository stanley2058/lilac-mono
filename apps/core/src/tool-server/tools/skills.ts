import { z } from "zod";
import { Fzf } from "fzf";
import { Panic, Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import {
  discoverSkills,
  parseSkillMarkdownResult,
  type DiscoveredSkill,
  env,
} from "@stanley2058/lilac-utils";
import { preserveToolPanic } from "../../tools/tool-result-adapters";
import { requestInvocationCwd } from "../request-invocation-cwd";

function skillDiscoveryCwd(opts: ServerToolCallOptions | undefined): string {
  const context = opts?.context;
  if (!context) return process.cwd();
  return requestInvocationCwd(context) ?? context.cwd ?? process.cwd();
}

function skillsFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `skills_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

const listInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Search query (fuzzy-matched against name/description/source)"),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Max results (default: 50)")
    .default(50),
  sources: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value : [value];
    })
    .describe(
      'Optional source filter(s), e.g. --sources=lilac-data or --sources:json=["lilac-data","claude-project"].',
    ),
});

const readInputSchema = z.object({
  name: z.string().min(1).describe("Skill name"),
});

function scoreAndFilter(
  skills: DiscoveredSkill[],
  queryRaw: string | undefined,
  limit: number,
): DiscoveredSkill[] {
  const query = queryRaw?.trim();
  if (!query) return skills.slice(0, limit);

  // Use Fzf for fuzzy ranking.
  const fzf = new Fzf(skills, {
    selector: (s) => `${s.name} ${s.description} ${s.source}`,
  });

  return fzf
    .find(query)
    .slice(0, limit)
    .map((r) => r.item);
}

function requireSkillByName(
  skills: DiscoveredSkill[],
  name: string,
): ResultType<DiscoveredSkill, ServerToolFailure> {
  const found = skills.find((s) => s.name === name);
  if (!found) {
    return Result.err(
      skillsFailure(
        "not_found",
        `Skill not found: '${name}'. Use skills.list to see available skills.`,
      ),
    );
  }
  return Result.ok(found);
}

async function loadSkillsForToolHost(
  cwd: string,
): Promise<ResultType<Awaited<ReturnType<typeof discoverSkills>>, ServerToolFailure>> {
  return Result.gen(async function* () {
    const discovered = yield* Result.await(
      Result.tryPromise({
        try: () => discoverSkills({ workspaceRoot: cwd, dataDir: env.dataDir }),
        catch: (cause) => ({ cause }),
      }).then((result) =>
        result.mapError(({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return skillsFailure(
            "unavailable",
            cause instanceof Error ? cause.message : "Skill discovery failed",
          );
        }),
      ),
    );
    return Result.ok(discovered);
  });
}

async function readSkillForToolHost(
  input: z.output<typeof readInputSchema>,
  cwd: string,
): Promise<ServerToolResult> {
  return Result.gen(async function* () {
    const { skills } = yield* Result.await(loadSkillsForToolHost(cwd));
    const found = yield* requireSkillByName(skills, input.name);
    const raw = yield* Result.await(
      Result.tryPromise({
        try: () => Bun.file(found.location).text(),
        catch: (cause) => ({ cause }),
      }).then((result) =>
        result.mapError(({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return skillsFailure(
            typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
              ? "not_found"
              : "unavailable",
            cause instanceof Error ? cause.message : "Skill could not be read",
          );
        }),
      ),
    );
    const parsed = yield* parseSkillMarkdownResult(raw).mapError((error) =>
      skillsFailure("unavailable", error.message),
    );
    return Result.ok({
      path: found.location,
      length: raw.length,
      metadata: parsed.frontmatter,
      content: raw,
    });
  });
}

export class Skills implements ServerTool {
  private readonly tool = defineServerTool({
    id: "skills",
    callables: ({ callable }) => ({
      "skills.list": callable({
        name: "Skills List",
        description: "List and search skills discovered from common directories.",
        inputSchema: listInputSchema,
        validation: "zod",
        primaryPositional: "query",
        async run(input, opts) {
          return (await loadSkillsForToolHost(skillDiscoveryCwd(opts))).map(
            ({ skills, warnings }) => {
              let filtered = skills;
              if (input.sources && input.sources.length > 0) {
                const allowed = new Set(input.sources);
                filtered = filtered.filter((skill) => allowed.has(skill.source));
              }

              const ranked = scoreAndFilter(filtered, input.query, input.limit);
              return {
                skills: ranked.map((skill) => ({
                  name: skill.name,
                  description: skill.description,
                  source: skill.source,
                  location: skill.location,
                })),
                warnings,
              };
            },
          );
        },
      }),
      "skills.read": callable({
        name: "Skills Read",
        description:
          "Read a complete SKILL.md. Returns path, length in characters, metadata, and full file content.",
        inputSchema: readInputSchema,
        validation: "zod",
        primaryPositional: "name",
        run: (input, opts) => readSkillForToolHost(input, skillDiscoveryCwd(opts)),
      }),
    }),
  });

  get id(): string {
    return this.tool.id;
  }

  init(): Promise<void> {
    return this.tool.init();
  }

  destroy(): Promise<void> {
    return this.tool.destroy();
  }

  list() {
    return this.tool.list();
  }

  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, input, opts);
  }
}
