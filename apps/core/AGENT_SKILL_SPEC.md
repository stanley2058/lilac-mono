# Agent Skills: How to Create a Skill

This is a condensed, execution-oriented spec for **authoring filesystem-based “Skills”** that a tool-using LLM agent can discover, load on-demand, and execute (instructions + optional scripts/resources). It intentionally excludes vendor/platform details.

---

## 0) Mental model (what a Skill is)

A **Skill** is a **directory** containing:

- A required `SKILL.md` that provides **metadata + operational instructions**
- Optional additional docs (guides, references)
- Optional executable scripts/utilities
- Optional templates/resources/data files

A runtime should support **progressive disclosure**: load only lightweight metadata initially, then load instructions/resources only when the Skill is selected.

---

## 1) Skill directory structure (required + recommended)

Minimum:

```
your-skill/
└── SKILL.md
```

Typical:

```
your-skill/
├── SKILL.md
├── REFERENCE.md          # optional (schemas, rules, templates)
├── GUIDE.md              # optional (longer workflows)
└── scripts/
    ├── validate.py       # optional deterministic helper
    └── transform.ts      # optional deterministic helper
```

Rule: `SKILL.md` is mandatory; everything else is optional.

---

## 2) `SKILL.md` required format (YAML frontmatter + body)

### 2.1 YAML frontmatter (required)

At the very top of `SKILL.md`:

```yaml
---
name: your-skill-name
description: Brief description of what this Skill does and when to use it
---
```

#### `name` constraints (recommended for robust parsing)

- max **64** characters
- only **lowercase letters**, **numbers**, **hyphens**
- must not contain XML/HTML tags

Examples:

- ✅ `pdf-processing`
- ✅ `jira-ticket-writer`
- ❌ `PDF_Processing` (uppercase/underscore)
- ❌ `my skill` (space)

#### `description` constraints

- non-empty
- max **1024** characters
- no XML/HTML tags
- must include:
  - **what it does**
  - **when it should be used** (trigger conditions)

Good example:

> “Draft clean changelogs from commit/PR notes. Use when user asks for release notes or changelog.”

---

## 3) Progressive disclosure contract (how Skills should load)

Design both authoring and runtime around these “levels”:

1. **Metadata (always loaded)**

- Only `name` + `description` are assumed visible during discovery/selection.

2. **Instructions (loaded when selected)**

- Load `SKILL.md` body when the Skill is triggered.

3. **Resources & scripts (loaded/executed as needed)**

- Load other files only when referenced.
- Execute scripts and consume **only their outputs** in the agent context (avoid dumping full code into the model prompt).

Authoring implication: keep `SKILL.md` concise and operational; move bulky reference material into separate files.

---

## 4) What to include in the Skill body (LLM-usable instruction design)

### Required sections (recommended)

Include these headings (or equivalent) so an LLM can follow reliably:

- **When to use**
  - Positive triggers (keywords/tasks)
  - Negative triggers (“don’t use when…”)
- **Inputs to collect (ask if missing)**
  - Explicit required fields
  - Clarifying questions
- **Procedure**
  - Numbered deterministic steps
  - Decision points / branching rules
- **Output format**
  - Concrete schema: Markdown outline, JSON shape, table columns, etc.
- **Validation**
  - Checks to run (manual rules or script commands)
  - What to do on failure
- **Examples**
  - At least one end-to-end example (User → Assistant output)

### Patterns that work well

- Put decision logic in “If A… else…” form.
- State stop conditions: “Finish when validation passes and output matches schema.”
- Use exact output templates to reduce variance.

---

## 5) Scripts & deterministic helpers (how to bundle code)

Scripts live under `scripts/` and are called by the runtime (or by an agent tool wrapper). In `SKILL.md`, specify:

- **command to run**
- **inputs/outputs**
- **how to interpret errors**
- **retry loop behavior**

Example snippet:

```markdown
## Validation

- Run: `python scripts/validate.py report.json`
- If errors are printed:
  1. Fix the listed fields
  2. Re-run until it prints: `Validation passed`
```

Best practice:

- Keep scripts deterministic and side-effect minimal.
- Prefer scripts for parsing/validation/transforms vs asking the LLM to “compute” them.

---

## 6) Security authoring rules (must-have)

Treat Skills as executable packages.

Authoring guidelines:

- Avoid instructions that fetch arbitrary remote content and execute it.
- Scope file access: only read/write necessary paths.
- Require explicit confirmation for destructive actions (delete, overwrite, mass edits).
- Log/emit clear provenance in outputs (what inputs were used, what was assumed).
- Prefer allowlists (commands, domains, file paths) over open-ended actions.

---

## 7) Copy/paste templates

### 7.1 Minimal Skill template (`SKILL.md`)

```markdown
---
name: example-skill
description: Do X. Use when the user asks for X or mentions Y.
---

# Example Skill

## When to use

- Use when: ...
- Don’t use when: ...

## Inputs to collect (ask if missing)

- ...

## Procedure

1. ...
2. ...
3. ...

## Output format

- ...

## Validation

- Checks: ...
- Failure handling: ...

## Examples

### Example 1

User: ...
Assistant: ...
```

### 7.2 Skill referencing extra docs + scripts

```markdown
---
name: incident-postmortem
description: Produce standardized incident postmortems using bundled severity rules and template. Use when user asks for postmortem/RCA/incident report.
---

# Incident Postmortem

## Inputs to collect

- Summary, timeline, impact, root cause, remediation, owners
- Severity (if unknown, determine using `REFERENCE.md`)

## Procedure

1. Determine severity per `REFERENCE.md`.
2. Draft report using the template in `REFERENCE.md`.
3. Produce action items with owners + due dates.
4. Validate: `python scripts/validate.py report.json`
5. Fix issues; re-run until pass.

## Output format

- Markdown report
- JSON block matching schema in `REFERENCE.md`

## Examples

(User → Output)
```

---

## 8) Authoring checklist

- [ ] Has `SKILL.md` in the Skill directory
- [ ] YAML frontmatter present and parseable (`name`, `description`)
- [ ] `name` meets your parser constraints (recommended: lowercase/numbers/hyphens, ≤64)
- [ ] `description` includes what + when-to-use triggers
- [ ] Body includes triggers, required inputs, numbered procedure, output format, validation, examples
- [ ] Large details moved to `REFERENCE.md`/`GUIDE.md`
- [ ] Script calls are explicit (command + expected success/failure output)
- [ ] Security guardrails included for destructive actions and data access
