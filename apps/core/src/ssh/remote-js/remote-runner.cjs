// Remote tool runner executed via bun/node over SSH.
//
// Input: a single JSON object on stdin.
// Output: a single JSON object on stdout: { ok: true, value } or { ok: false, error }.
//
// This file is sent to the remote host as plain JS to avoid escaping/quoting
// problems and to keep the logic out of giant template strings.

const fssync = require("node:fs");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

function ok(value) {
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}

function expandTilde(p) {
  if (typeof p !== "string") return "";
  const home = process.env.HOME || "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function isDeniedPath(resolvedPath, denyAbs) {
  const normalized = path.resolve(resolvedPath);
  for (const deny of denyAbs) {
    if (normalized === deny) return true;
    if (normalized.startsWith(deny + path.sep)) return true;
  }
  return false;
}

function assertAllowed(resolvedPath, denyAbs, op) {
  if (!denyAbs || denyAbs.length === 0) return;
  if (isDeniedPath(resolvedPath, denyAbs)) {
    throw new Error(
      "Access denied: '" + resolvedPath + "' is blocked for " + op,
    );
  }
}

function getFileTypeFromStats(stats) {
  try {
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    if (stats.isSocket && stats.isSocket()) return "socket";
    if (stats.isBlockDevice && stats.isBlockDevice()) return "block_device";
    if (stats.isCharacterDevice && stats.isCharacterDevice())
      return "character_device";
    if (stats.isFIFO && stats.isFIFO()) return "fifo";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function toPosixRel(relPath) {
  return relPath.split(path.sep).join("/");
}

async function walkDir(baseAbs, cb, state, denyAbs) {
  const stack = [baseAbs];
  while (stack.length > 0) {
    const dirAbs = stack.pop();
    if (!dirAbs) continue;
    if (isDeniedPath(dirAbs, denyAbs)) continue;
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (state.stop) return;
      const abs = path.join(dirAbs, ent.name);
      if (isDeniedPath(abs, denyAbs)) continue;
      await cb(abs, ent);
      if (state.stop) return;
      if (ent.isDirectory()) {
        stack.push(abs);
      }
    }
  }
}

function globToRegExp(glob) {
  // Minimal glob -> regex: supports **, *, ?, and basic character classes.
  // We match against posix-style paths.
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      const next = glob[i + 1];
      if (next === "*") {
        while (glob[i] === "*") i++;
        if (glob[i] === "/") i++;
        re += "(?:.*)?";
        continue;
      }
      i++;
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      i++;
      re += "[^/]";
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      while (j < glob.length && glob[j] !== "]") j++;
      if (j < glob.length) {
        const cls = glob.slice(i, j + 1);
        re += cls;
        i = j + 1;
        continue;
      }
    }
    if (".\\+^$(){}|".includes(ch)) re += "\\" + ch;
    else re += ch;
    i++;
  }
  re += "$";
  return new RegExp(re);
}

function compileGlobFilters(patterns) {
  const includes = [];
  const excludes = [];
  for (const p of patterns) {
    if (typeof p !== "string" || p.length === 0) continue;
    if (p.startsWith("!")) excludes.push(globToRegExp(p.slice(1)));
    else includes.push(globToRegExp(p));
  }
  return { includes, excludes };
}

function matchesGlobs(relPosix, filters) {
  if (filters.includes.length === 0) return false;
  let inc = false;
  for (const r of filters.includes) {
    if (r.test(relPosix)) {
      inc = true;
      break;
    }
  }
  if (!inc) return false;
  for (const r of filters.excludes) {
    if (r.test(relPosix)) return false;
  }
  return true;
}

function isLikelyBinary(buf) {
  if (!buf || typeof buf.length !== "number" || buf.length === 0) return false;
  const sampleSize = Math.min(buf.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < sampleSize; i++) {
    const byte = buf[i];
    if (byte === 0) return true;
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControl || byte === 127) {
      suspicious += 1;
    }
  }
  return suspicious / sampleSize > 0.3;
}

