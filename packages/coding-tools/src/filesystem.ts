import { FileSystem, type FsBackend } from "@stanley2058/lilac-fs";
import { tool, type ToolSet } from "ai";

import { assertGuardrailBypassAllowed, assertLocalCwd } from "./guardrails";
import {
  editFileInputSchema,
  fuzzySearchInputSchema,
  globInputSchema,
  grepInputSchema,
  readFileInputSchema,
} from "./schemas";

export function createFilesystemTools(params: {
  fileSystem: FileSystem;
  cwd: string;
  fsBackend: FsBackend;
  allowGuardrailBypass?: boolean;
}): ToolSet {
  const { fileSystem, cwd, fsBackend, allowGuardrailBypass = false } = params;
  const tools: ToolSet = {
    read_file: tool({
      description:
        "Read a local text file. Reading records its hash so edit_file can safely edit it later.",
      inputSchema: readFileInputSchema,
      execute: ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        return fileSystem.readFile(input, operationCwd ?? cwd);
      },
    }),
    glob: tool({
      description: "Match local filesystem paths with include and negated glob patterns.",
      inputSchema: globInputSchema,
      execute: ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        return fileSystem.glob({ ...input, baseDir: operationCwd ?? cwd });
      },
    }),
    grep: tool({
      description: "Search local file contents, using literal matching unless regex=true.",
      inputSchema: grepInputSchema,
      execute: ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        return fileSystem.grep({ ...input, baseDir: operationCwd ?? cwd });
      },
    }),
    edit_file: tool({
      description:
        "Replace a snippet in an existing local file. The file must first be read with read_file; by default oldText must match exactly once.",
      inputSchema: editFileInputSchema,
      execute: ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const occurrence = input.replaceAll ? "all" : "first";
        const expectedMatches = input.expectedMatches ?? (input.replaceAll ? "any" : 1);
        return fileSystem.editFile(
          {
            path: input.path,
            edits: [
              {
                type: "replace_snippet",
                target: input.oldText,
                matching: input.matching,
                newText: input.newText,
                occurrence,
                expectedMatches,
              },
            ],
            expectedHash: input.expectedHash,
            dangerouslyAllow: input.dangerouslyAllow,
          },
          operationCwd ?? cwd,
        );
      },
    }),
  };

  if (fsBackend === "fff") {
    tools.fuzzy_search = tool({
      description: "Fuzzy-ranked local filename and path search powered by FFF.",
      inputSchema: fuzzySearchInputSchema,
      execute: ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        return fileSystem.fuzzySearchFiles({ ...input, baseDir: operationCwd ?? cwd });
      },
    });
  }

  return tools;
}
