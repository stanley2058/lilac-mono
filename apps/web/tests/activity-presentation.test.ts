import { describe, expect, it } from "bun:test";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import {
  activityGroupSummary,
  activityRowKind,
  activityRowTitle,
  commandProgramName,
  subagentLabelProfile,
  flattenMarkdown,
  formatDuration,
  liveActivityLabel,
} from "../src/activity-presentation";

type ActivityPart = Extract<DisplayPart, { type: "data-activity" }>;
function tool(label: string): ActivityPart {
  return {
    type: "data-activity",
    id: label.replace(/\W/g, "_"),
    data: { kind: "tool", label, state: "complete" },
  };
}

describe("activity presentation", () => {
  it("counts distinct edited files", () => {
    expect(activityGroupSummary([tool("edit a.ts"), tool("edit a.ts")])).toBe("Changed 1 file");
    expect(activityGroupSummary([tool("patch a.ts (+2)"), tool("edit b.ts")])).toBe(
      "Changed 4 files",
    );
  });
  it("counts every distinct path when edit details list them", () => {
    const edit = (label: string, detail: string): ActivityPart => ({
      ...tool(label),
      id: detail.replace(/\W/g, "_"),
      data: { kind: "tool", label, detail, state: "complete" },
    });
    expect(
      activityGroupSummary([
        edit("edit a.ts", "edit a.ts"),
        edit("apply_patch a.ts (+2)", "apply_patch a.ts\nb.ts\nc.ts"),
      ]),
    ).toBe("Changed 3 files");
    expect(
      activityGroupSummary([
        edit("apply_patch a.ts (+2)", "apply_patch a.ts\nb.ts\nc.ts"),
        edit("edit b.ts", "edit b.ts"),
      ]),
    ).toBe("Changed 3 files");
  });
  it("falls back to label counts for stored parts whose detail repeats the label", () => {
    const stored = (label: string): ActivityPart => ({
      ...tool(label),
      data: { kind: "tool", label, detail: label, state: "complete" },
    });
    expect(activityGroupSummary([stored("apply_patch a.ts (+2)"), stored("edit b.ts")])).toBe(
      "Changed 4 files",
    );
  });
  it("keeps compound commands that only start with a shell wrapper", () => {
    expect(activityRowTitle(tool("bash bash -lc 'echo one' && printf 'two'"))).toBe(
      "bash -lc 'echo one' && printf 'two'",
    );
    expect(activityRowTitle(tool("bash sh -c 'echo one'"))).toBe("echo one");
  });
  it("unwraps shell wrappers in titles and live labels", () => {
    const part = tool('bash /bin/bash -lc "bun test"');
    expect(activityRowTitle(part)).toBe("bun test");
    expect(liveActivityLabel(part)).toBe("Running bun");
  });
  it("summarizes the two most significant categories and counts the rest", () => {
    expect(activityGroupSummary([tool("bash ls"), tool("bash pwd")])).toBe("Ran 2 commands");
    expect(activityGroupSummary([tool("bash ls"), tool("weather.lookup {}")])).toBe(
      "Ran 1 command and used 1 tool",
    );
    expect(
      activityGroupSummary([tool("read a.md"), tool("bash ls"), tool("grep x"), tool("x.y")]),
    ).toBe("Read 1 file, ran 1 command, and performed 2 other actions");
  });
  it("does not count reasoning as an action", () => {
    const thought: ActivityPart = {
      type: "data-activity",
      id: "t",
      data: { kind: "thinking", label: "Thinking", state: "complete", detail: "**Plan** next" },
    };
    expect(activityGroupSummary([thought, tool("edit a.ts")])).toBe("Changed 1 file");
    expect(activityGroupSummary([thought, thought])).toBe("Thought (×2)");
    expect(activityRowTitle(thought)).toBe("Plan next");
  });
  it("titles commands by the command and live commands by the program", () => {
    const part = tool("bash @sd:~/repo FOO=1 /usr/local/bin/search.sh --since 1d");
    expect(activityRowTitle(part)).toBe("@sd:~/repo FOO=1 /usr/local/bin/search.sh --since 1d");
    expect(liveActivityLabel(part)).toBe("Running search.sh");
    expect(commandProgramName("cd apps/web && bun test")).toBe("bun");
  });
  it("flattens markdown and formats durations", () => {
    expect(flattenMarkdown("## Title\n\n- `code` and [link](http://x)")).toBe(
      "Title code and link",
    );
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
  it("shows a web row for commands that start with a tools web call", () => {
    const search = tool('bash tools web.search "rain; Kyoto" && cat ~/notes/a.md');
    expect(activityRowKind(search)).toBe("web");
    expect(activityRowTitle(search)).toBe("rain; Kyoto");
    expect(liveActivityLabel(search)).toBe("rain; Kyoto");
    const fetch = tool(
      "bash bash -lc 'tools web.fetch --url=https://example.com/a; tools web.search b'",
    );
    expect(activityRowKind(fetch)).toBe("web");
    expect(activityRowTitle(fetch)).toBe("https://example.com/a");
    expect(activityRowKind(tool("bash cat a; tools web.search b"))).toBe("command");
    expect(activityRowKind(tool("bash tools resource.read x"))).toBe("command");
    expect(activityGroupSummary([search, fetch])).toBe("Searched the web 2 times");
  });
  it("titles first-level tools from their native JSON arguments", () => {
    expect(activityRowTitle(tool('read {"path":"~/notes/a.md"}'))).toBe("~/notes/a.md");
    expect(activityRowTitle(tool('grep {"pattern":"museum","path":"~/notes"}'))).toBe(
      "museum in ~/notes",
    );
    expect(activityRowTitle(tool('glob {"patterns":["*.md","*.txt"],"cwd":"docs"}'))).toBe(
      "*.md, *.txt in docs",
    );
    expect(activityRowTitle(tool('fuzzy_search {"query":"route"}'))).toBe("route");
    expect(
      activityRowTitle(tool('subagent_delegate {"profile":"general","task":"Check hours"}')),
    ).toBe("Check hours");
    expect(activityRowTitle(tool('read {"path":'))).toBe('read {"path":');
    expect(activityRowTitle(tool("read a.md"))).toBe("read a.md");
  });
  it("titles edits by their changed paths", () => {
    const edit = tool('edit {"path":"a.ts","oldText":"x","newText":"y"}');
    expect(activityRowTitle(edit)).toBe("a.ts");
    expect(activityGroupSummary([edit, edit])).toBe("Changed 1 file");
    const patch: ActivityPart = {
      ...tool('patch {"patchText":"..."}'),
      data: {
        kind: "tool",
        label: 'patch {"patchText":"..."}',
        detail: "patch a.ts\nb.ts\nc.ts",
        state: "complete",
      },
    };
    expect(activityRowTitle(patch)).toBe("a.ts (+2)");
  });
  it("reads subagent profiles from native and legacy labels", () => {
    expect(subagentLabelProfile(tool('subagent_delegate {"profile":"explore","task":"x"}'))).toBe(
      "explore",
    );
    expect(subagentLabelProfile(tool("subagent (general; 1/2 done)"))).toBe("general");
    expect(
      subagentLabelProfile(tool('subagent_delegate {"permissions":"offline","task":"x"}')),
    ).toBe("offline");
    expect(subagentLabelProfile(tool("subagent (restricted; scout; 0/1 done)"))).toBe("restricted");
    expect(subagentLabelProfile(tool("bash ls"))).toBeUndefined();
  });
  it("decodes long arguments from the detail when Core truncated the label", () => {
    const full = `subagent_delegate {"profile":"general","task":"${"Check the museum. ".repeat(20)}"}`;
    const part: ActivityPart = {
      ...tool(full.slice(0, 256)),
      data: { kind: "tool", label: full.slice(0, 256), detail: full, state: "running" },
    };
    expect(activityRowTitle(part)).toBe("Check the museum. ".repeat(20).trim());
    expect(subagentLabelProfile(part)).toBe("general");
  });
});