async function opReadText(input, denyAbs) {
  const inPath = String(input.path || "");
  const expanded = expandTilde(inPath);
  const resolvedPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(process.cwd(), expanded);

  if (isDeniedPath(resolvedPath, denyAbs)) {
    return {
      success: false,
      resolvedPath,
      error: {
        code: "PERMISSION",
        message:
          "Access denied: '" + resolvedPath + "' is blocked for readFile",
      },
    };
  }

  const startLine = Number.isFinite(input.startLine)
    ? Number(input.startLine)
    : 1;
  const maxLines = Number.isFinite(input.maxLines)
    ? Number(input.maxLines)
    : 2000;
  const maxCharacters = Number.isFinite(input.maxCharacters)
    ? Number(input.maxCharacters)
    : 10000;
  const format = input.format === "numbered" ? "numbered" : "raw";

  try {
    const file = await fs.readFile(resolvedPath, "utf8");
    const fileHash = crypto.createHash("sha256").update(file).digest("hex");
    const lines = file.split("\n");
    const totalLines = lines.length;

    const normalizedStartLine = Math.min(
      Math.max(1, startLine),
      totalLines + 1,
    );
    const startIndex = normalizedStartLine - 1;
    const windowLines = lines.slice(startIndex, startIndex + maxLines);
    const endLine = normalizedStartLine + windowLines.length - 1;
    const hasMoreLines = endLine < totalLines;

    let output;
    if (format === "numbered") {
      const digits = Math.max(
        1,
        String(Math.max(endLine, normalizedStartLine)).length,
      );
      output = windowLines
        .map(
          (line, i) =>
            String(normalizedStartLine + i).padStart(digits, " ") + "| " + line,
        )
        .join("\n");
    } else {
      output = windowLines.join("\n");
    }

    const truncatedByChars = output.length > maxCharacters;
    output = output.slice(0, maxCharacters);

    const base = {
      success: true,
      resolvedPath,
      fileHash,
      startLine: normalizedStartLine,
      endLine,
      totalLines,
      hasMoreLines,
      truncatedByChars,
      format,
    };

    if (format === "numbered") return { ...base, numberedContent: output };
    return { ...base, content: output };
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    const errorCode =
      code === "ENOENT"
        ? "NOT_FOUND"
        : code === "EACCES" || code === "EPERM"
          ? "PERMISSION"
          : "UNKNOWN";
    return {
      success: false,
      resolvedPath,
      error: { code: errorCode, message: msg },
    };
  }
}

async function opReadBytes(input, denyAbs) {
  const inPath = String(input.path || "");
  const expanded = expandTilde(inPath);
  const resolvedPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(process.cwd(), expanded);

  if (isDeniedPath(resolvedPath, denyAbs)) {
    return {
      ok: false,
      resolvedPath,
      error: "Access denied: '" + resolvedPath + "' is blocked for readFile",
    };
  }

  const maxBytes = Number.isFinite(input.maxBytes)
    ? Number(input.maxBytes)
    : 10_000_000;

  try {
    const st = await fs.stat(resolvedPath);
    if (st.size > maxBytes) {
      return {
        ok: false,
        resolvedPath,
        error:
          "Remote file too large (" +
          st.size +
          " bytes). Max allowed is " +
          maxBytes +
          ".",
      };
    }
    const bytes = await fs.readFile(resolvedPath);
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      ok: true,
      resolvedPath,
      fileHash,
      bytesLength: bytes.byteLength,
      base64: Buffer.from(bytes).toString("base64"),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, resolvedPath, error: msg };
  }
}

async function opGlob(input, denyAbs) {
  const patterns = Array.isArray(input.patterns)
    ? input.patterns.map(String)
    : [];
  const maxEntries = Number.isFinite(input.maxEntries)
    ? Number(input.maxEntries)
    : 100;
  const mode = input.mode === "detailed" ? "detailed" : "default";

  const filters = compileGlobFilters(patterns);
  const baseAbs = path.resolve(process.cwd());
  if (isDeniedPath(baseAbs, denyAbs)) {
    if (mode === "default") {
      return {
        mode,
        truncated: false,
        paths: [],
        error: "Access denied: '" + baseAbs + "' is blocked for glob",
      };
    }
    return {
      mode,
      truncated: false,
      entries: [],
      error: "Access denied: '" + baseAbs + "' is blocked for glob",
    };
  }

  const paths = [];
  const entries = [];
  const state = { stop: false };
  let truncated = false;

  await walkDir(
    baseAbs,
    async (abs, ent) => {
      if (state.stop) return;
      const rel = path.relative(baseAbs, abs);
      const relPosix = toPosixRel(rel);
      if (!matchesGlobs(relPosix, filters)) return;

      if (mode === "default") {
        if (paths.length >= maxEntries) {
          truncated = true;
          state.stop = true;
          return;
        }
        paths.push(relPosix);
        return;
      }

      if (entries.length >= maxEntries) {
        truncated = true;
        state.stop = true;
        return;
      }

      let stats;
      try {
        stats = await fs.lstat(abs);
      } catch {
        return;
      }

      entries.push({
        path: relPosix,
        type: getFileTypeFromStats(stats),
        size: typeof stats.size === "number" ? stats.size : 0,
      });
    },
    state,
    denyAbs,
  );

  if (mode === "default") {
    return {
      mode,
      truncated,
      paths,
    };
  }

  return {
    mode,
    truncated,
    entries,
  };
}

