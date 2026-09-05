# Architecture issues

Source: [September 5 audit](architecture-audit-2026-09-05.md). The user authorized all non-Mini findings and follow-ups, incremental commits, and review of `fix/mega-fix-pass` against `main` after implementation. Mini work is [tracked separately and deferred](mini-architecture-issues.md).

Statuses are implementation progress. An issue is complete after its acceptance criteria pass. This tracker is the spec for the branch review.

| ID | Audit item | Priority | Status | Acceptance criteria |
| --- | --- | --- | --- | --- |
| ARCH-01 | 1, workflow takeover | P1 | In progress | Recurring reconciliation takes over a crashed owner's run after lease expiry; live claims remain fenced. |
| ARCH-02 | 2, runner preparation | P1 | In progress | Failure during preparation releases acquired parents and request ownership; later session requests progress; partial parent setup rolls back. |
| ARCH-03 | 3, plugin retirement | P1 | In progress | Retired plugin instances stay alive for existing Level 1 toolsets and Level 2 calls; release triggers cleanup; reload from an active run does not deadlock. |
| ARCH-04 | 4, artifact paging | P1 | In progress | Local and blob adapters share streaming page policy; page reads retain bounded content and validate complete integrity/authentication. |
| ARCH-05 | 5, ACP lock ownership | P1 | In progress | Cross-process exclusion survives contention and releases on owner death; stale legacy lock directories cannot block index mutation. |
| ARCH-06 | 6, tools client duplication | P2 | In progress | Restricted help preserves all native help fields; both clients share protocol decoding and pure argument policy while keeping separate I/O adapters. |
| ARCH-07 | 7, portable imports | P2 | In progress | Portable helper imports outside a workspace do not require Core environment or initialize providers; existing product bootstrap remains compatible. |
| ARCH-10 | 10, Discord projection | P2 | In progress | Tool, prompt, and indexing consumers use Discord-owned attachment/reference projection; external and stored formats remain compatible. |
| ARCH-11 | 11, workflow blob ownership | P2 | In progress | Publication retains recoverable cleanup ownership before durable blob creation; crash/duplicate cleanup cannot abandon unreachable durable objects or delete live canonical artifacts. |
| ARCH-13 | Follow-up, Claude attempts | P2 | In progress | Named and primary continuation share attempt lifecycle policy while retaining distinct proof checks, tables, transactions, and outcomes. |
| ARCH-14 | Follow-up, canonicalization | P3 | In progress | Coding-tool traversal delegates to fs canonicalization with tilde handling and existing error/guardrail semantics preserved. |
| ARCH-15 | Follow-up, source classification | P3 | In progress | Semantic and syntax scanners share production-source classification, including production src/fixtures and test-owned fixture exclusions. |
| ARCH-16 | Follow-up, product test selection | P3 | In progress | Product test commands include their workspace dependency closure, including blob-storage; a regression check prevents omissions. |

## Completion gates

- Run focused regression tests and changed-workspace typechecks.
- Run `bun run check` against final worktree contents before each commit.
- Commit coherent increments using the repository's recent message style.
- After every accepted fix is applied, review `git diff main...HEAD` through independent Standards and Spec agents.
- Fix findings caused by this branch or violating these acceptance criteria, rerun checks, and repeat review until neither axis has blockers.

The audit's documented non-goals remain unchanged. A required new stored contract, dependency, or recovery mechanism needs a concrete design decision before implementation.

ARCH-11 storage design was explicitly approved by the user on September 5, 2026: [staged publication design](architecture-blob-publication-design.md).
