import { afterAll } from "bun:test";

import {
  createOwnedTestTempRoot,
  reapStaleTestTempRoots,
  removeOwnedTestTempRoot,
  selectTestTempBaseDirectory,
  TEST_TEMP_ROOT_BASE_ENV,
} from "./test-temp-root";

const baseDirectory = selectTestTempBaseDirectory({
  explicitBase: process.env[TEST_TEMP_ROOT_BASE_ENV],
});
process.env[TEST_TEMP_ROOT_BASE_ENV] = baseDirectory;

reapStaleTestTempRoots(baseDirectory);

const testTempRoot = createOwnedTestTempRoot(baseDirectory);
process.env.DATA_DIR = testTempRoot.dataDirectory;
process.env.TMPDIR = testTempRoot.tempDirectory;

// DATA_DIR starts empty and nothing supervises ModelCatalogCache here, so its first read awaits a live
// 6 MB download that can outlast the 5s test timeout. A failed refresh keeps the bundled snapshot.
const networkFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    input === "https://models.dev/api.json"
      ? Promise.resolve(new Response(null, { status: 503 }))
      : networkFetch(input, init),
  { preconnect: networkFetch.preconnect },
);

const cleanup = () => removeOwnedTestTempRoot(testTempRoot);

afterAll(cleanup);
process.once("exit", cleanup);