async function opGrep(input, denyAbs) {
  const pattern = String(input.pattern || "");
  const regex = Boolean(input.regex);
  const maxResults = Number.isFinite(input.maxResults)
    ? Number(input.maxResults)
    : 100;
  const includeContextLines = Number.isFinite(input.includeContextLines)
    ? Number(input.includeContextLines)
    : 0;
  const mode = input.mode === "detailed" ? "detailed" : "default";
  const fileExtensions = Array.isArray(input.fileExtensions)
    ? input.fileExtensions.map((e) => String(e).replace(/^\./, ""))
    : [];

  let re = null;
  if (regex) {
    try {
      re = new RegExp(pattern, "g");
    } catch (e) {
      if (mode === "default") {
        return {
          mode,
          truncated: false,
          results: [],
          error: "Invalid regex: " + (e instanceof Error ? e.message : String(e)),
        };
      }
      return {
        mode,
        truncated: false,
        results: [],
        error: "Invalid regex: " + (e instanceof Error ? e.message : String(e)),
      };
    }
  }

  const baseAbs = path.resolve(process.cwd());
  if (isDeniedPath(baseAbs, denyAbs)) {
    if (mode === "default") {
      return {
        mode,
        truncated: false,
        results: [],
        error: "Access denied: '" + baseAbs + "' is blocked for grep",
      };
    }
    return {
      mode,
      truncated: false,
      results: [],
      error: "Access denied: '" + baseAbs + "' is blocked for grep",
    };
  }

  const contextTextFor = (lines, idx) => {
    if (!includeContextLines || includeContextLines <= 0) {
      return (lines[idx] || "") + "\n";
    }
    const startIdx = Math.max(0, idx - includeContextLines);
    const endIdx = Math.min(lines.length - 1, idx + includeContextLines);
    return lines.slice(startIdx, endIdx + 1).join("\n") + "\n";
  };

  const detailedResults = [];
  const defaultResults = [];
  const state = { stop: false };
  let truncated = false;

  const toDefaultResult = (file, line, text) => ({
    file,
    line,
    text,
  });

  const extSet = new Set(fileExtensions);
  const shouldCheckExt = extSet.size > 0;

  await walkDir(
    baseAbs,
    async (abs, ent) => {
      if (state.stop) return;
      if (!ent.isFile()) return;
      if (shouldCheckExt) {
        const ext = path.extname(ent.name).replace(/^\./, "");
        if (!extSet.has(ext)) return;
      }

      let bytes;
      try {
        bytes = await fs.readFile(abs);
      } catch {
        return;
      }

      if (isLikelyBinary(bytes)) return;

      const content = bytes.toString("utf8");

      const relPosix = toPosixRel(path.relative(baseAbs, abs));
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] || "";
        if (!regex) {
          const submatches = [];
          let start = 0;
          while (true) {
            const idx = lineText.indexOf(pattern, start);
            if (idx === -1) break;
            submatches.push({ match: pattern, start: idx, end: idx + pattern.length });
            start = idx + Math.max(1, pattern.length);
          }

          if (submatches.length === 0) continue;

          const count =
            mode === "default" ? defaultResults.length : detailedResults.length;
          if (count >= maxResults) {
            truncated = true;
            state.stop = true;
            return;
          }

          const contextText = contextTextFor(lines, i);
          if (mode === "default") {
            defaultResults.push(toDefaultResult(relPosix, i + 1, contextText));
          } else {
            detailedResults.push({
              file: relPosix,
              line: i + 1,
              column: (submatches[0]?.start || 0) + 1,
              text: contextText,
              submatches,
            });
          }
        } else {
          re.lastIndex = 0;
          const submatches = [];
          while (true) {
            const m = re.exec(lineText);
            if (!m) break;
            const matchText = m[0] || "";
            const start = m.index || 0;
            const end = start + matchText.length;
            submatches.push({ match: matchText, start, end });
            if (matchText.length === 0) re.lastIndex++;
          }

          if (submatches.length === 0) continue;

          const count =
            mode === "default" ? defaultResults.length : detailedResults.length;
          if (count >= maxResults) {
            truncated = true;
            state.stop = true;
            return;
          }

          const contextText = contextTextFor(lines, i);
          if (mode === "default") {
            defaultResults.push(toDefaultResult(relPosix, i + 1, contextText));
          } else {
            detailedResults.push({
              file: relPosix,
              line: i + 1,
              column: (submatches[0]?.start || 0) + 1,
              text: contextText,
              submatches,
            });
          }
        }
      }
    },
    state,
    denyAbs,
  );

  if (mode === "default") {
    return {
      mode,
      truncated,
      results: defaultResults,
    };
  }

  return {
    mode,
    truncated,
    results: detailedResults,
  };
}

