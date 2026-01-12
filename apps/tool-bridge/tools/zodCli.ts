import { z } from "zod";

export type CliLineMode = "all" | "required";

type Condition = {
  discriminator: string;
  values: unknown[];
};

type Variant = {
  condition: Condition | null;
  shape: Record<string, z.ZodTypeAny>;
};

type FieldOccurrence = {
  key: string;
  schema: z.ZodTypeAny;
  meta: {
    base: z.ZodTypeAny;
    isOptional: boolean;
    hasDefault: boolean;
    defaultValue: unknown;
  };
  condition: Condition | null;
  description: string;
};

export function zodObjectToCliLines(
  schema: z.ZodTypeAny,
  { mode = "all" }: { mode?: CliLineMode } = {},
): string[] {
  const variants = collectVariants(schema);
  if (!variants.length) return [];

  const orderedKeys: string[] = [];
  const seenKeys = new Set<string>();
  const occurrencesByKey = new Map<string, FieldOccurrence[]>();

  for (const variant of variants) {
    for (const [key, fieldSchema] of Object.entries(variant.shape)) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        orderedKeys.push(key);
      }

      const meta = unwrapModifiers(fieldSchema, { key });
      const description =
        fieldSchema.description?.trim().replace(/\s+/g, " ") ||
        meta.base.description?.trim().replace(/\s+/g, " ") ||
        "";

      const occ: FieldOccurrence = {
        key,
        schema: fieldSchema,
        meta,
        condition: variant.condition,
        description,
      };

      const list = occurrencesByKey.get(key);
      if (list) list.push(occ);
      else occurrencesByKey.set(key, [occ]);
    }
  }

  const lines: string[] = [];

  for (const key of orderedKeys) {
    const occurrences = occurrencesByKey.get(key) ?? [];

    if (mode === "required") {
      // "required" means: keep only flags that are required in at least one
      // variant (and not defaulted).
      const hasRequiredOccurrence = occurrences.some(
        (o) => !o.meta.isOptional && !o.meta.hasDefault,
      );
      if (!hasRequiredOccurrence) continue;
    }

    const line = formatAggregatedFieldLine(key, occurrences, {
      variantsCount: variants.length,
    });
    if (line) lines.push(line);
  }

  return lines;
}

function formatAggregatedFieldLine(
  key: string,
  occurrences: FieldOccurrence[],
  { variantsCount }: { variantsCount: number },
): string | null {
  const flag = `--${toKebabCase(key)}`;

  const typeStr = unionTypeString(occurrences.map((o) => o.meta.base));

  const description = occurrences.find((o) => o.description)?.description ?? "";

  const appearsInAllVariants = occurrences.length === variantsCount;
  const requiredInAllVariants =
    appearsInAllVariants && occurrences.every((o) => !o.meta.isOptional);

  const requiredWhen = new Set<string>();
  if (!requiredInAllVariants) {
    for (const occ of occurrences) {
      if (occ.meta.isOptional) continue;
      if (!occ.condition) continue;
      requiredWhen.add(conditionToText(occ.condition));
    }
  }

  const modifiers: string[] = [];

  // Only label "Optional" when it's not a conditional-required field.
  const isConditionalRequired = requiredWhen.size > 0;
  const isOptionalOverall =
    !requiredInAllVariants &&
    (occurrences.some((o) => o.meta.isOptional) || !appearsInAllVariants);

  if (isOptionalOverall && !isConditionalRequired) {
    modifiers.push("Optional");
  }

  const defaults = occurrences
    .filter((o) => o.meta.hasDefault)
    .map((o) => formatValue(o.meta.defaultValue));
  if (defaults.length && defaults.every((d) => d === defaults[0])) {
    modifiers.push(`Default: ${defaults[0]}`);
  }

  if (requiredWhen.size) {
    modifiers.push(`Required when ${Array.from(requiredWhen).join(" or ")}`);
  }

  const modifiersSuffix = modifiers.length ? ` (${modifiers.join("; ")})` : "";
  const head = `\`${flag}\`: \`${typeStr}\`${modifiersSuffix}`;

  return description ? `${head} | ${description}` : head;
}

function collectVariants(schema: z.ZodTypeAny): Variant[] {
  const unwrapped = unwrapStructural(schema);
  const def = (unwrapped as any).def as { type?: string } | undefined;

  switch (def?.type) {
    case "object": {
      return [{ condition: null, shape: getObjectShape(unwrapped) }];
    }

    case "intersection": {
      const leftVariants = collectVariants((def as any).left);
      const rightVariants = collectVariants((def as any).right);

      const merged: Variant[] = [];
      for (const l of leftVariants) {
        for (const r of rightVariants) {
          merged.push({
            condition: mergeConditions(l.condition, r.condition),
            shape: mergeShapes(l.shape, r.shape),
          });
        }
      }
      return merged;
    }

    case "union": {
      const options = (def as any).options as z.ZodTypeAny[] | undefined;
      if (!options?.length) return [];

      const discriminator = (def as any).discriminator as string | undefined;
      if (discriminator) {
        // Zod v4 models discriminated unions as `type: "union"` with
        // `{ discriminator, options }`.
        const variants: Variant[] = [];
        for (const option of options) {
          const optionUnwrapped = unwrapStructural(option);
          const optionDef = (optionUnwrapped as any).def as
            | { type?: string }
            | undefined;

          if (optionDef?.type !== "object") {
            variants.push(...collectVariants(option));
            continue;
          }

          const shape = getObjectShape(optionUnwrapped);
          const discriminatorSchema = shape[discriminator];
          const values = discriminatorSchema
            ? extractLiteralValues(discriminatorSchema)
            : [];

          const condition: Condition | null = values.length
            ? { discriminator, values }
            : null;

          for (const variant of collectVariants(option)) {
            variants.push({
              condition: mergeConditions(condition, variant.condition),
              shape: variant.shape,
            });
          }
        }

        return variants;
      }

      return options.flatMap((opt) => collectVariants(opt));
    }

    default:
      throw new Error(
        `Unsupported schema for CLI lines: ${(def as any)?.type ?? "unknown"}. Expected object/union/intersection.`,
      );
  }
}

