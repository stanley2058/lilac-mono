import { Result } from "better-result";
import { z } from "zod";
import { failure } from "./contracts";

const mountPath = z
  .string()
  .startsWith("/")
  .refine((value) => ![",", "\r", "\n", "\0"].some((character) => value.includes(character)));
const mountSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("volume"),
    source: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u),
    target: mountPath,
    read_only: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal("bind"),
    source: mountPath,
    target: mountPath,
    read_only: z.boolean().default(false),
  }),
]);
const templateSchema = z
  .strictObject({
    image: z
      .string()
      .min(1)
      .regex(/^[^\s-][^\s]*$/u)
      .refine((value) => !value.includes("\0"))
      .optional(),
    environment: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
          .refine((key) => key !== "VNC_PW"),
        z.string().refine((value) => !value.includes("\0")),
      )
      .default({}),
    mounts: z.array(mountSchema).default([]),
  })
  .refine(
    (template) =>
      new Set(template.mounts.map((mount) => mount.target)).size === template.mounts.length,
  );

export type RunnerTemplate = z.infer<typeof templateSchema>;

export function decodeRunnerTemplate(source: string) {
  return Result.gen(function* () {
    const raw: unknown = yield* Result.try({
      try: () => Bun.YAML.parse(source),
      catch: () => failure("invalid", "Runner template is not valid YAML"),
    });
    const parsed = templateSchema.safeParse(raw);
    if (!parsed.success) return Result.err(failure("invalid", "Invalid runner template fields"));
    return Result.ok(parsed.data);
  });
}

export async function loadRunnerTemplate(path?: string) {
  if (path === undefined)
    return Result.ok({ environment: {}, mounts: [] } satisfies RunnerTemplate);
  return Result.gen(async function* () {
    const source = yield* Result.await(
      Result.tryPromise({
        try: () => Bun.file(path).text(),
        catch: () => failure("invalid", "Cannot read runner template"),
      }),
    );
    return decodeRunnerTemplate(source);
  });
}

export function runnerTemplateArgs(template: RunnerTemplate): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(template.environment)) {
    args.push("--env", `${key}=${value}`);
  }
  for (const mount of template.mounts) {
    const readOnly = mount.read_only ? ",readonly" : "";
    args.push(
      "--mount",
      `type=${mount.type},source=${mount.source},target=${mount.target}${readOnly}`,
    );
  }
  return args;
}