const EDIT_ERROR_CODES = [
  "NOT_FOUND",
  "PERMISSION",
  "UNKNOWN",
  "NOT_READ",
  "HASH_MISMATCH",
  "INVALID_RANGE",
  "RANGE_MISMATCH",
  "NO_MATCHES",
  "TOO_MANY_MATCHES",
  "NOT_ENOUGH_MATCHES",
  "INVALID_REGEX",
  "INVALID_EDIT",
];

function toEditErrorCode(rawCode) {
  if (typeof rawCode !== "string") return "UNKNOWN";
  return EDIT_ERROR_CODES.includes(rawCode) ? rawCode : "UNKNOWN";
}

function hashText(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function countExactOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    i = haystack.indexOf(needle, i);
    if (i === -1) break;
    count += 1;
    i += needle.length;
  }
  return count;
}

function replaceExactOccurrences(haystack, needle, replacement, maxReplacements) {
  if (needle.length === 0) {
    return { result: haystack, replacementsMade: 0 };
  }

  let replacementsMade = 0;
  let start = 0;
  let result = "";
  while (replacementsMade < maxReplacements) {
    const idx = haystack.indexOf(needle, start);
    if (idx === -1) break;
    result += haystack.slice(start, idx) + replacement;
    start = idx + needle.length;
    replacementsMade += 1;
  }

  result += haystack.slice(start);
  return { result, replacementsMade };
}

function countRegexMatches(haystack, re) {
  let count = 0;
  re.lastIndex = 0;
  while (true) {
    const match = re.exec(haystack);
    if (!match) break;
    count += 1;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return count;
}

function replaceRegexOccurrences(haystack, re, replacement, maxReplacements) {
  let replacementsMade = 0;
  let lastIndex = 0;
  let result = "";

  re.lastIndex = 0;
  while (replacementsMade < maxReplacements) {
    const match = re.exec(haystack);
    if (!match) break;

    result += haystack.slice(lastIndex, match.index) + replacement;
    lastIndex = match.index + match[0].length;
    replacementsMade += 1;

    if (match[0].length === 0) re.lastIndex += 1;
  }

  result += haystack.slice(lastIndex);
  return { result, replacementsMade };
}

function enforceExpectedMatches(matchesFound, expected, target) {
  if (expected === "any") {
    if (matchesFound === 0) {
      throw Object.assign(
        new Error("No matches found for target: " + target),
        { code: "NO_MATCHES" },
      );
    }
    return;
  }

  if (matchesFound === 0) {
    throw Object.assign(
      new Error("No matches found for target: " + target),
      { code: "NO_MATCHES" },
    );
  }

  if (matchesFound > expected) {
    throw Object.assign(
      new Error(
        "Too many matches found (" +
          matchesFound +
          "); expected " +
          expected +
          " for target: " +
          target,
      ),
      { code: "TOO_MANY_MATCHES" },
    );
  }

  if (matchesFound < expected) {
    throw Object.assign(
      new Error(
        "Not enough matches found (" +
          matchesFound +
          "); expected " +
          expected +
          " for target: " +
          target,
      ),
      { code: "NOT_ENOUGH_MATCHES" },
    );
  }
}

function validateRange(lines, startLine, endLine) {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    throw Object.assign(
      new Error(
        "Invalid range " +
          startLine +
          "-" +
          endLine +
          ". File has " +
          lines.length +
          " lines.",
      ),
      { code: "INVALID_RANGE" },
    );
  }
}

