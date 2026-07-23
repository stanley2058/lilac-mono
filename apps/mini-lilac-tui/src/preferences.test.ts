import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bindingPreferenceServerKey,
  bindingPreferencesPath,
  loadBindingPreferences,
  saveBindingPreferences,
} from "./preferences";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("binding preferences", () => {
  it("stores the last bindings by server", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-preferences-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "nested", "preferences.json");
    await saveBindingPreferences(filePath, {
      version: 1,
      servers: {
        "http://server-a/api": {
          model: "openai/gpt-test",
          profile: "coding",
          reasoning: "high",
        },
      },
    });

    expect(await loadBindingPreferences(filePath)).toEqual({
      version: 1,
      servers: {
        "http://server-a/api": {
          model: "openai/gpt-test",
          profile: "coding",
          reasoning: "high",
        },
      },
    });
  });

  it("uses XDG_STATE_HOME and treats a missing file as empty", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-state-home-"));
    temporaryDirectories.push(directory);
    const filePath = bindingPreferencesPath({ XDG_STATE_HOME: directory });

    expect(filePath).toBe(path.join(directory, "mini-lilac", "preferences.json"));
    expect(await loadBindingPreferences(filePath)).toEqual({ version: 1, servers: {} });
  });

  it("uses one preference key for equivalent trailing-slash URLs", () => {
    expect(bindingPreferenceServerKey("http://server/api///")).toBe("http://server/api");
    expect(bindingPreferenceServerKey("http://server/api")).toBe("http://server/api");
  });
});
