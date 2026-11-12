# Native surface

The native surface runs inside Core. It owns `native-surface.db` independently of Discord and serves
the web app, authenticated HTTP bootstrap, file endpoints, and typed oRPC over WebSocket or HTTP+SSE. A native
thread is a session. Messages start work without a mention or active-channel mode.

Use [Local setup](#local-setup) and [Clerk](#clerk) to configure access, [Settings and updates](#settings-and-updates)
for runtime settings, and [Persistence and rollback](#persistence-and-rollback) before upgrading.
The container console is covered under [Temporary operator console](#temporary-operator-console).

## Local setup

Build the web assets with `bun run build:web`. Enable the surface in a version-3 (or existing version-2)
`core-config.yaml`:

```yaml
surface:
  native:
    enabled: true
    installationId: my-lilac
    host: 127.0.0.1
    port: 8789
    publicUrl: http://localhost:8789
    allowedOrigins:
      - http://localhost:8789
    auth:
      provider: local
      ownerId: owner
```

Set `LILAC_NATIVE_LOCAL_USERNAME`, `LILAC_NATIVE_LOCAL_PASSWORD_HASH` and
`LILAC_NATIVE_SESSION_SECRET` in the existing process environment or credential configuration. The
password hash must use Argon2id; the session signing secret must contain at least 32 bytes. Keep these
values outside core-config and source control. Local authentication has one configured owner and no
user creation endpoint. Restarting Core invalidates its local sessions.

Start Core normally and open `http://localhost:8789`. Discord credentials are optional when the native
surface is enabled. The listener defaults to loopback and remains disabled on existing installations.
Native web uses port 8789 by default; GitHub webhooks use 8787 and the operator console uses 8788.
For a remote installation, put the native listener behind HTTPS and set `publicUrl` and
`allowedOrigins` to the externally visible origin. Auth uses the configured public URL; arbitrary
forwarded headers cannot change it.

For frontend development, run `bun run dev:web`. It starts the deterministic browser fixture and Vite
on free ports and prints the web URL, login and seeded thread links. `--replace` stops the dev servers on
ports 5173 and 8789 and starts there instead. `--clerk` uses Clerk authentication with the keys in
`apps/web/.env.local` and prints a single-use sign-in link; `--clerk-owner <user_id>` picks the owner
when the Clerk instance has more than one user.

The first browser-fixture launch generates a local database snapshot under
`.cache/native-browser-fixture`. Later launches copy it into a fresh temporary directory and refresh
relative timestamps. Dev-session changes never modify the snapshot. Changes to the seed, Core/shared
source, dependency lockfile, or Bun version generate a new snapshot automatically. Remove
`.cache/native-browser-fixture` to discard saved snapshots. Authentication and workflow views are
initialized separately on each launch; the snapshots contain only generated chat data.

To develop against a real Core installation, run `bun --cwd=apps/web run dev`. Vite proxies `/api` and
WebSocket upgrades to `http://127.0.0.1:8789`; `LILAC_WEB_BACKEND_URL` overrides that development
target. Add the development origin, normally `http://localhost:5173`, to `allowedOrigins`.

## Clerk

**Use an invite-only Clerk application for Lilac.** Clerk defaults to open signup; Lilac's
sign-in-only screen does not change that application-wide policy. Neither the installer nor Core
configures it for you. Follow Clerk's [access-mode documentation](https://clerk.com/docs/guides/secure/restricting-access#invite-only)
to select Invite-only before exposing the native web app.

Choose Clerk per installation with `surface.native.auth.provider: clerk`. Configure the owner's native
`ownerId`, Clerk `ownerProviderUserId` and `clerkIssuer`. Browser sessions do not require a `clerkOAuthClientId`. Set
`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the server environment. `CLERK_JWT_KEY` is optional.
Only the publishable key reaches the browser. The web build does not embed installation credentials.

Settings → Account embeds Clerk's profile and security controls, including connected accounts.
Local-password installations keep the name and avatar editor. Thread preferences and the access
summary are in Settings → Options.

Clerk account creation and Lilac enrollment are separate steps:

1. Create the account through Clerk, or have the invitee complete Clerk's
   [invitation flow](https://clerk.com/docs/guides/users/inviting) using its Account Portal. Lilac has
   no sign-up page to use as an invitation destination.
2. The configured owner signs in to Lilac and adds the existing Clerk user ID in Settings → User,
   choosing Restricted or Full access. Accepting an invitation or signing in does not enroll an
   account; Core rejects accounts missing from its native user directory.
3. Share existing threads separately with read or edit access.

The configured `ownerProviderUserId` is enrolled automatically with owner and full tool access.
Use the intended end-user account from the same Clerk instance as the configured keys and issuer;
a Clerk Dashboard or CLI administrator login does not itself identify the Lilac owner. Clerk
organization membership and roles do not grant Lilac permissions.

When changing the web domain or using Vite, update Lilac's `publicUrl` and `allowedOrigins` as
described in [Local setup](#local-setup). Core checks the browser session's authorized-party origin
against `allowedOrigins`; a successful Clerk sign-in alone does not establish Lilac access.

The owner sees all threads and config. Other users see only their threads. Restricted users can
operate threads they started but cannot edit another starter's thread. Runs use the starter's tool
and data authority. Human author attribution remains separate.

Invite only people trusted to use this Core installation. Thread sharing controls native UI access
and modification, but agent conversation search and automatic recall can read other retained native
threads and allowlisted Discord conversations. Restricted tool access does not make conversation
memory private between users. See [Surface tools](#surface-tools) for the retrieval scope.

## Settings and updates

Settings > Deployment > Transport applies to all native web and TUI clients:

- **Auto (default)** tries WebSocket first. A failed upgrade or a handshake that exceeds the
  ten-second connection deadline falls back to HTTP+SSE for that connection. Each reconnect tries
  WebSocket again.
- **WebSocket** uses WebSocket without fallback.
- **HTTP+SSE** sends RPC calls over HTTP and streams each active subscription over SSE.

Saving a different policy reconnects active clients with their existing replay checkpoints and command
receipts. The setting persists in the native deployment record. Older records default to Auto.
Both transports use the same authentication and authorization. The computer-use viewer retains its
separate binary WebSocket.

HTTP RPC uses POST under `/api/rpc/`. Allow streaming responses through the reverse proxy, disable
response buffering, and permit idle intervals longer than the 15-second SSE keepalive. HTTP/2 is
recommended for multiple tabs and subscriptions. Each watch has its own SSE response; this is not a
single multiplexed event connection. HTTP presence uses the existing 60-second heartbeat expiry.


The owner manages title generation, response streaming, old-message selection age, storage retention,
and whether cross-thread sends trigger a run in Settings > Deployment. These settings persist in the
native database. With config v2, Core imports existing `surface.native` values once when it creates the deployment
record. Later YAML edits do not override database settings. Before switching a customized installation
to v3, start with v2, verify Settings > Deployment, then remove the five YAML settings. V3 rejects
those keys. Fresh v3 installations use deployment defaults. See [configuration upgrades](core-config-migrations.md#upgrade-procedure).
Saves reject stale revisions. New title jobs, output attempts, selections, and retention passes use
the latest settings; active output attempts keep their original streaming mode.

Native `surface.messages.send` defaults to `triggerRun: false`. Core queues the message until the
sender finishes and the destination is idle, without starting a destination run. Pass `triggerRun: true`
only when the destination agent should respond, subject to the deployment's cross-thread execution
setting. Heartbeat always queues. `silent` independently controls notifications.

Core and MCP configuration editors are also owner-only. Save validates and atomically updates the
selected file, using revisions to reject concurrent edits. Core keeps its existing reload behavior. MCP
Save writes the document; Reload applies it through the existing MCP registry. The UI does not edit
`.env` or credential files. Listener and authentication settings take effect when Core restarts.

The owner can change the agent's display name and upload a PNG, JPEG, WebP or GIF avatar up to 2 MiB.
These settings persist in the native service-user record; the service identity remains `lilac`.
Authenticated participants see the same identity across threads. Avatar URLs include a content
revision and use the browser's private cache; changing the avatar changes its URL.

The browser caches versioned app assets and scoped conversation projections separately. Private
API responses never enter the service worker cache. Logout clears cached conversation data. An app update
offers a Reload button; drafts remain on the device until sent or cleared.

## Conversation behavior

New conversation opens a local draft. Typing or attaching files adds it to the sidebar; the server
thread is created on the first Send. Draft text survives reloads, while unsent files must be reattached.
The composer supports basic Markdown formatting through Plate. Enter sends; Shift+Enter continues
writing. Attachments appear as inline file chips. Drafts restored after reload require missing files
to be reattached or removed before sending. Sidebar rows show the starter and activity time; rename,
archive and delete replace the timestamp on hover or focus. A completed indicator remains until the
latest settled turn is visible in the foreground tab. Working and failed runs have separate states.

Settling or archiving a conversation stops its background jobs without telling the agent, as deleting
it does. Settling is a per-user preference, so it stops jobs only when that person has edit access.
Moving a conversation back does not restart them.

The thread's model selection applies to new full turns. Active runs retain their selected model.
With config v3, the picker searches the available provider catalog and configured aliases. Favorites
belong to the user; reasoning belongs to the thread and resets to the new model's default on a model
change. Favorites do not restrict models available to delegated agents. Subagent rows show the task,
permission profile, and executing model, including changes after fallback.
Sending while a run is active steers by default; follow-up mode queues a full turn. A steer that
arrives after the run stopped reading input becomes a follow-up, so it is still answered. Cancel drops
queued follow-ups. Users can remove queued entries but cannot reorder or edit them.
Custom commands sent during an active run automatically queue as follow-ups, including when the
composer was set to steering. They use the selected next-run model and execute at the start of that
new full turn.

Rewind targets a full user turn. It cancels active work, removes that turn and later history, and puts
the original text into the composer. Steering messages are not rewind targets. Rewind does not undo
external tool effects.

Attachments upload over HTTP. Sending accepts the message while upload continues; execution waits
for all file resources. Resource access follows the file's original thread, including when another
thread references it. Text previews return at most 64 KiB, with a truncation indicator for larger
files and an error for binary data. Local and SSH filepath previews read only that prefix of the
latest file and show an error when it is gone.

Markdown links and images accept retained `resource://r1_<128-bit-id>` references. They use the
authenticated resource endpoint and preserve the original resource's access rules. Transient
`resource://t1_` references and explicit SSH URIs are not supported in Markdown.

Settings > Deployment controls response streaming for the instance. Paragraph publishes text at
blank-line boundaries. Full publishes the buffered text at model-step completion or tool handoff. Clients never receive token-by-token text.
Compaction and activity remain explicit display events. Native structured questions use web question
cards; the TUI has no answer controls.

Old-message selection and storage retention are separate settings:
`oldMessageSelectionMaxAgeMs` and `storageRetentionMaxAgeMs`. Both default to `null`, which disables
them. Replay history has its own bounded retention; an expired replay cursor replaces the visible
window and leaves older history available for hydration.

## Conversation links

Use **Copy link** in a native conversation card's context menu, or right-click a native or Discord
message's copy button. A normal click still copies the message content. Paste a copied link into the
composer to insert an inline reference with the conversation's icon and title. Missing titles fall
back to the session ID. Title autocomplete is not included.

Click a reference to open a read-only tab in the right panel. Message links highlight the source
message and allow paging toward older and newer messages in its conversation. Session links open
at the latest messages. The context menu offers **Open in main view**, **Copy link**, and **Open in
Discord** where available. A response split across Discord messages links to its first source
message. Rows without a source message offer **Copy conversation link** instead.

Native previews update while open. Discord previews use retained agent history, not a live channel
fetch. Missing messages keep an external-open fallback. Existing membership and owner-only external
history rules apply to links. The agent receives session coordinates for session links, and the
conversation thread ID plus source message coordinates for message links when locally resolvable.
Core expands visible text and attachment metadata under the thread starter's authority, sharing a
12,000-character budget across previews. Message links preview that message; session and inclusive
range links page backward, preferring recent content. A range fixes its endpoints, while reads reflect
retained edits. Attachment bytes are not fetched by reference expansion.

## Rich content and previews

Select assistant text to create an `lilac-citation://v1/quote` reference with an optional comment.
Core expands valid citations into quoted context for prompts, follow-ups, and steering. The quote and
comment remain usable if the source changes or disappears. Encoded and expanded inputs must each
fit the existing 65,536-character limit.

Agents can publish an HTML page with a fenced `html-preview-file` block containing one file path.
At turn completion or failure, Core reads the file under the thread's filesystem permissions,
inlines local and retained resource assets, and saves the page as a native upload. The authenticated
preview uses a sandboxed opaque origin with scripts, forms, and popups enabled. Remote scripts may
load. Deleting the thread removes its preview records. A missing or unreadable source records a
failure instead of a saved page.

The built-in `visualize` skill is native-only. Custom skills can declare a nonempty `surfaces` list;
invalid lists cause the skill to be skipped. Skills without it remain available across surfaces.

## Permanent direct conversation

Each human user has one private direct conversation entry below Search, above the ordinary queues.
The entry and the conversation header show the agent's avatar and display name. The entry also
shows the last activity time, a one-line preview of the latest text message, and the working timer
while a reply runs.
Bootstrap creates it on first use. Its history stays available indefinitely. Sharing, renaming,
archiving, deletion, rewind, and storage-retention cleanup do not apply to this conversation.

Deployment settings expose "DM context gap (ms)", initially 7,200,000 ms. A request's context starts
at the first visible turn after the most recent pause longer than the gap. Delivered heartbeat and
surface messages participate in the same time group as human messages and primary replies. The gap
runs from a reply's completion or a delivered post's timestamp to the next message. The start stays
fixed while the conversation continues, so the model sees a
stable prefix. A request sent after a longer pause starts with no earlier history. Automatic or manual
compaction bounds a long session. Older messages remain searchable by their owner. An owner account cannot browse another user's DM.
The agent receives a brief instruction to follow the current topic in a mixed-topic conversation.
Delivered posts in that group enter the next primary request in timeline order without starting a run
themselves. Existing posts are included from retained display history; no database migration is needed.

The DM shows a timestamp above the first turn and above any turn sent at least "DM timestamp gap (ms)"
after the previous one, initially 1,800,000 ms, or on a new day. The turn where the selected context
starts adds a list-start icon to its timestamp, with a "Context starts here" tooltip. The marker reflects the next request when idle and the
current request while running. Messages represented by a summary have a tooltip.
During a reply the context refreshes once per second to reflect compaction. `/compact` summarizes
current model context through the existing compaction engine, even when automatic compaction is off.
It preserves the displayed messages and queues behind a running reply. It accepts no arguments,
skills, or attachments. Recent direct messages survive a shortened gap that excludes an older summary.

## DM links and agent delivery

Open `/dm` to return to your permanent DM. Its existing `/threads/<threadId>` URL remains valid
for links to that specific conversation.

Agents can use `surface.messages.send` with `client=native` and `sessionId=dm`. Native requests
resolve `dm` using the authenticated requesting user. Trusted agent runs from another surface, and
heartbeat runs, use the configured native owner's access after Core validates their control capability.
Restricted and unverified requests cannot use this cross-surface access. Other users' private DMs stay
inaccessible to the owner. The alias is documented in `surface.help` and native agent instructions.
For deferred delivery, call `surface.messages.list` with the same target and save the concrete
`meta.session.channelId` returned by Core. Heartbeat messages are visible assistant posts and do not
start another agent run in the destination thread. Cross-thread agent messages trigger a run only with explicit
`triggerRun: true` and the deployment setting enabled. Native is optional for heartbeat; see [heartbeat](heartbeat.md).

## Background notifications

Settings → Notifications has separate event choices and a Background push toggle. Enabling background
push registers this browser with Core, which sends encrypted Web Push when a response finishes or a
run fails. A surface post that does not start a run also sends a push under the completion preference,
unless the send uses `silent: true`. Notifications show Lilac, the thread title, and a short
assistant-response preview. Clicking
opens the thread. Viewing a visible, focused thread suppresses that user's background pushes on all
devices, even when push is disabled or unsupported on the viewing device. Focus clears when the tab
is hidden or blurred; disconnected tabs expire after 60 seconds without a presence heartbeat.

Successful responses notify the browser that submitted the turn first. If the response remains unread
60 seconds later, Core notifies the user's other eligible devices. Reading the response on any device
cancels that escalation. The read acknowledgment requires the selected conversation's latest completed
turn to be visible in a focused window; returning focus or reconnecting retries it.

If the initiating browser has no eligible push subscription, or its push request fails, Core sends to
other eligible devices immediately. Run failures and agent-initiated posts retain immediate broadcast
delivery. The initiating browser is identified by a hash of its push endpoint on the accepted input;
steering does not replace the turn's initiating device. Existing inputs without an identifier retain
broadcast behavior. Each user's subscriptions and read state remain separate in shared threads.

Delayed notifications are held only in memory. A Core restart during the 60-second delay drops the
pending escalation; startup does not replay it. Before sending, Core rechecks the same turn and history
generation, read status, access, archive state, viewing presence and current notification preferences.
Newer work cancels the earlier escalation.

Use HTTPS. On iOS/iPadOS 16.4 or newer, add Lilac to the Home Screen and enable notifications from the
installed web app. Core generates and retains signing keys automatically. No Firebase project or Apple
developer account is required. Core needs outbound HTTPS access to the browser's push service. Delivery
is best effort; failed transient sends are not queued. Explicit logout removes this browser's subscription.

## Structured question protocol

The Level 1 `question` tool defaults to deferred mode. It creates a `data-question` display part in the
request turn and returns a question-call ID. Normal replay, reconnect snapshots and turn hydration carry
that part. The agent may finish its current turn; the question remains pending until answered or
dismissed, including across Core restart. Deferred questions have no inactivity timeout.
`mode: "sync"` waits inside the tool call and retains a ten-minute timeout. Core startup interrupts
persisted sync calls whose live wait ended with the previous process.

`questions.read({ threadId, messageId })` returns the call, where `messageId` is its question-call ID.
`questions.pending({ threadId })` lists pending calls independently of the loaded history window.
`prompts` contains the complete set of questions. `view.prompt` retains the first prompt for display
compatibility. One freeform message answers the entire call; the agent interprets which answers the
message provides. The protocol does not enforce an option selection or an answer to every prompt.

Submit an ordinary native input with `questionReply: { messageId, token }`, using the first prompt's
`customToken`. Normal text and attachments are accepted, including an attachment-only reply. Input
acceptance and question resolution commit atomically; retries reuse the same command ID. Files must
finish uploading first. The reply reaches the model through normal native message delivery with the
original question context. The answered view links to the reply message. Explicit sync calls return a
`kind: "message"` answer with the reply text, message ID and attachment IDs. Replies to an active sync
call steer its existing run, even when the composer normally queues follow-ups.

`questions.dismiss` accepts thread ID, message ID, history generation and the same token. Only the
intended respondent with current thread edit access can answer or dismiss. Stale tokens, duplicate
answers under new command IDs and discarded history are rejected. The web uses its ordinary composer
for replies and attachments; numbered options populate the draft without sending. Other viewers see
read-only questions. The TUI has no question controls in this release.

## Surface tools

Native surface tools accept both `native:<threadId>` and the bare thread ID returned by listings.
Use `native:<threadId>` as the canonical session ID. `surface.sessions.list` paginates through all
readable active threads, subject to its requested limit. Set `archived: true` to list archived threads.
Message reads and lists include display names and reply context. Lilac's projected replies support
editing, deletion and reactions, including replies created before explicit author metadata was added.

`surface.messages.send` creates a separate message. `attachment.add_files` attaches a file to the
active response. Both copy files into managed blob storage and expose native resource attachments;
the original local file can then be removed. Active-response attachments participate in output replay,
checkpoint rollback and thread rewind. A canceled response retains attachments already published.

Recent agent writes include projected responses and tool-sent messages. Startup restores missing links
for historical responses whose native input records identify the owning request. It cannot infer the
owner of older standalone tool messages that have no request link.

`conversation.thread.search` and automatic recall use the same summary and embedding index for
Discord and native conversations. Both origins search all retained native threads and allowlisted
Discord conversations. Native ownership and sharing grants do not restrict these agent memory reads;
they still control native UI access and conversation modification. Deleted, rewound, pending-mutation,
and ephemeral native content is excluded. Explicit `participantId` filters remain available; automatic
participant filtering applies only within Discord when the request originates there.

Search supports lexical, semantic, and hybrid retrieval with shared ranking and `minScore` behavior.
Use `surface: native` or `surface: discord` to restrict a search. Compact results, metadata, reads, and
automatic recall include `surface`. Native conversation-memory IDs use `native:<threadId>` and can be
passed directly to `conversation.thread.read`. The DM is indexed per context window as
`native:<threadId>:<firstMessageId>`; its `native:<threadId>` ID reads the newest window. A thread
that covers several subjects returns one result per subject, with `offset` marking where that
subject starts in the thread. Summarization maintenance uses the shared runner and
supports native IDs, dry runs, force, clear, and embedding refresh. Structured questions use the
`question` tool and the [native question protocol](#structured-question-protocol).

## Temporary operator console

The container includes `lilac-tui`. From the installation directory, run:

```sh
docker compose exec --user root lilac lilac-tui
```

The installer offers "Talk to Lilac now" after deployment. Terminal-only installation needs a model
provider but no Discord, local password, or Clerk account. Web and Discord can be configured separately.

Each invocation creates one temporary owner conversation. Ctrl+Q exits, cancels active work, and deletes
the conversation using native deletion. If the terminal disappears, heartbeats stop and Core deletes the
conversation after 30 seconds. Reconnecting within that grace period keeps the same invocation alive.
Core cleans abandoned conversations before recovering agent work after restart. Temporary conversations
stay out of the web sidebar and search. Normal deletion and resource-retention rules apply; this is not
secure erasure of databases, logs, provider records, or backups. Files created by tools and external
side effects remain.

The console uses the existing native protocol and agent runner. Its separate HTTP/WebSocket listener
binds only to container loopback on port 8788, which is not published. Every request requires the root-only
`/run/lilac/operator-token` in an authorization header. Startup rotates that token; Core receives its
hash. The authenticated identity is the configured native owner. Tools still execute with the Core
service user's authority, never the terminal client's root identity.

There is no saved login, disk conversation cache, remote URL option, thread browser, or standalone TUI
release. The image's Bun runtime loads the root-owned console and dependencies. Local password and Clerk
web authentication continue to work independently. The legacy Clerk OAuth-client configuration is no
longer needed by the terminal.

Enter sends; Shift+Enter adds a line; Ctrl+C cancels work; Ctrl+Q exits. Ctrl+M selects a model and Ctrl+K
shows queued inputs. Use `$` or `/skill:` for skills and `/` for commands. `:help` lists the remaining
terminal commands. `:attach /path/to/file` reads a file inside the container. The console renders plain
text and strips terminal control sequences. It does not read the host clipboard.

For source development, `bun run dev:tui` connects to the same local operator endpoint. It requires
access to the operator token, just like the container command.

## Persistence and rollback

Back up `native-surface.db` together with Core's transcript, resource, request-delivery and agent-run
stores and managed blob data. Use the normal coordinated shutdown or a consistent SQLite backup;
copying a live database without its WAL can lose accepted work.

Native input receipts and upload readiness are durable before execution admission. Native output
uses a managed nonexpiring event topic; projection receipts make replay idempotent. Agent-run
checkpoints record the output frontier they cover, so restart retains the committed prefix and removes
abandoned output. External tool effects still have the existing at-least-once recovery behavior.

See [MIGRATIONS.md](../MIGRATIONS.md) before downgrading. Older builds do not understand native refs,
resource origins or native recovery checkpoint fields. Drain work and keep a consistent backup before
switching binaries.

## Diagnostics and compatibility

See [verification evidence and limits](native-surface-verification.md) for deployment, authentication,
terminal/browser checks and the previous performance baseline.

Backend, shared clients and display projection use native protocol version 1. Update the server and
clients together. Older web tabs retain assets until reload; terminal clients report an incompatible
response instead of interpreting another protocol version.

Debug logging under `surface:native:metrics` records connection IDs, application-frame byte counts,
bootstrap duration, replay kind/resets, queue pressure and handoff failures. Request and thread IDs
correlate output commits with socket enqueue timing. This timing ends at the server's socket send,
not at client rendering. Byte counters exclude TLS and WebSocket framing overhead. Metric fields
omit credentials and conversation bodies.

## Design system

Open `/design-system`, or use the palette button in the sidebar, to inspect the real UI components
with synthetic examples. The page requires no login and makes no requests for conversations or
configuration. It includes dark/light themes, thread states, messages, composer, attachment previews,
code blocks, controls, overlays and layout. Question cards use the ordinary composer for answers and attachments; the TUI has no question controls.