async function opEdit(input, denyAbs) {
  const inPath = String(input.path || "");
  const expanded = expandTilde(inPath);
  const resolvedPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(process.cwd(), expanded);

  try {
    assertAllowed(resolvedPath, denyAbs, "editFile");

    const edits = Array.isArray(input.edits) ? input.edits : [];
    const expectedHash =
      typeof input.expectedHash === "string" && input.expectedHash.length > 0
        ? input.expectedHash
        : undefined;

    const file = await fs.readFile(resolvedPath, "utf8");
    const oldHash = hashText(file);

    if (expectedHash && expectedHash !== oldHash) {
      return {
        success: false,
        resolvedPath,
        currentHash: oldHash,
        error: {
          code: "HASH_MISMATCH",
          message: "File has changed since last read: " + resolvedPath,
        },
      };
    }

    let lines = file.split("\n");
    let replacementsMade = 0;

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const type =
        edit && typeof edit === "object" && typeof edit.type === "string"
          ? edit.type
          : "";

      try {
        switch (type) {
          case "replace_range": {
            const range =
              edit && typeof edit === "object" && edit.range
                ? edit.range
                : {};
            const startLine = Number(range.startLine);
            const endLine = Number(range.endLine);
            const newText = String(edit.newText ?? "");
            const expectedOldText =
              typeof edit.expectedOldText === "string"
                ? edit.expectedOldText
                : undefined;

            validateRange(lines, startLine, endLine);

            if (expectedOldText !== undefined) {
              const actual = lines.slice(startLine - 1, endLine).join("\n");
              if (actual !== expectedOldText) {
                throw Object.assign(
                  new Error(
                    "Range content mismatch for " +
                      startLine +
                      "-" +
                      endLine +
                      ". Re-read the file and try again.",
                  ),
                  { code: "RANGE_MISMATCH" },
                );
              }
            }

            lines.splice(
              startLine - 1,
              endLine - startLine + 1,
              ...newText.split("\n"),
            );
            break;
          }
          case "insert_at": {
            const line = Number(edit.line);
            const newText = String(edit.newText ?? "");
            if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
              throw Object.assign(
                new Error(
                  "Invalid insert line " +
                    line +
                    ". Must be between 1 and " +
                    (lines.length + 1) +
                    ".",
                ),
                { code: "INVALID_RANGE" },
              );
            }

            lines.splice(line - 1, 0, ...newText.split("\n"));
            break;
          }
          case "delete_range": {
            const range =
              edit && typeof edit === "object" && edit.range
                ? edit.range
                : {};
            const startLine = Number(range.startLine);
            const endLine = Number(range.endLine);
            const expectedOldText =
              typeof edit.expectedOldText === "string"
                ? edit.expectedOldText
                : undefined;

            validateRange(lines, startLine, endLine);

            if (expectedOldText !== undefined) {
              const actual = lines.slice(startLine - 1, endLine).join("\n");
              if (actual !== expectedOldText) {
                throw Object.assign(
                  new Error(
                    "Range content mismatch for " +
                      startLine +
                      "-" +
                      endLine +
                      ". Re-read the file and try again.",
                  ),
                  { code: "RANGE_MISMATCH" },
                );
              }
            }

            lines.splice(startLine - 1, endLine - startLine + 1);
            break;
          }
          case "replace_snippet": {
            const target = String(edit.target ?? "");
            const matching = edit.matching === "regex" ? "regex" : "exact";
            const newText = String(edit.newText ?? "");
            const hasOccurrenceProp =
              edit &&
              typeof edit === "object" &&
              Object.prototype.hasOwnProperty.call(edit, "occurrence");
            let occurrence = "first";
            if (edit.occurrence === "all" || edit.occurrence === "first") {
              occurrence = edit.occurrence;
            } else if (typeof edit.occurrence === "number") {
              occurrence = edit.occurrence;
            } else if (hasOccurrenceProp && edit.occurrence !== undefined) {
              throw Object.assign(
                new Error("occurrence must be 'first', 'all', or a positive number"),
                { code: "INVALID_EDIT" },
              );
            }
            const expectedMatchesRaw =
              edit.expectedMatches === "any"
                ? "any"
                : Number(edit.expectedMatches);

            if (target.length === 0) {
              throw Object.assign(new Error("target must not be empty"), {
                code: "INVALID_EDIT",
              });
            }

            if (matching === "exact" && target === newText) {
              throw Object.assign(
                new Error("newText is identical to target; edit would be a no-op"),
                { code: "INVALID_EDIT" },
              );
            }

            if (
              typeof occurrence === "number" &&
              (!Number.isInteger(occurrence) || occurrence <= 0)
            ) {
              throw Object.assign(
                new Error("occurrence must be a positive number"),
                { code: "INVALID_EDIT" },
              );
            }

            const maxReplace =
              typeof occurrence === "number"
                ? occurrence
                : occurrence === "all"
                  ? Number.MAX_SAFE_INTEGER
                  : 1;

            let expectedMatches = 1;
            if (expectedMatchesRaw === "any") {
              expectedMatches = "any";
            } else if (
              Number.isInteger(expectedMatchesRaw) &&
              expectedMatchesRaw > 0
            ) {
              expectedMatches = expectedMatchesRaw;
            } else if ("expectedMatches" in edit) {
              throw Object.assign(
                new Error("expectedMatches must be a positive number or 'any'"),
                { code: "INVALID_EDIT" },
              );
            }

            const content = lines.join("\n");

            if (matching === "exact") {
              const matchesFound = countExactOccurrences(content, target);
              enforceExpectedMatches(matchesFound, expectedMatches, target);

              const replaced = replaceExactOccurrences(
                content,
                target,
                newText,
                maxReplace,
              );
              lines = replaced.result.split("\n");
              replacementsMade += replaced.replacementsMade;
            } else {
              let re;
              try {
                re = new RegExp(target, "g");
              } catch (e) {
                throw Object.assign(
                  new Error(
                    "Invalid regex: " +
                      (e instanceof Error ? e.message : String(e)),
                  ),
                  { code: "INVALID_REGEX" },
                );
              }

              const matchesFound = countRegexMatches(content, re);
              enforceExpectedMatches(matchesFound, expectedMatches, target);

              const replaced = replaceRegexOccurrences(
                content,
                re,
                newText,
                maxReplace,
              );
              lines = replaced.result.split("\n");
              replacementsMade += replaced.replacementsMade;
            }
            break;
          }
          default:
            throw Object.assign(
              new Error("Unknown edit type: " + String(type)),
              { code: "INVALID_EDIT" },
            );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code =
          e && typeof e === "object" && "code" in e
            ? toEditErrorCode(e.code)
            : "UNKNOWN";
        return {
          success: false,
          resolvedPath,
          currentHash: oldHash,
          error: { code, message: msg },
        };
      }
    }

    const nextContent = lines.join("\n");
    const newHash = hashText(nextContent);
    const changesMade = newHash !== oldHash;
    if (changesMade) {
      await fs.writeFile(resolvedPath, nextContent, "utf8");
    }

    return {
      success: true,
      resolvedPath,
      oldHash,
      newHash,
      changesMade,
      replacementsMade,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code =
      e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const errorCode =
      code === "ENOENT"
        ? "NOT_FOUND"
        : code === "EACCES" || code === "EPERM"
          ? "PERMISSION"
          : "UNKNOWN";

    return {
      success: false,
      resolvedPath,
      error: { code: errorCode, message: msg },
    };
  }
}

