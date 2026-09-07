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
- Additional frontmatter fields are accepted but are not part of discovery or selection.
- The parent directory should match `name`. A mismatch emits a warning rather than changing the skill's
  identity.
- Duplicate names resolve by runtime search precedence, so names should be globally distinctive within a
  deployment.

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
then built-in skills. Core exposes metadata and bounded `SKILL.md` bodies through `skills.list`,
`skills.brief`, and `skills.full`.

Implementation references: [shared parsing and discovery](../packages/utils/skills.ts) and
[Core skill tools](../apps/core/src/tool-server/tools/skills.ts).
