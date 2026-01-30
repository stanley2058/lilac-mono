import { describe, expect, it } from "bun:test";

import { parseSshHostsFromConfigText } from "../../src/tool-server/tools/ssh";

describe("parseSshHostsFromConfigText", () => {
  it("parses simple Host aliases", () => {
    const text = `
Host foo
  HostName example.com

Host bar baz
  User ubuntu
`;

    expect(parseSshHostsFromConfigText(text)).toEqual(["foo", "bar", "baz"]);
  });

  it("ignores wildcard and negated entries", () => {
    const text = `
Host *
  ForwardAgent no

Host foo*
  HostName example.com

Host !bad good
  HostName example.org
`;

    expect(parseSshHostsFromConfigText(text)).toEqual(["good"]);
  });

  it("ignores comments", () => {
    const text = `
# Host commented
Host alpha # trailing comment
  HostName example.com
`;

    expect(parseSshHostsFromConfigText(text)).toEqual(["alpha"]);
  });
});
