import { describe, expect, it } from "bun:test";

import {
  computeRunnerFingerprint,
  readFingerprintRecord,
  readPackageManifest,
} from "../../../scripts/remote-fs-runner-fingerprint";

describe("published remote fs runner fingerprint", () => {
  it("matches the inputs recorded for the current package version", async () => {
    const manifest = await readPackageManifest();
    const recorded = await readFingerprintRecord();
    const spec = `${manifest.name}@${manifest.version}`;

    expect(
      recorded?.version,
      `packages/remote-fs-runner/published-fingerprint.json has no record for ${spec}. ` +
        "Publish this version, then run `bun run remote-fs:fingerprint`.",
    ).toBe(manifest.version);
    expect(
      await computeRunnerFingerprint(),
      `The remote fs runner changed since ${spec} was recorded. Core pins remote hosts to ` +
        `${spec} from npm, so they would keep running the old code. Bump the version in ` +
        "packages/remote-fs-runner/package.json, publish it, then run " +
        "`bun run remote-fs:fingerprint`. See DEVELOPMENT.md.",
    ).toBe(recorded?.fingerprint ?? "no recorded fingerprint");
  });
});
