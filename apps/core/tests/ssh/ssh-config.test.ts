import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readConfiguredSshHosts,
  readConfiguredSshHostsResult,
  SshConfigReadError,
} from "../../src/ssh/ssh-config";

describe("SSH config boundaries", () => {
  const previousConfigPath = process.env.LILAC_SSH_CONFIG_PATH;

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
    else process.env.LILAC_SSH_CONFIG_PATH = previousConfigPath;
  });

  it("captures config reads and preserves the legacy readError projection", async () => {
    process.env.LILAC_SSH_CONFIG_PATH = path.join(tmpdir(), "unreadable-ssh-config");
    const cause = new Error("config read denied");
    const dependencies = {
      exists: async () => true,
      readText: async () => Promise.reject(cause),
    };

    const read = await readConfiguredSshHostsResult(dependencies);
    expect(read.status).toBe("error");
    if (read.status === "error") {
      expect(SshConfigReadError.is(read.error)).toBeTrue();
      expect(read.error.cause).toBe(cause);
    }

    const projected = await readConfiguredSshHosts(dependencies);
    expect(projected.exists).toBeTrue();
    expect(projected.hosts).toEqual([]);
    expect(projected.readError).toBeString();
  });
});
