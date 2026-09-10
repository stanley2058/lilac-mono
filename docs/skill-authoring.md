# Skill Authoring

A Lilac skill is a directory containing a required `SKILL.md` and optional reference files, templates,
or scripts. Discovery reads metadata first; instructions and resources are loaded only when the agent or
caller selects the skill.

## Required Format

`SKILL.md` must begin with YAML frontmatter containing non-empty `name` and `description` strings:

```markdown
---
name: release-notes
description: Draft release notes from commits and pull requests. Use when asked for a changelog or release summary.
---

# Release Notes

1. Collect the release range and audience.
2. Group user-visible changes by impact.
3. Return the requested Markdown format.
```

The shared discovery contract is:

- `name` is at most 64 characters and matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
- `description` is at most 1024 characters and should state both what the skill does and when to use it.
- `disable-model-invocation: true` omits the skill from the default model catalog. It remains available
  through `skills.list` and `skills.read`. Only the YAML boolean `true` enables this behavior.
- Other additional frontmatter fields are preserved but do not affect discovery or selection.
- The parent directory should match `name`. A mismatch emits a warning rather than changing the skill's
  identity.
- Duplicate names resolve by runtime search precedence and emit a warning identifying both paths.

## Instructions And Resources

Write the body as direct operational instructions. Include only sections useful to the workflow, such as
required inputs, ordered steps, decision points, output shape, validation, and failure handling. These
sections are authoring guidance, not parser requirements.

Keep bulky schemas and examples in nearby files and reference them with paths relative to the skill
directory. If a helper is useful, state its exact command, inputs, outputs, and error behavior. Bundled
scripts are resources only: Lilac does not execute them automatically. An agent can run one only when the
loaded instructions request it and the active tool/profile grants that execution authority.

Treat skill content as instructions, not a security boundary. Avoid download-and-execute flows, minimize
credential and filesystem access, and make destructive actions and required confirmation explicit.

## Discovery

Core scans `DATA_DIR/skills` first, then its supported project and user compatibility directories,
then built-in skills. These include `.agents/skills` and `~/.agents/skills`; the older `.agent/skills`
directory remains supported. For `skills.list` and `skills.read`, directory-relative discovery uses the
calling tools CLI's working directory, falling back to Core's working directory when none is supplied.
It does not search for a repository root or require a workspace manifest.

The default model catalog inserts up to 512 characters per description without a total size cap. It
includes a warning when more than 100 skills are advertised or the inserted descriptions together exceed
50,000 characters. Skills omitted by `disable-model-invocation` do not count toward these thresholds.

`skills.list` lists and searches skill metadata, including discovery warnings. `skills.read <name>`
returns these fields in order:

1. `path`: absolute path to `SKILL.md`.
2. `length`: full content length in JavaScript string characters, or UTF-16 code units.
3. `metadata`: parsed YAML frontmatter.
4. `content`: complete file text, including frontmatter, with no skill-specific truncation.

Normal Bash output limits still apply. Use the returned path to read further when Bash truncates output.

Implementation references: [shared parsing and discovery](../packages/utils/skills.ts) and
[Core skill tools](../apps/core/src/tool-server/tools/skills.ts).
