# Deferred Mini architecture issues

All issues below are deferred by the user on September 5, 2026. They are not active implementation work. Shared-package changes may still require Mini compatibility tests.

| ID | Issue | Priority | Status | Required outcome |
| --- | --- | --- | --- | --- |
| MINI-01 | HTTP rejection semantics | P2 | Deferred | Closed runtime rejection reasons map to existing HTTP statuses independently of message wording, including interrupted steering admission. |
| MINI-02 | Session admission | P2 | Deferred | Runtime owns resolve/create/admit serialization and performs targeted lookup instead of listing every session per prompt. |
| MINI-03 | Workspace-history interfaces | P2 | Deferred | Result methods are canonical; compatibility wrappers compose in one direction; test adapters no longer require prototype detection. |
| MINI-04 | Transcript follower | P2 | Deferred | Main and subagent transcript views share reconnect, cancellation, cursor/reset handling, and buffered updates. |
| MINI-05 | History coordination | P2 | Deferred | Live finalization and startup recovery share capture registration, commit, and cleanup policy while retaining transaction guarantees. |

## Mini derives HTTP failure categories from English messages

[MiniLilacSessionOperationRejected](../packages/mini-lilac-runtime/src/session-service.ts) carries an operation and message, but no closed rejection reason. The server [reconstructs HTTP semantics from message patterns](../apps/mini-lilac-server/src/server.ts), with another creation-specific mapper nearby.

An interrupt can record pending steering IDs. A later steering request is then [rejected as interrupted before admission](../packages/mini-lilac-runtime/src/session-service.ts). The `/steer` route uses the generic mapper, which has no matching pattern.

**Verification:** Executing that mapper returned status 500 and `internal_error`. An [existing runtime test](../packages/mini-lilac-runtime/tests/session-runtime-interruptions.test.ts) exercises the valid interruption sequence. This was a mapper probe plus route tracing, not a full HTTP test.

**Fix:** Add closed internal rejection reasons and exhaustively project them onto existing HTTP statuses/codes. Let messages change independently. Test interrupt-before-admission through the route and cover the mapping table. The current protocol need not change.


## Mini HTTP owns admission and scans all sessions per prompt

[existingSession](../apps/mini-lilac-server/src/server.ts) finds one session by calling `listSessionsResult()`. The [store implementation](../packages/mini-lilac-runtime/src/sqlite-store.ts) selects and decodes every session and loads history-navigation state for each.

The HTTP route owns find/create, binding comparison, and prompt start under a [server-local lock](../apps/mini-lilac-server/src/server.ts). The runtime actor has its own serialization, and delegated-session admission implements another [find/create/admit sequence](../packages/mini-lilac-runtime/src/session-service.ts).

A prompt does work proportional to retained sessions and depends on unrelated session rows decoding successfully. Correct admission also requires callers to know which extra lock and checks to apply.

**Fix:** Put resolve-or-create-and-admit in the runtime under its existing session serialization. Use a targeted lookup distinguishing absence from corruption. HTTP should decode inputs and project results. Verify concurrent admission through different entry points and show that one prompt does not enumerate all stored sessions.


## Mini history exposes competing throwing and Result interfaces

Workspace-history Result methods [compare methods against class prototypes](../packages/mini-lilac-runtime/src/workspace-history-store.ts) to decide whether to execute an overridden throwing method or the internal Result implementation. There are 15 such checks. [Test doubles subclass the concrete store](../packages/mini-lilac-runtime/tests/session-runtime-test-support.ts), and the runtime factory requires that concrete type.

Wrapping or overriding a method changes its Result counterpart's execution path. Tests depend on one interface while production generally uses another, forcing production dispatch logic to preserve the relationship. Locking and failure handling acquire extra paths to maintain.

**Fix:** Make Result methods canonical and have throwing compatibility wrappers call them in one direction. Use a narrow interface at the existing runtime factory seam so tests provide adapters rather than subclasses. Remove prototype detection after migrating the test doubles. Preserve externally consumed compatibility methods and check error identity and lock release.


## Transcript following

The subagent view in `apps/mini-lilac-tui/src/app.tsx` repeats fetch/stream/reconnect responsibilities from `controller.ts`. Main-session streams reconnect while subagent read errors terminate the view. Extract a shared read-only transcript follower and test reconnect/reset behavior in both views.

## History coordination

`SessionActor` and `SessionService` repeat capture-to-snapshot registration, cleanup, and finalization policy in `packages/mini-lilac-runtime/src/session-service.ts`. Extract the existing coordination behind one runtime-owned interface while preserving live and recovery transaction behavior.
