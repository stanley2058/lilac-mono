import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve, isAbsolute, sep, relative } from "node:path";
import { ripgrep } from "./ripgrep";

export function expandTilde(input: string) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export const READ_ERROR_CODES = ["NOT_FOUND", "PERMISSION", "UNKNOWN"] as const;
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];

export const WRITE_ERROR_CODES = [
  "NOT_FOUND",
  "PERMISSION",
  "UNKNOWN",
  "FILE_EXISTS",
  "HASH_MISMATCH",
] as const;
export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number];

export const EDIT_ERROR_CODES = [
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
] as const;
export type EditErrorCode = (typeof EDIT_ERROR_CODES)[number];

export type ReadFileSuccessBase = {
  success: true;
  resolvedPath: string;
  fileHash: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMoreLines: boolean;
  truncatedByChars: boolean;
};

export type ReadFileBytesResult =
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      bytes: Buffer;
      bytesLength: number;
    }
  | {
      success: false;
      resolvedPath: string;
      error: {
        code: ReadErrorCode;
        message: string;
      };
    };

export type ReadFileResult =
  | (ReadFileSuccessBase & {
      format: "raw";
      content: string;
    })
  | (ReadFileSuccessBase & {
      format: "numbered";
      numberedContent: string;
    })
  | {
      success: false;
      resolvedPath: string;
      error: {
        code: ReadErrorCode;
        message: string;
      };
    };

export type WriteFileResult =
  | {
      success: true;
      resolvedPath: string;
      created: boolean;
      overwritten: boolean;
      fileHash: string;
    }
  | {
      success: false;
      resolvedPath: string;
      currentHash?: string;
      error: {
        code: WriteErrorCode;
        message: string;
      };
    };

export type EditFileResult =
  | {
      success: true;
      resolvedPath: string;
      oldHash: string;
      newHash: string;
      changesMade: boolean;
      replacementsMade: number;
    }
  | {
      success: false;
      resolvedPath: string;
      currentHash?: string;
      error: {
        code: EditErrorCode;
        message: string;
      };
      errors?: {
        code: EditErrorCode;
        message: string;
        editIndex: number;
        edit: FileEdit;
      }[];
    };

export interface ReadFileOptions {
  /** 1-based line number to start reading from */
  startLine?: number;
  /** Maximum number of lines to return, defaults to 2000 */
  maxLines?: number;
  /** Maximum number of characters to return, defaults to 10000 */
  maxCharacters?: number;
  /** Output format, defaults to "raw" */
  format?: "raw" | "numbered";
}

export type FileEdit =
  | {
      type: "replace_range";
      /** 1-based, inclusive */
      range: {
        startLine: number;
        endLine: number;
      };
      newText: string;
      /**
       * Optional safety check: the exact text currently in the range.
       * If provided and does not match, the edit fails.
       */
      expectedOldText?: string;
    }
  | {
      type: "insert_at";
      /**
       * 1-based line number.
       * New text will be inserted before this line.
       */
      line: number;
      newText: string;
    }
  | {
      type: "delete_range";
      /** 1-based, inclusive */
      range: {
        startLine: number;
        endLine: number;
      };
      /**
       * Optional safety check: the exact text currently in the range.
       * If provided and does not match, the edit fails.
       */
      expectedOldText?: string;
    }
  | {
      type: "replace_snippet";
      /**
       * Exact text to replace if matching is "exact";
       * Regex body if matching is "regex".
       */
      target: string;
      matching?: "exact" | "regex";
      newText: string;
      /**
       * Which occurrences to replace.
       * - "first": replace the first match
       * - "all": replace all matches
       * - number: replace up to N matches
       */
      occurrence?: "first" | "all" | number;
      /**
       * How many matches must exist for the edit to proceed.
       * Default is 1 (opencode-style safety).
       */
      expectedMatches?: number | "any";
    };

