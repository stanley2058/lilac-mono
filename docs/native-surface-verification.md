> Historical verification: standalone TUI packaging, password/Clerk terminal login, and disk caching
> below describe the former client. The current console is documented in [native setup](native-surface.md#temporary-operator-console).

# Native surface verification

Verification record for the native backend, web app, terminal client and installer, recorded on
2026-09-19. See [native setup](native-surface.md) for operation and [MIGRATIONS.md](../MIGRATIONS.md)
for persistence and rollback. Test counts below describe the recorded runs, not a permanent suite size.

## Release verification

| Area | Evidence | Limits |
| --- | --- | --- |
| Core | 3,282 tests passed, including native services, execution, replay, resources and recovery. | Synthetic model and isolated stores where applicable. |
| Installer | 283 tests passed, including authenticated native setup and preservation of existing deployment settings. | Automated installation coverage does not test every host configuration. |
| Native-only deployment | A complete Core process started with disposable Redis, authenticated through local auth and shut down without leaked handles. | No Discord credentials were present. |
| Discord-only and combined deployment | Descriptor composition, fake Discord ingress and relay lifecycle tests passed with native disabled and enabled. | These tests do not log in to a live Discord gateway. |
| Container packaging | Production Docker build and image verification passed. | Other OS terminal artifacts await their release CI builds. |
| Compiled terminal | Linux x64 standalone executable ran from `/tmp` in a gmux virtual terminal. Local login, send, file and image upload, and model selection were exercised. | Actual desktop Ghostty/Kitty checks were omitted at the user's direction. This does not certify desktop clipboard integration. |
| Clerk terminal auth | Live PKCE authorization, owner bootstrap, socket thread creation, forced real refresh, socket reauthentication and logout passed. The current JWT returned 401 from bootstrap after logout. | Refresh/logout races and independent revocation timeouts have passing regressions and no remaining review blockers. |

The live Clerk browser fixture previously verified owner sign-in through a single-use ticket,
authenticated bootstrap, socket prompts, upload/preview, token refresh, reload and sign-out. Protected
bootstrap and resource requests returned 401 after sign-out. This browser result does not certify the
terminal OAuth path or an interactive password login. Fixtures use a disposable native store;
credentials and sign-in tickets are absent from source and recorded artifacts.

The local-auth path also has expiry, origin, principal isolation, revocation and resource access tests.
Native integration tests exercise uploads accepted before completion, replay, steering, follow-ups,
cancellation, rewind and shared-reader permissions. Active-run custom commands wait for the current
run and execute as a full follow-up. Durable-output tests cover publication before terminal/WAL
settlement, projection deduplication, recovery frontiers and failed publication retaining an earlier
safe recovery point.

## Web interaction coverage

Browser checks cover desktop and 390-pixel layouts, keyboard controls, local drafts, delayed first
send and upload, file retry/preview, model and command selection, activity disclosure, long-turn
paging, rewind, access revocation and two-tab logout. Cached private data was cleared on expiry and
logout. A service-worker upgrade preserved the draft. Blocked Clerk chunks left the shell and Reload
control usable, and removing the request block restored sign-in.

The component follow-ups verified shadcn controls, Plate Markdown editing, sidebar search placement,
menu spacing and a fixed sidebar-toggle position. Expanding settled work preserves the timeline's
scroll position; activity groups and tool details remain closed until opened. Participant details
load on hover or keyboard focus through the existing authorized endpoint.

## Design-system and UI follow-up

The `/design-system` gallery uses real app components and synthetic fixtures. Browser verification
covered 1280-pixel desktop and 390-pixel mobile layouts in dark/light themes, component menus and
dialogs, media playback/zoom, inline file-chip editing, draft navigation and reload recovery.
Accessibility audits reported no violations in the gallery or the settled chat screen.

Live local-auth checks covered owner name/avatar changes, the People list after avatar upload,
service-worker update/reload toasts, and offline status without a layout banner. Toasts sit above
the conversation rather than over the send control. A warmed cached-thread switch transferred 702
WebSocket bytes including framing, with no HTTP requests; this is a single transfer check, not a
new timing benchmark. Identity data is reused on revisits and refreshed for unknown visible authors.

Boundary tests cover owner-only identity changes, public-user projections, avatar caching,
per-user unread completion, and binary/missing/unauthorized preview responses. A 1 GiB sparse file
produced a 64 KiB local/remote preview while full reads retained their previous size limit.

## Stage 5 production web performance baseline

Measured on 2026-09-19 after the shadcn/Plate changes and Stage 5 polish, including deferred Mermaid
layout. The production main asset was `index-ChO3H5WL.js`. Core served the build on loopback using the
synthetic browser fixture. The reference host was Linux x86_64, AMD Ryzen 9 5950X, Bun 1.4.2 and
headless Chrome 151, with a 1280 × 633 viewport and no injected network latency. Final timing samples
ran without the repository checks or container build competing for CPU.

The cached-navigation run alternated a simple thread and the cached rich thread 20 times. Each first
animation-frame sample checked that the assistant paragraph existed, had nonzero bounds, used visible
styling and intersected the timeline viewport. The run also retained the previous two-animation-frame
measurement for comparison. The 95th percentile is the nineteenth sorted sample. Animation-frame
callbacks measure browser scheduling and laid-out content, not compositor presentation timestamps.

| Measurement | Recorded result |
| --- | --- |
| Cached rich-thread click to first frame with visible content | 39.8 ms p95; 44.0 ms maximum; viewport checks passed in all 20 samples. |
| Same clicks measured through two animation frames | 50.5 ms p95; 50.6 ms maximum. This conservative proxy remains 0.5 ms above the 50 ms content target. |
| Unchanged cached rich-thread reconciliation | 702–708 bytes including masked WebSocket framing, subscription replacement and queue RPC; auth/connection setup excluded. |
| Uncached 600-turn bootstrap, 20 fetch/JSON-parse samples | 3.2 ms p95; 5.2 ms maximum; 20,984-byte bounded response body. |
| Cold production shell | 853,885 browser-reported transfer bytes including headers across seven assets; no HTTP compression in this local fixture. |
| Shell, Plate and lazy rich assets after opening the rich fixture | 6,839,455 transfer bytes across 49 assets. |
| Service-worker-controlled rich-thread reload | Zero network asset bytes across 49 asset requests. Socket construction began at 62.5 ms and bootstrap fetch at 165.5 ms; no thread-list request preceded the selected thread. |
| Rich-thread reload rendering | 101 ms longest task; 0.0169 cumulative layout shift in the recorded reload. |

The visible-content and unchanged-wire requirements pass on this reference profile. The two-frame
proxy is reported separately rather than treated as an exact paint measurement. Before the Mermaid
change, repeated rich-thread navigation measured 57.4–57.5 ms p95 through two frames. A CPU profile
showed repeated diagram layout during navigation. Mermaid now leaves a paint opportunity for the
conversation text and source placeholder before starting layout, and cancels scheduled work when the
component unmounts.

Frame sizes were measured by `apps/web/tests/support/browser-metrics.js`, which records lengths and
directions without message bodies. The socket negotiated no compression. The cold shell and full
rich-renderer totals describe different loading stages; heavy renderers remain lazy. These loopback
results do not certify remote-network latency, slower client hardware or desktop-terminal behavior.

## Previous Stage 2 performance baseline

These numbers belong to the earlier Stage 2 implementation, before the later shadcn/Plate component
revisions and terminal/release work. They are retained as a comparison baseline, not measurements of
the current build.

The reference machine was Linux x86_64 on an AMD Ryzen 9 5950X, with Bun 1.4.2 and headless Chrome 151.
Traffic used loopback without injected latency. The deterministic browser fixture contained 600
historical turns, 60 sidebar threads, rich content and a large paged turn. It used synthetic data.

| Measurement | Recorded result |
| --- | --- |
| Unchanged cached rich-thread navigation | 702–708 bytes, including masked WebSocket framing, subscription replacement and queue request; auth/connection setup excluded. |
| Protocol-only unchanged replay | 355 bytes with representative IDs; 753 bytes with maximum schema identifier lengths; UI queue traffic excluded. |
| Cached rich-thread click, 20 samples through two animation frames | 43.7 ms p95; 44.5 ms maximum. |
| Uncached 600-turn bootstrap, 20 samples including transfer and JSON parsing | 5.1 ms p95; 23.3 ms maximum; 20,942-byte bounded recent-window response. |
| Cold production shell | 609,049 uncompressed HTTP bytes including headers across three asset requests; main JavaScript approximately 175 KiB gzip. |
| Lazy rich-renderer assets | 5.72 MB total for the rich fixture. |
| Service-worker-controlled reload | Zero asset bytes; socket opened at 47 ms and bootstrap began at 60.9 ms without waiting for auth-info or thread-list requests. |
| Rich-renderer cost | 30.8 MB JavaScript heap, 0.007 layout shift and a 135 ms longest renderer task. |

The fixture did not measure a remote network profile. Rich rendering had a measurable lazy-load cost
separate from cached navigation. Repeat the benchmark after component or bundle changes before
claiming the earlier latency or size for a newer build.

## Reproducing checks

Shared native agent streams were verified on 2026-10-12. Socket regressions cover common thread/child
replay schemas, resumed checkpoints, completed history, nested ancestry, cancellation before output,
discarded-child late events, and preservation of an earlier child during a later parent rewind.
The attachment regression uses the real tool server to construct an internal delegated context with
`serverOwnedRequest: false`, and verifies native resource publication and retained HTML previews.
Client and IndexedDB tests cover reconnecting a child while its parent remains selected and purging
child caches across cache instances and principal scopes.

The synthetic subagent browser fixture verified reasoning titles, formatted commands, completion,
history after reload, and the retained HTML preview in the production panel. Existing activity DOM
elements stayed mounted during a streamed update, and the transcript scroll position stayed at its
previous position. The completed panel also passed a 390-pixel layout check without horizontal overflow.
Both standards and spec reviews reported no blockers after fixes. `bun run check` and
`bun run build:web` passed against the final code.

Use the root scripts `bun run check`, `bun run build:web`, and
`bun run test:installer`. The test graph includes Core, protocol/client, web, terminal, persistence
codecs and architecture checks. Full repository checks are repeated before implementation commits.

`apps/core/tests/surface/native/browser-fixture.ts` provides deterministic browser data and the real
native service/runner path. `clerk-browser-fixture.ts` in the same directory loads ignored credential
configuration at runtime and takes `TEST_NATIVE_CLERK_OWNER_ID`; it does not change normal Core
configuration. The e2e suite in `apps/core/tests/e2e/` is the full native-only startup proof: its
harness boots Core native-only with isolated Redis unless a scenario adds a surface. Combined-mode composition coverage is in
`apps/core/tests/runtime/compose-builtin-surface-runtimes.test.ts`.

Debug events in `surface:native:metrics` report application-frame bytes, replay resets, bootstrap
latency, pending input counts and handoff failures. Correlation uses opaque connection, RPC, request
and thread IDs. Commit timing ends when the server enqueues the matching projection on its socket;
it does not include network receipt or client rendering. Counters exclude TLS/WebSocket framing,
while the older browser baseline above includes WebSocket framing. No message bodies or credentials
are logged.


## Permanent DM verification, 2026-10-15

The production build was exercised against the isolated native browser fixture on port 8791 with
its deterministic model. Verified first-use creation, fixed sidebar navigation, send, `/compact`,
history preservation, summary styling, disabled rewind, absent destructive/share menus, archived-list
round trip, and reload. Temporarily setting DM context age to 1 ms made both retained turns render
at computed opacity 0.8. Restored the 10,800,000 ms default afterwards. The 390 × 844 mobile viewport
had no document overflow. Desktop and mobile screenshots were captured during the check.

A cached navigation comparison alternated an ordinary one-turn note and the two-turn DM 22 times,
discarding two warmups. Click to the first animation frame containing the destination heading and
turn DOM measured 44.8 ms p95 for the ordinary thread and 50.2 ms for the DM. This measures browser
scheduling and DOM presence, not compositor presentation. It is a same-build comparison; no claim
is made about production network or model latency.

`dm-performance.test.ts` seeds equivalent ordinary and DM stores at 1,000, 10,000 and 100,000 turns.
At 100,000 turns, DM versus ordinary results were: selected-input read 0.060/0.059 ms p95, initial
window 0.214/0.189 ms p95, submission 0.313/0.342 ms, changed-input receipt read 0.120/0.094 ms,
and Stop 0.283/0.294 ms. Windows contained five recent turns plus a deferred slot, totaling 2,331
bytes for either kind. Reads use indexed boundaries and pending-input indexes rather than lifetime
input decoding. These are local warm SQLite measurements with synthetic small turns; oversized
turns and model-context size retain the existing ordinary-thread limits.

The real RPC-to-runner integration test verifies manual compaction, idempotent retry, unchanged
prior display history, retained summary on follow-up, and deletion denial. Execution tests cover
the independent three-hour cutoff, frozen active selection, active compaction before settlement,
and recent direct-message retention when a summary expires. Store tests cover ownership, search
privacy, uniqueness, permanence, and retention exclusion.
