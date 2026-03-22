import { afterEach, describe, expect, it } from "bun:test";

import { parseEnv } from "../env";

const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  SQLITE_URL: process.env.SQLITE_URL,
};

afterEach(() => {
  if (ORIGINAL_ENV.DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_ENV.DATA_DIR;
  }

  if (ORIGINAL_ENV.SQLITE_URL === undefined) {
    delete process.env.SQLITE_URL;
  } else {
    process.env.SQLITE_URL = ORIGINAL_ENV.SQLITE_URL;
  }
});

describe("parseEnv", () => {
  it("derives the default sqlite path from DATA_DIR", () => {
    process.env.DATA_DIR = "/tmp/lilac-data";
    delete process.env.SQLITE_URL;

    const env = parseEnv();

    expect(env.dataDir).toBe("/tmp/lilac-data");
    expect(env.sqliteUrl).toBe("/tmp/lilac-data/data.sqlite3");
  });

  it("prefers SQLITE_URL when it is set", () => {
    process.env.DATA_DIR = "/tmp/lilac-data";
    process.env.SQLITE_URL = "/tmp/custom/workflows.sqlite3";

    const env = parseEnv();

    expect(env.sqliteUrl).toBe("/tmp/custom/workflows.sqlite3");
  });
});