function mergeShapes(
  a: Record<string, z.ZodTypeAny>,
  b: Record<string, z.ZodTypeAny>,
): Record<string, z.ZodTypeAny> {
  const out: Record<string, z.ZodTypeAny> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (!out[key]) {
      out[key] = value;
      continue;
    }

    // If two intersections define the same key, keep a combined schema.
    const existing = out[key];
    const combined = (existing as any).and
      ? (existing as any).and(value)
      : value;
    out[key] = combined;
  }
  return out;
}

function mergeConditions(
  a: Condition | null,
  b: Condition | null,
): Condition | null {
  if (!a) return b;
  if (!b) return a;

  if (a.discriminator !== b.discriminator) return a;

  const values = Array.from(new Set([...a.values, ...b.values]));
  return { discriminator: a.discriminator, values };
}

function conditionToText(c: Condition): string {
  if (c.values.length === 1) {
    return `${c.discriminator}=${formatValue(c.values[0])}`;
  }
  return `${c.discriminator} in ${c.values.map(formatValue).join(" | ")}`;
}

function getObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
}

function extractLiteralValues(schema: z.ZodTypeAny): unknown[] {
  const s = unwrapStructural(schema);
  const def = (s as any).def as { type?: string } | undefined;

  switch (def?.type) {
    case "literal":
      return ((def as any).values as unknown[] | undefined) ?? [];
    case "enum": {
      const options = (s as any).options as unknown[] | undefined;
      if (options?.length) return options;

      const entries = (def as any).entries as
        | Record<string, unknown>
        | undefined;
      return entries ? Object.values(entries) : [];
    }
    case "union": {
      const options = (def as any).options as z.ZodTypeAny[] | undefined;
      if (!options?.length) return [];
      return options.flatMap(extractLiteralValues);
    }
    default:
      return [];
  }
}

function unionTypeString(types: z.ZodTypeAny[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const t of types) {
    const rendered = renderType(t);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    parts.push(rendered);
  }

  return parts.join(" | ") || "unknown";
}

function unwrapStructural(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;

  while (true) {
    const def = (current as any).def as { type?: string } | undefined;

    switch (def?.type) {
      case "pipe":
        current = (def as any).in;
        continue;
      case "readonly":
        current = (def as any).innerType;
        continue;
      case "default":
        current = (def as any).innerType;
        continue;
      case "optional":
      case "exact_optional":
        current = (def as any).innerType;
        continue;
      default:
        return current;
    }
  }
}

function unwrapModifiers(
  schema: z.ZodTypeAny,
  ctx: { key: string },
): {
  base: z.ZodTypeAny;
  isOptional: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
} {
  let current: z.ZodTypeAny = schema;
  let isOptional = false;
  let hasDefault = false;
  let defaultValue: unknown = undefined;

  // Zod v4 represents optional/default/etc as wrappers.
  while (true) {
    const def = (current as any).def as { type?: string } | undefined;

    switch (def?.type) {
      case "default": {
        isOptional = true;
        hasDefault = true;
        defaultValue = (def as any).defaultValue;
        current = (def as any).innerType;
        continue;
      }

      case "optional":
      case "exact_optional": {
        isOptional = true;
        current = (def as any).innerType;
        continue;
      }

      case "nullable": {
        throw new Error(
          `Field \"${ctx.key}\" uses nullable(); prefer optional() for CLI flags.`,
        );
      }

      case "pipe": {
        // preprocess/transform/pipe: for CLI, describe the input type
        current = (def as any).in;
        continue;
      }

      case "readonly": {
        current = (def as any).innerType;
        continue;
      }

      default:
        return { base: current, isOptional, hasDefault, defaultValue };
    }
  }
}

function renderType(schema: z.ZodTypeAny): string {
  const def = (schema as any).def as { type?: string } | undefined;

  switch (def?.type) {
    case "string": {
      const format = (def as any).format as string | undefined;
      if (format === "base64") return "base64";
      return "string";
    }
    case "number":
      return "number";
    case "boolean":
      return "boolean";

    case "literal": {
      const values = (def as any).values as unknown[] | undefined;
      if (!values?.length) return "unknown";
      return values.map(formatValue).join(" | ");
    }

    case "enum": {
      const options = (schema as any).options as unknown[] | undefined;
      if (options?.length) return options.map(formatValue).join(" | ");

      const entries = (def as any).entries as
        | Record<string, unknown>
        | undefined;
      if (entries) return Object.values(entries).map(formatValue).join(" | ");

      return "unknown";
    }

    case "union": {
      const options = (schema as any).options as z.ZodTypeAny[] | undefined;
      if (!options?.length) return "unknown";
      return options.map(renderType).join(" | ");
    }

    case "intersection": {
      const left = (def as any).left as z.ZodTypeAny | undefined;
      const right = (def as any).right as z.ZodTypeAny | undefined;
      if (!left || !right) return "unknown";
      return `${renderType(left)} & ${renderType(right)}`;
    }

    case "array":
      return `${renderType((def as any).element)}[]`;

    case "object":
      return "object";

    default:
      return "unknown";
  }
}

function formatValue(v: unknown): string {
  // Match your example: `"fetch"` not `fetch`
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