// apply_patch implementation (ported from local apply_patch tool)

function stripHeredoc(input) {
  const m = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (m) return m[2];
  return input;
}

function parsePatchHeader(lines, startIdx) {
  const line = lines[startIdx];
  if (line === undefined) return null;

  if (line.startsWith("*** Add File:")) {
    const filePath = line.split(":", 2)[1];
    return filePath
      ? { kind: "add", filePath: filePath.trim(), nextIdx: startIdx + 1 }
      : null;
  }
  if (line.startsWith("*** Delete File:")) {
    const filePath = line.split(":", 2)[1];
    return filePath
      ? { kind: "delete", filePath: filePath.trim(), nextIdx: startIdx + 1 }
      : null;
  }
  if (line.startsWith("*** Update File:")) {
    const filePath = line.split(":", 2)[1];
    let movePath = undefined;
    let nextIdx = startIdx + 1;
    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      const v = lines[nextIdx].split(":", 2)[1];
      movePath = v ? v.trim() : undefined;
      nextIdx += 1;
    }
    return filePath
      ? { kind: "update", filePath: filePath.trim(), movePath, nextIdx }
      : null;
  }
  return null;
}

function parseAddFileContent(lines, startIdx) {
  let content = "";
  let i = startIdx;
  while (i < lines.length && !lines[i].startsWith("***")) {
    const line = lines[i];
    if (line.startsWith("+")) {
      content += line.substring(1) + "\n";
    }
    i += 1;
  }
  if (content.endsWith("\n")) content = content.slice(0, -1);
  return { content, nextIdx: i };
}

