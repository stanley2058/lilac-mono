#!/usr/bin/env bun
process.env.LILAC_ACP_COMPAT_BIN = "lilac-opencode";
process.env.LILAC_ACP_ENTRYPOINT = new URL("./index.js", import.meta.url).pathname;
process.argv.push("--harness", "opencode");
import "./client.js";
