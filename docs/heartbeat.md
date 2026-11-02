# Proactive heartbeat

Use the built-in `heartbeat` skill to configure the lane through conversation. The runtime supplies
periodic idle wakes; editable Markdown defines responsibilities, discovery, next checks, and outreach.
Native is optional. There is no new scheduler, watch database, or setup UI.

## Deployment and setup

Deploy the updated Core. Existing `core-config.yaml` remains compatible. Missing workflow and working
notes are seeded, but existing files and old inbox notes are preserved. Managed prompt templates follow
the normal update/merge process; customized `AGENTS.md` may still contain old instructions.

In a trusted conversation, say:

> Use the heartbeat skill to set up proactive follow-ups. Migrate any old heartbeat notes, preserve my
> existing instructions, and verify the setup.

If no default exists, the agent asks where heartbeat output should go. Choose any supported destination
it can access, such as a Discord channel, a thread, or your native DM. The agent resolves the concrete
ID, validates and reloads the existing configuration, and reconciles the active workflow. It should
report configuration, actual execution, and delivery verification separately. Setup is incomplete when
an expected stage has not been observed.

Active files under `DATA_DIR/prompts`:

- `HEARTBEAT.md`: standing workflow and communication preferences.
- `heartbeat/WORK.md`: short routes to unresolved topics, next actions or resume conditions, and the
  latest discovery cursor and coverage gap.
- `heartbeat/topics/<topic>.md`: current watch state, evidence links, authorization and delivery
  instructions, last communicated finding, next check, and stopping condition.
- `heartbeat/archive/<topic>.md`: concise closed outcomes and source references when useful for
  preventing duplicate work or explaining a decision. Read matching records on demand.

Conversation and heartbeat can both make targeted edits. Replace superseded state and unchanged-check
timestamps instead of appending history. Remove settled topics from the active index. Existing
monolithic notes need a conversational migration using the skill's migration reference; deployment
preserves them and customized workflows.

The `heartbeat` skill's migration reference preserves unfinished work and explicit destinations. Old
inbox/archive files stay available until conversion is verified. They are no longer the routine handoff
mechanism after migration.

## Test after deployment

1. **Default delivery.** Ask for a temporary heartbeat watch due now that sends one uniquely labeled
   setup message to the default destination and stops after success. Let the conversation become idle.
   Check the received message, its recorded reference, and the archived outcome. If you temporarily
   shorten the cron interval, restore it after verification.
2. **Thread override.** In another thread, ask: “Watch this test event and keep me posted here. On the
   next heartbeat, send one test update and finish.” Confirm the linked topic file records that concrete thread.
   The update should appear there, not in the default channel. On native, receiving it should not start
   another agent run. Reply in the thread to continue the conversation.
3. **Explicit watch.** Ask the agent to monitor a changing source you control. Change the source,
   verify a meaningful update, then leave it unchanged across another due check. The notes should
   advance without repeating the same notification. Cancel the watch through conversation.
4. **Discovery.** Discuss an unresolved matter with a later decision point, without explicitly asking
   for monitoring. After a discovery pass, inspect the notes. If selected, the watch should cite that
   conversation, explain its relevance, and use the default destination unless you previously specified
   an override. Selection is a judgment call, so absence alone is not a scheduler failure.
5. **Unavailable destination.** Remove access to a temporary watch target. A due finding should remain
   pending with a delivery problem in the notes, rather than being silently posted to another channel.

## Expected experience and limits

“Keep me posted here” captures the current thread. A watch without an override follows the configured
default. The evidence source and delivery target are separate. The agent can discover follow-ups,
continue checking them, and surface changed evidence or useful decisions. It records what it already
reported and what remains unresolved. You can edit responsibilities, cadence, and preferences through
conversation; the skill handles files and the existing config.

Heartbeat defaults to disabled with a 30-minute cron cadence. Setup enables it after establishing the
destination. Active external requests defer heartbeat, as does the default five-minute quiet period
after activity. Due times in notes are evaluated on the next available wake; this is not an exact-time
reminder service. Continuous activity can delay work. Soft quiet hours are model instructions, not a
hard transport block.

Recent activity discovery lists agent writes and then reads relevant conversations; it is not a complete
feed of all user activity. Autonomous watch selection and notification quality depend on the model,
workflow, accessible evidence, and available execution time. No model behavior is proven merely by
passing runtime tests. Logs and transcripts distinguish a scheduled run from a configuration edit, and
message reads or user confirmation establish actual delivery.

Heartbeat can delegate with the configured subagent permission profiles. Children retain heartbeat's Level 2
callable allowlist and principal-less authority, with the selected profile's restrictions applied as
well. Results return to the heartbeat parent through the existing workflow completion path, including
after recovery. The parent handles watch notifications. Existing depth limits, timeouts, and parent
cancellation apply.
