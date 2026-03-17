import { describe, expect, it } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";

import {
  handleCoreConfigWatchEvent,
  type CoreConfigWatchState,
} from "../../src/runtime/core-config-watch";

function createLoggerStub() {
  return createLogger({
    module: "core-config-watch-test",
  });
}

function createState(lastContent = "before"): CoreConfigWatchState {
  return { lastContent };
}

describe("handleCoreConfigWatchEvent", () => {
  it("updates cached content and schedules validation on change", async () => {
    const scheduled: string[] = [];
    const state = createState("before");

    await handleCoreConfigWatchEvent({
      configPath: "/data/core-config.yaml",
      configFileName: "core-config.yaml",
      eventType: "change",
      filename: "core-config.yaml",
      state,
      logger: createLoggerStub(),
      scheduleValidation: (reason) => {
        scheduled.push(reason);
      },
      readFile: async () => "after",
    });

    expect(state.lastContent).toBe("after");
    expect(scheduled).toEqual(["watch"]);
  });

  it("swallows ENOENT during atomic save and schedules validation", async () => {
    const scheduled: string[] = [];
    const state = createState("before");

    await handleCoreConfigWatchEvent({
      configPath: "/data/core-config.yaml",
      configFileName: "core-config.yaml",
      eventType: "rename",
      filename: "core-config.yaml",
      state,
      logger: createLoggerStub(),
      scheduleValidation: (reason) => {
        scheduled.push(reason);
      },
      readFile: async () => {
        const error = new Error("missing") as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      },
    });

    expect(state.lastContent).toBe("before");
    expect(scheduled).toEqual(["watch"]);
  });
});
