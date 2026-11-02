---
name: customize-lilac
description: Locate Lilac's own files and state under DATA_DIR, debug deployed Core from `/app`, and explain or change `core-config.yaml`. Use for self-debugging, Lilac data, or Core configuration; code work uses `coding-agent`.
---

# Customize Lilac

Ground the work in the target instance rather than remembered behavior.

## Choose a route

- For a running instance's build, behavior, state, or shipped implementation, read
  [references/self-debugging.md](references/self-debugging.md).
- For `core-config.yaml` fields, ownership, edits, validation, or reload behavior, read
  [references/core-config.md](references/core-config.md).
- For where Lilac keeps prompt files, memory, heartbeat watches, skills, workflows, databases, or other
  state under `DATA_DIR`, read [references/data-layout.md](references/data-layout.md).
- Read more than one reference only when the request crosses branches.

## Shared boundaries

- Prefer `/app` when it contains `apps/core` and `packages/utils`; otherwise use the current Lilac
  repository root.
- Treat `/app` as shipped implementation and `DATA_DIR` as active operator state. Establish which one
  supports each claim.
- Inspect named configuration and state files only. Keep `DATA_DIR/secret` outside the investigation.
- Work read-only unless the user asks for a change. A request to explain or diagnose does not authorize
  configuration edits, reloads, or restarts.
- Finish with observed facts, source-derived conclusions, and any unresolved gap separated clearly.
