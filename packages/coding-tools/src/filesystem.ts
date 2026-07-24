import { FileSystem, type FsBackend } from "@stanley2058/lilac-fs";
import {
  TOOL_RESULT_URI_PREFIX,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
} from "@stanley2058/lilac-tool-results";
import { tool, type ToolSet } from "ai";

import type { CodingToolArtifactIntegration } from "./artifact-integration";
import { assertGuardrailBypassAllowed, assertLocalCwd } from "./guardrails";
import {
  createReadFileInstructionClaims,
  loadReadFileInstructions,
  READ_FILE_INSTRUCTION_HINT,
} from "./instructions";
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
  loadInstructions?: boolean;
  preloadedInstructionPaths?: readonly string[];
  denyPaths?: readonly string[];
  artifactIntegration?: CodingToolArtifactIntegration;
}): ToolSet {
  const {
    fileSystem,
    cwd,
    fsBackend,
    allowGuardrailBypass = false,
    loadInstructions = true,
    preloadedInstructionPaths,
    denyPaths,
    artifactIntegration,
  } = params;
  const instructionClaims = createReadFileInstructionClaims();
  const tools: ToolSet = {
    read_file: tool({
      description: `Read a local text file or a transient tool-result:// URI. Artifact URIs ignore cwd and support start/maxCharacters/maxLines paging; reuse nextStart unchanged while hasMore is true. Reading a local file records its hash so edit_file can safely edit it later. ${READ_FILE_INSTRUCTION_HINT}`,
      inputSchema: readFileInputSchema,
      execute: async ({ cwd: operationCwd, ...input }, options) => {
        if (input.path.startsWith(TOOL_RESULT_URI_PREFIX)) {
          const artifact = artifactIntegration
            ? await artifactIntegration.artifacts.readWindow(
                input.path,
                artifactIntegration.scopeId,
                {
                  start: input.start ?? { type: "offset", offset: 0 },
                  maxCharacters: Math.max(1, input.maxCharacters ?? 10_000),
                  maxLines: Math.max(1, input.maxLines ?? 2_000),
                },
              )
            : { ok: false as const };
          if (!artifact.ok) {
            return {
              success: false as const,
              resolvedPath: input.path,
              error: {
                code: "UNKNOWN" as const,
                message: TOOL_RESULT_UNAVAILABLE_MESSAGE,
              },
            };
          }
          return {
            success: true as const,
            kind: "artifact" as const,
            resolvedPath: input.path,
            content: artifact.content,
            startOffset: artifact.startOffset,
            endOffset: artifact.endOffset,
            totalCharacters: artifact.totalCharacters,
            ...(artifact.nextStart ? { nextStart: artifact.nextStart } : {}),
            hasMore: artifact.hasMore,
          };
        }
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const effectiveCwd = operationCwd ?? cwd;
        const output = await fileSystem.readFile(input, effectiveCwd);
        if (!output.success || !loadInstructions) return output;

        const instructions = await loadReadFileInstructions({
          resolvedPath: output.resolvedPath,
          requestedPath: input.path,
          cwd: effectiveCwd,
          messages: options.messages,
          preloadedInstructionPaths,
          denyPaths,
          claimedInstructionPaths: instructionClaims.forMessages(options.messages),
        });
        if (!instructions) return output;
        return {
          ...output,
          loadedInstructions: instructions.loaded,
          instructionsText: instructions.text,
        };
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