function parseUpdateFileChunks(lines, startIdx) {
  const chunks = [];
  let i = startIdx;
  while (i < lines.length && !lines[i].startsWith("***")) {
    const line = lines[i];
    if (!line.startsWith("@@")) {
      i += 1;
      continue;
    }
    const contextLine = line.substring(2).trim();
    i += 1;
    const oldLines = [];
    const newLines = [];
    let isEndOfFile = false;
    while (
      i < lines.length &&
      !lines[i].startsWith("@@") &&
      !lines[i].startsWith("***")
    ) {
      const changeLine = lines[i];
      if (changeLine === "*** End of File") {
        isEndOfFile = true;
        i += 1;
        break;
      }
      if (changeLine.startsWith(" ")) {
        const c = changeLine.substring(1);
        oldLines.push(c);
        newLines.push(c);
      } else if (changeLine.startsWith("-")) {
        oldLines.push(changeLine.substring(1));
      } else if (changeLine.startsWith("+")) {
        newLines.push(changeLine.substring(1));
      }
      i += 1;
    }
    chunks.push({
      oldLines,
      newLines,
      changeContext: contextLine || undefined,
      isEndOfFile: isEndOfFile || undefined,
    });
  }
  return { chunks, nextIdx: i };
}

function parsePatch(patchText) {
  const cleaned = stripHeredoc(String(patchText || "").trim());
  const lines = cleaned.split("\n");
  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";
  const beginIdx = lines.findIndex((l) => l.trim() === beginMarker);
  const endIdx = lines.findIndex((l) => l.trim() === endMarker);
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const hunks = [];
  let i = beginIdx + 1;
  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i += 1;
      continue;
    }
    if (header.kind === "add") {
      const parsed = parseAddFileContent(lines, header.nextIdx);
      hunks.push({
        type: "add",
        path: header.filePath,
        contents: parsed.content,
      });
      i = parsed.nextIdx;
      continue;
    }
    if (header.kind === "delete") {
      hunks.push({ type: "delete", path: header.filePath });
      i = header.nextIdx;
      continue;
    }
    if (header.kind === "update") {
      const parsed = parseUpdateFileChunks(lines, header.nextIdx);
      hunks.push({
        type: "update",
        path: header.filePath,
        movePath: header.movePath,
        chunks: parsed.chunks,
      });
      i = parsed.nextIdx;
      continue;
    }
    i += 1;
  }

  if (hunks.length === 0) throw new Error("patch rejected: empty patch");
  return hunks;
}

function normalizeUnicode(str) {
  return String(str)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

function tryMatch(lines, pattern, startIndex, compare, eof) {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) {
          matches = false;
          break;
        }
      }
      if (matches) return fromEnd;
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function seekSequence(lines, pattern, startIndex, eof) {
  if (pattern.length === 0) return -1;

  let idx = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (idx !== -1) return idx;
  idx = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => String(a).trimEnd() === String(b).trimEnd(),
    eof,
  );
  if (idx !== -1) return idx;
  idx = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => String(a).trim() === String(b).trim(),
    eof,
  );
  if (idx !== -1) return idx;
  return tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) =>
      normalizeUnicode(String(a).trim()) === normalizeUnicode(String(b).trim()),
    eof,
  );
}

function computeReplacements(originalLines, filePath, chunks) {
  const replacements = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIdx = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (contextIdx === -1) {
        throw new Error(
          "Failed to find context '" + chunk.changeContext + "' in " + filePath,
        );
      }
      lineIndex = contextIdx + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 &&
        originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      Boolean(chunk.isEndOfFile),
    );

    if (
      found === -1 &&
      pattern.length > 0 &&
      pattern[pattern.length - 1] === ""
    ) {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        Boolean(chunk.isEndOfFile),
      );
    }

    if (found === -1) {
      throw new Error(
        "Failed to find expected lines in " +
          filePath +
          ":\n" +
          chunk.oldLines.join("\n"),
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function applyReplacements(lines, replacements) {
  const result = lines.slice();
  for (let i = replacements.length - 1; i >= 0; i--) {
    const rep = replacements[i];
    const startIdx = rep[0];
    const oldLen = rep[1];
    const newSegment = rep[2];
    result.splice(startIdx, oldLen);
    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j]);
    }
  }
  return result;
}