export const SEARCH_MODES = ["lean", "verbose"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export type GlobEntry = {
  path: string;
  type:
    | "symlink"
    | "file"
    | "directory"
    | "socket"
    | "block_device"
    | "character_device"
    | "fifo"
    | "unknown";
  size: number;
};

export type GlobResult =
  | {
      mode: "lean";
      truncated: boolean;
      paths: string[];
      error?: string;
    }
  | {
      mode: "verbose";
      truncated: boolean;
      entries: GlobEntry[];
      error?: string;
    };

export type GrepResult =
  | {
      mode: "lean";
      truncated: boolean;
      text: string;
      error?: string;
    }
  | {
      mode: "verbose";
      truncated: boolean;
      results: {
        file: string;
        line: number;
        column: number;
        text: string;
        submatches?: {
          match: string;
          start: number;
          end: number;
        }[];
      }[];
      error?: string;
    };

export type GlobOpts = {
  /**
   * The base directory to search from, must be absolute path. Default is the root.
   */
  baseDir?: string;
  /**
   * Maximum number of entries to return, default is 100
   */
  maxEntries?: number;
  /**
   * Output verbosity mode. Default is lean.
   */
  mode?: SearchMode;
};

export type GrepOpts = {
  /**
   * The base directory to search from, must be absolute path. Default is the root.
   */
  baseDir?: string;
  regex?: boolean;
  maxResults?: number;
  fileExtensions?: string[];
  includeContextLines?: number;
  /**
   * Output verbosity mode. Default is lean.
   */
  mode?: SearchMode;
};

export type FileSystemEventType =
  | "readFile"
  | "writeFile"
  | "editFile"
  | "deleteFile";
export type FileSystemEvent =
  | {
      type: "readFile" | "writeFile" | "deleteFile";
      path: string;
      accessAt: number;
    }
  | {
      type: "editFile";
      path: string;
      accessAt: number;
      operations: FileEdit["type"][];
    };
export type Listener = (event: FileSystemEvent) => void;

export class FileSystem {
  private readonly fileAccessRecord = new Map<
    string,
    { lastAccess: number; fileHash: string }
  >();
  private readonly listeners = new Set<Listener>();

  private readonly denyPaths: readonly string[];

  constructor(
    private root: string,
    opts?: {
      /** Absolute or ~ paths that are blocked for all operations. */
      denyPaths?: readonly string[];
    },
  ) {
    this.denyPaths = (opts?.denyPaths ?? []).map((p) => resolve(expandTilde(p)));
  }

  private isDeniedPath(resolvedPath: string): boolean {
    const normalized = resolve(resolvedPath);
    for (const deny of this.denyPaths) {
      if (normalized === deny) return true;
      if (normalized.startsWith(`${deny}${sep}`)) return true;
    }
    return false;
  }

  private assertAllowed(resolvedPath: string, op: string): void {
    if (!this.isDeniedPath(resolvedPath)) return;

    const err = Object.assign(
      new Error(`Access denied: '${resolvedPath}' is blocked for ${op}`),
      { code: "EACCES" },
    );
    throw err;
  }

  private resolvePath(inputPath: string, cwd?: string) {
    const expandedInput = expandTilde(inputPath);
    if (isAbsolute(expandedInput)) return resolve(expandedInput);

    const base = cwd ?? this.root;
    const expandedBase = resolve(expandTilde(base));
    return resolve(expandedBase, expandedInput);
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reads a file from the filesystem
   *
   * @param path The path to the file, relative to the root
   *
   */
  async readFile(
    { path, ...opts }: ReadFileOptions & { path: string },
    cwd?: string,
  ): Promise<ReadFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);

    try {
      this.assertAllowed(resolvedPath, "readFile");

      const {
        startLine = 1,
        maxLines = 2000,
        maxCharacters = 10000,
        format = "raw",
      } = opts;

      const file = await fs.readFile(resolvedPath, "utf-8");
      const fileHash = this.hash(file);

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

      let output: string;
      if (format === "numbered") {
        const digits = Math.max(
          1,
          String(Math.max(endLine, normalizedStartLine)).length,
        );
        output = windowLines
          .map(
            (line, i) =>
              `${String(normalizedStartLine + i).padStart(digits, " ")}| ${line}`,
          )
          .join("\n");
      } else {
        output = windowLines.join("\n");
      }

      const truncatedByChars = output.length > maxCharacters;
      output = output.slice(0, maxCharacters);

      this.fileAccessRecord.set(resolvedPath, {
        lastAccess: Date.now(),
        fileHash,
      });

      this.fireEvent({
        type: "readFile",
        path: resolvedPath,
        accessAt: Date.now(),
      });

      const base: ReadFileSuccessBase = {
        success: true,
        resolvedPath,
        fileHash,
        startLine: normalizedStartLine,
        endLine,
        totalLines,
        hasMoreLines,
        truncatedByChars,
      };

      if (format === "numbered") {
        return { ...base, format: "numbered", numberedContent: output };
      }

      return { ...base, format: "raw", content: output };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code =
        typeof e === "object" && e && "code" in e
          ? String((e as any).code)
          : undefined;

      const errorCode: ReadErrorCode =
        code === "ENOENT"
          ? "NOT_FOUND"
          : code === "EACCES" || code === "EPERM"
            ? "PERMISSION"
            : "UNKNOWN";

      return {
        success: false as const,
        resolvedPath,
        error: { code: errorCode, message: msg },
      };
    }
  }

  /**
   * Reads a file as bytes.
   *
   * This is intended for binary files (images, PDFs, etc.) where reading as utf-8
   * would corrupt the data.
   */
  async readFileBytes(
    { path }: { path: string },
    cwd?: string,
  ): Promise<ReadFileBytesResult> {
    const resolvedPath = this.resolvePath(path, cwd);

    try {
      this.assertAllowed(resolvedPath, "readFile");

      const bytes = await fs.readFile(resolvedPath);
      const fileHash = this.hash(bytes);

      this.fileAccessRecord.set(resolvedPath, {
        lastAccess: Date.now(),
        fileHash,
      });

      this.fireEvent({
        type: "readFile",
        path: resolvedPath,
        accessAt: Date.now(),
      });

      return {
        success: true,
        resolvedPath,
        fileHash,
        bytes,
        bytesLength: bytes.byteLength,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code =
        typeof e === "object" && e && "code" in e
          ? String((e as any).code)
          : undefined;

      const errorCode: ReadErrorCode =
        code === "ENOENT"
          ? "NOT_FOUND"
          : code === "EACCES" || code === "EPERM"
            ? "PERMISSION"
            : "UNKNOWN";

      return {
        success: false as const,
        resolvedPath,
        error: { code: errorCode, message: msg },
      };
    }
  }

  async writeFile(
    {
      path,
      content,
      overwrite = false,
      expectedHash,
      createParents = true,
    }: {
      path: string;
      content: string;
      overwrite?: boolean;
      expectedHash?: string;
      createParents?: boolean;
    },
    cwd?: string,
  ): Promise<WriteFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);

    try {
      this.assertAllowed(resolvedPath, "writeFile");

      let existed = true;
      let currentHash: string | undefined;

      try {
        const existing = await fs.readFile(resolvedPath, "utf-8");
        currentHash = this.hash(existing);
      } catch (e) {
        const code =
          typeof e === "object" && e && "code" in e
            ? String((e as any).code)
            : undefined;

        if (code === "ENOENT") {
          existed = false;
        } else {
          throw e;
        }
      }

      if (existed) {
        if (!overwrite) {
          return {
            success: false as const,
            resolvedPath,
            error: {
              code: "FILE_EXISTS",
              message: `File already exists: ${resolvedPath}. Set overwrite=true to overwrite it.`,
            },
          };
        }

        if (expectedHash && currentHash && expectedHash !== currentHash) {
          return {
            success: false as const,
            resolvedPath,
            currentHash,
            error: {
              code: "HASH_MISMATCH",
              message: `File has changed since last read: ${resolvedPath}`,
            },
          };
        }
      } else {
        if (expectedHash) {
          return {
            success: false as const,
            resolvedPath,
            error: {
              code: "NOT_FOUND",
              message: `File does not exist: ${resolvedPath}`,
            },
          };
        }
      }

      if (createParents) {
        await fs.mkdir(dirname(resolvedPath), { recursive: true });
      }

      await fs.writeFile(resolvedPath, content);
      const fileHash = this.hash(content);

      this.fileAccessRecord.set(resolvedPath, {
        lastAccess: Date.now(),
        fileHash,
      });

      this.fireEvent({
        type: "writeFile",
        path: resolvedPath,
        accessAt: Date.now(),
      });

      return {
        success: true as const,
        resolvedPath,
        created: !existed,
        overwritten: existed,
        fileHash,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code =
        typeof e === "object" && e && "code" in e
          ? String((e as any).code)
          : undefined;

      const errorCode: WriteErrorCode =
        code === "ENOENT"
          ? "NOT_FOUND"
          : code === "EACCES" || code === "EPERM"
            ? "PERMISSION"
            : "UNKNOWN";

      return {
        success: false as const,
        resolvedPath,
        error: { code: errorCode, message: msg },
      };
    }
  }

  async deleteFile({ path, cwd }: { path: string; cwd?: string }) {
    const resolvedPath = this.resolvePath(path, cwd);

    try {
      this.assertAllowed(resolvedPath, "deleteFile");

      await fs.unlink(resolvedPath);
      this.fileAccessRecord.delete(resolvedPath);

      this.fireEvent({
        type: "deleteFile",
        path: resolvedPath,
        accessAt: Date.now(),
      });

      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /**
   * Edits a file in the filesystem.
   *
   * By default, edits are atomic: if any edit fails, the file is not written.
   */
  async editFile(
    {
      path,
      edits,
      expectedHash,
    }: {
      path: string;
      edits: FileEdit[];
      expectedHash?: string;
    },
    cwd?: string,
  ): Promise<EditFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);

    try {
      this.assertAllowed(resolvedPath, "editFile");

      const lastAccess = this.fileAccessRecord.get(resolvedPath);
      const file = await fs.readFile(resolvedPath, "utf-8");

      const oldHash = this.hash(file);
      if (expectedHash) {
        if (expectedHash !== oldHash) {
          return {
            success: false as const,
            resolvedPath,
            currentHash: oldHash,
            error: {
              code: "HASH_MISMATCH",
              message: `File has changed since last read: ${resolvedPath}`,
            },
          };
        }
      } else {
        if (!lastAccess) {
          return {
            success: false as const,
            resolvedPath,
            currentHash: oldHash,
            error: {
              code: "NOT_READ",
              message: `File must be read before editing: ${resolvedPath}`,
            },
          };
        }

        if (lastAccess.fileHash !== oldHash) {
          return {
            success: false as const,
            resolvedPath,
            currentHash: oldHash,
            error: {
              code: "HASH_MISMATCH",
              message: `File has changed since last read: ${resolvedPath}`,
            },
          };
        }
      }

      const countExactOccurrences = (haystack: string, needle: string) => {
        if (needle.length === 0) return 0;
        let count = 0;
        let i = 0;
        while (true) {
          i = haystack.indexOf(needle, i);
          if (i === -1) break;
          count++;
          i += needle.length;
        }
        return count;
      };

      const replaceExactOccurrences = (
        haystack: string,
        needle: string,
        replacement: string,
        maxReplacements: number,
      ) => {
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
          replacementsMade++;
        }

        result += haystack.slice(start);
        return { result, replacementsMade };
      };

      const countRegexMatches = (haystack: string, re: RegExp) => {
        let count = 0;
        re.lastIndex = 0;
        while (true) {
          const match = re.exec(haystack);
          if (!match) break;
          count++;
          if (match[0].length === 0) re.lastIndex++;
        }
        return count;
      };

      const replaceRegexOccurrences = (
        haystack: string,
        re: RegExp,
        replacement: string,
        maxReplacements: number,
      ) => {
        let replacementsMade = 0;
        let lastIndex = 0;
        let result = "";

        re.lastIndex = 0;
        while (replacementsMade < maxReplacements) {
          const match = re.exec(haystack);
          if (!match) break;

          result += haystack.slice(lastIndex, match.index) + replacement;
          lastIndex = match.index + match[0].length;
          replacementsMade++;

          if (match[0].length === 0) re.lastIndex++;
        }

        result += haystack.slice(lastIndex);
        return { result, replacementsMade };
      };

      const enforceExpectedMatches = (
        matchesFound: number,
        expected: number | "any",
        target: string,
      ) => {
        if (expected === "any") {
          if (matchesFound === 0) {
            throw Object.assign(
              new Error(`No matches found for target: ${target}`),
              { code: "NO_MATCHES" },
            );
          }
          return;
        }

        if (matchesFound === 0) {
          throw Object.assign(
            new Error(`No matches found for target: ${target}`),
            { code: "NO_MATCHES" },
          );
        }

        if (matchesFound > expected) {
          throw Object.assign(
            new Error(
              `Too many matches found (${matchesFound}); expected ${expected} for target: ${target}`,
            ),
            { code: "TOO_MANY_MATCHES" },
          );
        }

        if (matchesFound < expected) {
          throw Object.assign(
            new Error(
              `Not enough matches found (${matchesFound}); expected ${expected} for target: ${target}`,
            ),
            { code: "NOT_ENOUGH_MATCHES" },
          );
        }
      };

      const validateRange = (
        lines: string[],
        startLine: number,
        endLine: number,
      ) => {
        if (startLine < 1 || endLine < startLine || endLine > lines.length) {
          throw Object.assign(
            new Error(
              `Invalid range ${startLine}-${endLine}. File has ${lines.length} lines.`,
            ),
            { code: "INVALID_RANGE" },
          );
        }
      };

      let lines = file.split("\n");
      const succeededOperations: FileEdit["type"][] = [];
      let replacementsMade = 0;

      for (let editIndex = 0; editIndex < edits.length; editIndex++) {
        const edit = edits[editIndex]!;

        try {
          switch (edit.type) {
            case "replace_range": {
              const {
                newText,
                expectedOldText,
                range: { startLine, endLine },
              } = edit;

              validateRange(lines, startLine, endLine);

              if (expectedOldText !== undefined) {
                const actual = lines.slice(startLine - 1, endLine).join("\n");
                if (actual !== expectedOldText) {
                  throw Object.assign(
                    new Error(
                      `Range content mismatch for ${startLine}-${endLine}. Re-read the file and try again.`,
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
              const { line, newText } = edit;
              if (line < 1 || line > lines.length + 1) {
                throw Object.assign(
                  new Error(
                    `Invalid insert line ${line}. Must be between 1 and ${lines.length + 1}.`,
                  ),
                  { code: "INVALID_RANGE" },
                );
              }

              lines.splice(line - 1, 0, ...newText.split("\n"));
              break;
            }
            case "delete_range": {
              const {
                expectedOldText,
                range: { startLine, endLine },
              } = edit;

              validateRange(lines, startLine, endLine);

              if (expectedOldText !== undefined) {
                const actual = lines.slice(startLine - 1, endLine).join("\n");
                if (actual !== expectedOldText) {
                  throw Object.assign(
                    new Error(
                      `Range content mismatch for ${startLine}-${endLine}. Re-read the file and try again.`,
                    ),
                    { code: "RANGE_MISMATCH" },
                  );
                }
              }

              lines.splice(startLine - 1, endLine - startLine + 1);
              break;
            }
            case "replace_snippet": {
              const {
                target,
                matching = "exact",
                newText,
                occurrence = "first",
                expectedMatches = 1,
              } = edit;

              if (target.length === 0) {
                throw Object.assign(new Error("target must not be empty"), {
                  code: "INVALID_EDIT",
                });
              }

              if (matching === "exact" && target === newText) {
                throw Object.assign(
                  new Error(
                    "newText is identical to target; edit would be a no-op",
                  ),
                  { code: "INVALID_EDIT" },
                );
              }

              const maxReplace =
                typeof occurrence === "number"
                  ? occurrence
                  : occurrence === "first"
                    ? 1
                    : Number.MAX_SAFE_INTEGER;

              if (typeof occurrence === "number" && occurrence <= 0) {
                throw Object.assign(
                  new Error("occurrence must be a positive number"),
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
                let re: RegExp;
                try {
                  re = new RegExp(target, "g");
                } catch (e) {
                  throw Object.assign(
                    new Error(
                      `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
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
                new Error(`Unknown edit type: ${(edit as any).type}`),
                { code: "INVALID_EDIT" },
              );
          }

          succeededOperations.push(edit.type);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const rawCode =
            typeof e === "object" && e && "code" in e
              ? (e as any).code
              : undefined;

          const code: EditErrorCode =
            typeof rawCode === "string" &&
            EDIT_ERROR_CODES.includes(rawCode as EditErrorCode)
              ? (rawCode as EditErrorCode)
              : "UNKNOWN";

          return {
            success: false as const,
            resolvedPath,
            currentHash: oldHash,
            error: { code, message: msg },
            errors: [
              {
                code,
                message: msg,
                editIndex,
                edit,
              },
            ],
          };
        }
      }

      const nextContent = lines.join("\n");
      const newHash = this.hash(nextContent);
      const changesMade = newHash !== oldHash;

      if (changesMade) {
        await fs.writeFile(resolvedPath, nextContent);
      }

      this.fileAccessRecord.set(resolvedPath, {
        lastAccess: Date.now(),
        fileHash: newHash,
      });

      this.fireEvent({
        type: "editFile",
        path: resolvedPath,
        accessAt: Date.now(),
        operations: succeededOperations,
      });

      return {
        success: true as const,
        resolvedPath,
        oldHash,
        newHash,
        changesMade,
        replacementsMade,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code =
        typeof e === "object" && e && "code" in e
          ? String((e as any).code)
          : undefined;

      const errorCode: EditErrorCode =
        code === "ENOENT"
          ? "NOT_FOUND"
          : code === "EACCES" || code === "EPERM"
            ? "PERMISSION"
            : "UNKNOWN";

      return {
        success: false as const,
        resolvedPath,
        error: { code: errorCode, message: msg },
      };
    }
  }

  /**
   * Globs files in the filesystem
   *
   * @param patterns Glob filters, e.g. ["\*\*\/*.ts", "!\*\*\/node_modules/**"]
   */
  async glob({ patterns, ...opts }: GlobOpts & { patterns: string[] }): Promise<GlobResult> {
    try {
      const { baseDir = this.root, maxEntries = 100, mode = "lean" } = opts;
      const resolvedBaseDir = this.resolvePath(baseDir);

      this.assertAllowed(resolvedBaseDir, "glob");

      const includes: string[] = [];
      const excludes: string[] = [];
      for (const pattern of patterns) {
        if (!pattern) continue;
        if (pattern.startsWith("!")) {
          const negated = pattern.slice(1);
          if (negated.length > 0) {
            excludes.push(negated);
          }
          continue;
        }
        includes.push(pattern);
      }

      if (includes.length === 0) {
        if (mode === "lean") {
          return {
            mode,
            truncated: false,
            paths: [],
          };
        }
        return {
          mode,
          truncated: false,
          entries: [],
        };
      }

      const paths: string[] = [];
      const entries: GlobEntry[] = [];
      const seen = new Set<string>();
      let truncated = false;
      for await (const entry of fs.glob(includes, {
        cwd: resolvedBaseDir,
        exclude: excludes.length > 0 ? excludes : undefined,
      })) {
        if (seen.has(entry)) continue;
        seen.add(entry);

        const abs = resolve(join(resolvedBaseDir, entry));
        if (this.isDeniedPath(abs)) continue;

        const count = mode === "lean" ? paths.length : entries.length;
        if (count >= maxEntries) {
          truncated = true;
          break;
        }

        if (mode === "lean") {
          paths.push(entry);
          continue;
        }

        const stats = await fs.stat(join(resolvedBaseDir, entry));
        entries.push({
          path: entry,
          type: this.getFileTypeFromStats(stats),
          size: stats.size,
        });
      }

      if (mode === "lean") {
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const mode = opts.mode ?? "lean";
      if (mode === "lean") {
        return { mode, truncated: false, paths: [], error: msg };
      }
      return { mode, truncated: false, entries: [], error: msg };
    }
  }

  async grep({ pattern, ...opts }: GrepOpts & { pattern: string }): Promise<GrepResult> {
    try {
      const {
        baseDir = this.root,
        regex = false,
        maxResults = 100,
        fileExtensions = [],
        includeContextLines = 0,
        mode = "lean",
      } = opts;

      const resolvedBaseDir = this.resolvePath(baseDir);

      this.assertAllowed(resolvedBaseDir, "grep");

      const globs = fileExtensions.map(
        (ext) => `**/*.${ext.replace(/^\./, "")}`,
      );

      // Ensure ripgrep doesn't traverse blocked paths when searching from broad base dirs (e.g. "/").
      for (const denyAbs of this.denyPaths) {
        const rel = relative(resolvedBaseDir, denyAbs);
        if (rel.length === 0) continue;
        if (rel.startsWith("..") || rel.startsWith(sep)) continue;
        globs.push(`!${rel}`);
        globs.push(`!${rel}/**`);
      }

      const extraArgs: string[] = [];
      if (includeContextLines > 0) {
        extraArgs.push("--context", String(includeContextLines));
      }

      const ripgrepResult = await ripgrep({
        pattern,
        regex,
        cwd: resolvedBaseDir,
        maxMatches: maxResults,
        globs: globs.length > 0 ? globs : undefined,
        extraArgs,
      });

      if (mode === "lean") {
        const text = ripgrepResult.matches
          .map((match) => {
            const snippet = match.text.replace(/\s+/g, " ").trim();
            return `${match.file}:${match.line}: ${snippet}`;
          })
          .join("\n");
        return {
          mode,
          truncated: ripgrepResult.truncated,
          text,
        };
      }

      return {
        mode,
        truncated: ripgrepResult.truncated,
        results: ripgrepResult.matches,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const mode = opts.mode ?? "lean";
      if (mode === "lean") {
        return { mode, truncated: false, text: "", error: msg };
      }
      return { mode, truncated: false, results: [], error: msg };
    }
  }

  private hash(input: string | Uint8Array) {
    return Bun.hash.xxHash3(input).toString(16);
  }

  private getFileTypeFromStats(stats: Stats) {
    switch (true) {
      case stats.isSymbolicLink(): {
        return "symlink";
      }
      case stats.isFile(): {
        return "file";
      }
      case stats.isDirectory(): {
        return "directory";
      }
      case stats.isSocket(): {
        return "socket";
      }
      case stats.isBlockDevice(): {
        return "block_device";
      }
      case stats.isCharacterDevice(): {
        return "character_device";
      }
      case stats.isFIFO(): {
        return "fifo";
      }
      default: {
        return "unknown";
      }
    }
  }

  private fireEvent(event: FileSystemEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