function resolvePath(baseDir, p) {
  const s = String(p || "");
  return path.isAbsolute(s) ? s : path.resolve(baseDir, s);
}

function toDisplayPath(resolved, baseDir) {
  const rel = path.relative(baseDir, resolved);
  if (!rel || rel === "") return path.basename(resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return resolved;
  return rel;
}

async function applyUpdateHunk(resolvedPath, moveToResolvedPath, chunks) {
  const originalContent = await fs.readFile(resolvedPath, "utf8");
  let originalLines = originalContent.split("\n");
  if (
    originalLines.length > 0 &&
    originalLines[originalLines.length - 1] === ""
  ) {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, resolvedPath, chunks);
  let newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }
  const newContent = newLines.join("\n");

  const target = moveToResolvedPath || resolvedPath;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, newContent, "utf8");

  if (moveToResolvedPath && moveToResolvedPath !== resolvedPath) {
    await fs.rm(resolvedPath, { force: true });
  }

  return { modifiedPath: target };
}

async function applyHunks(baseDir, hunks, denyAbs) {
  const baseResolved = path.resolve(baseDir);
  const touched = [];

  for (const hunk of hunks) {
    if (hunk.type === "add") {
      const dst = resolvePath(baseResolved, hunk.path);
      assertAllowed(dst, denyAbs, "apply_patch");
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, hunk.contents, "utf8");
      touched.push("A " + toDisplayPath(dst, baseResolved));
      continue;
    }

    if (hunk.type === "delete") {
      const target = resolvePath(baseResolved, hunk.path);
      assertAllowed(target, denyAbs, "apply_patch");
      let st = null;
      try {
        st = await fs.stat(target);
      } catch {
        st = null;
      }
      if (st && st.isDirectory && st.isDirectory()) {
        throw new Error("Refusing to delete directory: " + hunk.path);
      }
      await fs.rm(target, { force: true });
      touched.push("D " + toDisplayPath(target, baseResolved));
      continue;
    }

    if (hunk.type === "update") {
      const src = resolvePath(baseResolved, hunk.path);
      const moveTo = hunk.movePath
        ? resolvePath(baseResolved, hunk.movePath)
        : undefined;
      assertAllowed(src, denyAbs, "apply_patch");
      if (moveTo) assertAllowed(moveTo, denyAbs, "apply_patch");
      const r = await applyUpdateHunk(src, moveTo, hunk.chunks);
      touched.push("M " + toDisplayPath(r.modifiedPath, baseResolved));
      continue;
    }

    throw new Error("Unhandled hunk type");
  }

  return touched.length > 0
    ? "Success. Updated the following files:\n" + touched.join("\n")
    : "No files were modified.";
}

async function opApplyPatch(input, denyAbs) {
  const patchText = String(input.patchText || "");
  const baseDir = path.resolve(process.cwd());
  const hunks = parsePatch(patchText);
  return await applyHunks(baseDir, hunks, denyAbs);
}

function readJsonFromStdin() {
  const raw = fssync.readFileSync(0, "utf8");
  if (!raw || String(raw).trim().length === 0) return {};
  return JSON.parse(raw);
}

async function main() {
  try {
    const parsed = readJsonFromStdin();
    const op = String(parsed.op || "");
    const denyPaths = Array.isArray(parsed.denyPaths)
      ? parsed.denyPaths.map(String)
      : [];
    const denyAbs = denyPaths.map((p) => path.resolve(expandTilde(p)));
    const input = parsed.input || {};

    if (op === "fs.read_text") {
      ok(await opReadText(input, denyAbs));
      return;
    }
    if (op === "fs.read_bytes") {
      ok(await opReadBytes(input, denyAbs));
      return;
    }
    if (op === "fs.glob") {
      ok(await opGlob(input, denyAbs));
      return;
    }
    if (op === "fs.grep") {
      ok(await opGrep(input, denyAbs));
      return;
    }
    if (op === "fs.edit") {
      ok(await opEdit(input, denyAbs));
      return;
    }
    if (op === "apply_patch") {
      ok(await opApplyPatch(input, denyAbs));
      return;
    }

    fail("Unknown op: " + op);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

main();
