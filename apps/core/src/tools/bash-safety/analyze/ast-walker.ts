import type { CommandNode, ScriptNode, StatementNode, WordNode } from "just-bash";
import { isAbsolute, resolve } from "node:path";

import type { AnalyzeOptions, AnalyzeResult } from "../types";
import { MAX_RECURSION_DEPTH, SHELL_WRAPPERS } from "../types";
import {
  ARITHMETIC_EXPANSION_MARKER,
  BRACE_EXPANSION_MARKER,
  COMMAND_SUBSTITUTION_MARKER,
  DYNAMIC_EXPANSION_MARKER,
  GLOB_EXPANSION_MARKER,
  NONTRIVIAL_DYNAMIC_EXPANSION_MARKER,
  normalizeCommandToken,
  PARAMETER_EXPANSION_MARKER,
  stripExpansionMarkers,
  stripWrappersWithInfo,
} from "../shell";

import {
  analyzeSegment,
  analyzeSensitiveTokens,
  COMMAND_EXECUTION_WRAPPERS,
  unwrapStaticExecutionWrapper,
} from "./segment";

type SimpleCommandNode = Extract<CommandNode, { type: "SimpleCommand" }>;
type RedirectionNode = SimpleCommandNode["redirections"][number];
type WordPart = WordNode["parts"][number];
type ArithmeticExpressionNode = Extract<CommandNode, { type: "ArithmeticCommand" }>["expression"];
type ArithExpr = ArithmeticExpressionNode["expression"];
type ConditionalExpressionNode = Extract<CommandNode, { type: "ConditionalCommand" }>["expression"];

interface WalkContext {
  readonly depth: number;
  readonly options: AnalyzeOptions;
  readonly originalCwd: string | undefined;
  readonly analyzeNestedCommand: (
    command: string,
    depth: number,
    effectiveCwd: string | null | undefined,
  ) => AnalyzeResult | null;
}

interface CwdState {
  cwd: string | null | undefined;
}

type ShellStdinSource =
  | { readonly kind: "none" | "pipeline" | "dynamic" | "file" | "unknown" }
  | { readonly kind: "static"; readonly payload: string };

const NO_STDIN: ShellStdinSource = { kind: "none" };
const UNINSPECTABLE_STDIN: ShellStdinSource = { kind: "pipeline" };

interface WordValue {
  readonly text: string;
  readonly dynamic: boolean;
}

type WordAnalysis =
  | { readonly blocked: AnalyzeResult }
  | { readonly blocked: null; readonly value: WordValue };

const REDIRECTION_OPERATORS = new Set([
  "<",
  ">",
  ">>",
  ">&",
  "<&",
  "<>",
  ">|",
  "&>",
  "&>>",
  "<<<",
  "<<",
  "<<-",
]);

export function analyzeScript(
  script: ScriptNode,
  context: WalkContext,
  state: CwdState,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  const scriptType: string = script.type;
  if (scriptType !== "Script") {
    return null;
  }

  for (const statement of script.statements) {
    const result = analyzeStatement(statement, context, state, stdinSource);
    if (result) return result;
  }
  return null;
}

function analyzeStatement(
  statement: StatementNode,
  context: WalkContext,
  state: CwdState,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  const segment = statement.sourceText?.trim() || `line ${statement.line ?? "unknown"}`;
  const statementType: string = statement.type;
  if (statementType !== "Statement") {
    return null;
  }

  let branches: CwdBranch[] = [{ cwd: state.cwd, status: "success" }];
  for (let i = 0; i < statement.pipelines.length; i++) {
    const pipeline = statement.pipelines[i];
    if (!pipeline) continue;
    const precedingOperator = statement.operators[i - 1];
    const nextBranches: CwdBranch[] = [];
    for (const branch of branches) {
      const shouldRun =
        i === 0 ||
        precedingOperator === ";" ||
        (precedingOperator === "&&" && branch.status === "success") ||
        (precedingOperator === "||" && branch.status === "failure");
      if (!shouldRun) {
        nextBranches.push(branch);
        continue;
      }

      const pipelineState: CwdState = { cwd: branch.cwd };
      const result = analyzePipeline(pipeline, context, pipelineState, segment, stdinSource);
      if (result) return result;

      const knownStatus = staticallyKnownPipelineStatus(pipeline);
      if (knownStatus !== "failure") {
        nextBranches.push({ cwd: pipelineState.cwd, status: "success" });
      }
      if (knownStatus !== "success") {
        nextBranches.push({
          cwd: pipelineIsSimpleCd(pipeline) ? branch.cwd : pipelineState.cwd,
          status: "failure",
        });
      }
    }
    branches = dedupeCwdBranches(nextBranches);
  }

  const onlyPipeline = statement.pipelines.length === 1 ? statement.pipelines[0] : undefined;
  const assumedCdSuccess =
    onlyPipeline && pipelineIsSimpleCd(onlyPipeline)
      ? branches.find((branch) => branch.status === "success")?.cwd
      : undefined;
  state.cwd = assumedCdSuccess ?? commonCwd(branches.map((branch) => branch.cwd));
  return null;
}

type CwdBranch = {
  cwd: string | null | undefined;
  status: "success" | "failure";
};

function dedupeCwdBranches(branches: readonly CwdBranch[]): CwdBranch[] {
  const deduped = new Map<string, CwdBranch>();
  for (const branch of branches) {
    deduped.set(`${branch.status}:${String(branch.cwd)}`, branch);
  }
  return [...deduped.values()];
}

function staticallyKnownPipelineStatus(
  pipeline: StatementNode["pipelines"][number],
): CwdBranch["status"] | null {
  const command = pipeline.commands.length === 1 ? pipeline.commands[0] : undefined;
  if (command?.type !== "SimpleCommand" || !command.name) return null;
  const name = staticWordValue(command.name);
  if (name === "true" || name === ":") return "success";
  if (name === "false") return "failure";
  return null;
}

function pipelineIsSimpleCd(pipeline: StatementNode["pipelines"][number]): boolean {
  const command = pipeline.commands.length === 1 ? pipeline.commands[0] : undefined;
  return command?.type === "SimpleCommand" && command.name
    ? normalizeCommandToken(staticWordValue(command.name) ?? "") === "cd"
    : false;
}

function staticWordValue(word: WordNode): string | null {
  if (word.parts.length !== 1) return null;
  const part = word.parts[0];
  if (!part) return null;
  if (part.type === "Literal" || part.type === "SingleQuoted" || part.type === "Escaped") {
    return part.value;
  }
  return null;
}

function analyzePipeline(
  pipeline: StatementNode["pipelines"][number],
  context: WalkContext,
  state: CwdState,
  segment: string,
  inheritedStdin: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  const pipelineType: string = pipeline.type;
  if (pipelineType !== "Pipeline") {
    return null;
  }

  if (pipeline.commands.length === 1) {
    const command = pipeline.commands[0];
    return command ? analyzeCommandNode(command, context, state, segment, inheritedStdin) : null;
  }

  for (let i = 0; i < pipeline.commands.length; i++) {
    const command = pipeline.commands[i];
    if (!command) continue;
    const pipelineState: CwdState = { cwd: state.cwd };
    const result = analyzeCommandNode(
      command,
      context,
      pipelineState,
      segment,
      i === 0 ? inheritedStdin : UNINSPECTABLE_STDIN,
    );
    if (result) return result;
  }
  return null;
}

function analyzeCommandNode(
  command: CommandNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  switch (command.type) {
    case "SimpleCommand":
      return analyzeSimpleCommand(command, context, state, segment, stdinSource);
    case "If":
      return analyzeIf(
        command,
        context,
        state,
        segment,
        resolveCompoundStdin(command.redirections, stdinSource, context, state, segment),
      );
    case "For": {
      const compoundStdin = resolveCompoundStdin(
        command.redirections,
        stdinSource,
        context,
        state,
        segment,
      );
      if ("blocked" in compoundStdin) return compoundStdin.blocked;
      if (command.words) {
        const result = analyzeWords(command.words, context, state, segment, compoundStdin.source);
        if (result) return result;
      }
      const result = analyzeLoopBody(command.body, context, state, compoundStdin.source);
      if (result) return result;
      return null;
    }
    case "CStyleFor": {
      const compoundStdin = resolveCompoundStdin(
        command.redirections,
        stdinSource,
        context,
        state,
        segment,
      );
      if ("blocked" in compoundStdin) return compoundStdin.blocked;
      for (const expression of [command.init, command.condition, command.update]) {
        if (!expression) continue;
        const result = analyzeArithmeticExpression(expression, context, state, segment);
        if (result) return result;
      }
      const result = analyzeLoopBody(command.body, context, state, compoundStdin.source);
      if (result) return result;
      return null;
    }
    case "While":
    case "Until": {
      const compoundStdin = resolveCompoundStdin(
        command.redirections,
        stdinSource,
        context,
        state,
        segment,
      );
      if ("blocked" in compoundStdin) return compoundStdin.blocked;
      const loopState: CwdState = { cwd: state.cwd };
      let result = analyzeStatements(command.condition, context, loopState, compoundStdin.source);
      if (result) return result;
      result = analyzeStatements(command.body, context, loopState, compoundStdin.source);
      if (result) return result;
      if (loopState.cwd !== state.cwd) state.cwd = null;
      return null;
    }
    case "Case":
      return analyzeCase(
        command,
        context,
        state,
        segment,
        resolveCompoundStdin(command.redirections, stdinSource, context, state, segment),
      );
    case "Subshell": {
      const compoundStdin = resolveCompoundStdin(
        command.redirections,
        stdinSource,
        context,
        state,
        segment,
      );
      if ("blocked" in compoundStdin) return compoundStdin.blocked;
      const subshellState: CwdState = { cwd: state.cwd };
      const result = analyzeStatements(command.body, context, subshellState, compoundStdin.source);
      if (result) return result;
      return null;
    }
    case "Group": {
      const compoundStdin = resolveCompoundStdin(
        command.redirections,
        stdinSource,
        context,
        state,
        segment,
      );
      if ("blocked" in compoundStdin) return compoundStdin.blocked;
      const result = analyzeStatements(command.body, context, state, compoundStdin.source);
      if (result) return result;
      return null;
    }
    case "FunctionDef": {
      const currentStdin = resolveCompoundStdin(
        command.redirections,
        stdinSource,
        context,
        state,
        segment,
      );
      if ("blocked" in currentStdin) return currentStdin.blocked;
      const functionState: CwdState = { cwd: state.cwd };
      let result = analyzeCommandNode(
        command.body,
        context,
        functionState,
        segment,
        currentStdin.source,
      );
      if (result) return result;
      const arbitraryStdin = resolveStdinSource(
        command.redirections,
        UNINSPECTABLE_STDIN,
        context,
        functionState,
        segment,
      );
      if ("blocked" in arbitraryStdin) return arbitraryStdin.blocked;
      result = analyzeCommandNode(
        command.body,
        context,
        { cwd: state.cwd },
        segment,
        arbitraryStdin.source,
      );
      return result;
    }
    case "ArithmeticCommand": {
      const result = analyzeArithmeticExpression(command.expression, context, state, segment);
      if (result) return result;
      return analyzeRedirections(command.redirections, context, state, segment, stdinSource);
    }
    case "ConditionalCommand": {
      const result = analyzeConditionalExpression(
        command.expression,
        context,
        state,
        segment,
        stdinSource,
      );
      if (result) return result;
      return analyzeRedirections(command.redirections, context, state, segment, stdinSource);
    }
    default:
      return null;
  }
}

function analyzeSimpleCommand(
  command: SimpleCommandNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource,
): AnalyzeResult | null {
  const tokens: string[] = [];
  for (const assignment of command.assignments) {
    const assignmentType: string = assignment.type;
    if (assignmentType !== "Assignment") {
      continue;
    }
    if (assignment.value) {
      const analyzed = analyzeWord(assignment.value, context, state, segment, stdinSource);
      if (analyzed.blocked) return analyzed.blocked;
      tokens.push(`${assignment.name}${assignment.append ? "+" : ""}=${analyzed.value.text}`);
    } else {
      tokens.push(`${assignment.name}${assignment.append ? "+" : ""}=`);
    }

    if (assignment.array) {
      const result = analyzeWords(assignment.array, context, state, segment, stdinSource);
      if (result) return result;
    }
  }

  if (command.name) {
    const analyzed = analyzeWord(command.name, context, state, segment, stdinSource);
    if (analyzed.blocked) return analyzed.blocked;
    tokens.push(analyzed.value.text);
  }

  for (const arg of command.args) {
    const analyzed = analyzeWord(arg, context, state, segment, stdinSource);
    if (analyzed.blocked) return analyzed.blocked;
    tokens.push(analyzed.value.text);
  }

  const redirectionResult = analyzeRedirections(
    command.redirections,
    context,
    state,
    segment,
    stdinSource,
  );
  if (redirectionResult) return redirectionResult;

  const wrapperInfo = stripWrappersWithInfo(tokens);
  const commandCwd = resolveChildCwd(state.cwd, wrapperInfo.childCwd, wrapperInfo.childCwdUnknown);
  const shellTokens = unwrapExecutionWrappers(wrapperInfo.tokens);
  const resolvedStdin = resolveStdinSource(
    command.redirections,
    stdinSource,
    context,
    state,
    segment,
  );
  if ("blocked" in resolvedStdin) return resolvedStdin.blocked;
  const shellStdinResult = analyzeShellStdin(
    shellTokens,
    resolvedStdin.source,
    context,
    commandCwd,
  );
  if (shellStdinResult) return shellStdinResult;

  if (command.name) {
    const reason = analyzeSegment(tokens, {
      ...context.options,
      cwd: context.originalCwd,
      effectiveCwd: commandCwd,
      analyzeNested: (
        nestedCommand: string,
        nestedCwd: string | null | undefined = commandCwd,
      ): string | null =>
        context.analyzeNestedCommand(nestedCommand, context.depth + 1, nestedCwd)?.reason ?? null,
    });
    if (reason) return { reason, segment };
  }

  updateEffectiveCwd(tokens, state);
  return null;
}

function analyzeIf(
  command: Extract<CommandNode, { type: "If" }>,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinResolution: StdinResolution,
): AnalyzeResult | null {
  if ("blocked" in stdinResolution) return stdinResolution.blocked;
  const stdinSource = stdinResolution.source;
  const possibleCwds: Array<string | null | undefined> = [];
  for (const clause of command.clauses) {
    const branchState: CwdState = { cwd: state.cwd };
    let result = analyzeStatements(clause.condition, context, branchState, stdinSource);
    if (result) return result;
    result = analyzeStatements(clause.body, context, branchState, stdinSource);
    if (result) return result;
    possibleCwds.push(branchState.cwd);
  }

  if (command.elseBody) {
    const elseState: CwdState = { cwd: state.cwd };
    const result = analyzeStatements(command.elseBody, context, elseState, stdinSource);
    if (result) return result;
    possibleCwds.push(elseState.cwd);
  } else {
    possibleCwds.push(state.cwd);
  }

  state.cwd = commonCwd(possibleCwds);
  return analyzeRedirections(command.redirections, context, state, segment);
}

function analyzeCase(
  command: Extract<CommandNode, { type: "Case" }>,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinResolution: StdinResolution,
): AnalyzeResult | null {
  if ("blocked" in stdinResolution) return stdinResolution.blocked;
  const stdinSource = stdinResolution.source;
  const word = analyzeWord(command.word, context, state, segment, stdinSource);
  if (word.blocked) return word.blocked;

  const possibleCwds: Array<string | null | undefined> = [state.cwd];
  for (const item of command.items) {
    const itemType: string = item.type;
    if (itemType !== "CaseItem") {
      continue;
    }
    const patternResult = analyzeWords(item.patterns, context, state, segment, stdinSource);
    if (patternResult) return patternResult;
    const itemState: CwdState = { cwd: state.cwd };
    const result = analyzeStatements(item.body, context, itemState, stdinSource);
    if (result) return result;
    possibleCwds.push(itemState.cwd);
  }
  state.cwd = commonCwd(possibleCwds);
  return analyzeRedirections(command.redirections, context, state, segment);
}

function analyzeLoopBody(
  body: readonly StatementNode[],
  context: WalkContext,
  state: CwdState,
  stdinSource: ShellStdinSource,
): AnalyzeResult | null {
  const bodyState: CwdState = { cwd: state.cwd };
  const result = analyzeStatements(body, context, bodyState, stdinSource);
  if (result) return result;
  if (bodyState.cwd !== state.cwd) state.cwd = null;
  return null;
}

function analyzeStatements(
  statements: readonly StatementNode[],
  context: WalkContext,
  state: CwdState,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  for (const statement of statements) {
    const result = analyzeStatement(statement, context, state, stdinSource);
    if (result) return result;
  }
  return null;
}

function analyzeWords(
  words: readonly WordNode[],
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  for (const word of words) {
    const analyzed = analyzeWord(word, context, state, segment, stdinSource);
    if (analyzed.blocked) return analyzed.blocked;
  }
  return null;
}

function analyzeWord(
  word: WordNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource = NO_STDIN,
): WordAnalysis {
  const wordType: string = word.type;
  if (wordType !== "Word") {
    return dynamicWord();
  }
  const values: string[] = [];
  let dynamic = false;
  for (const part of word.parts) {
    const analyzed = analyzeWordPart(part, context, state, segment, stdinSource);
    if (analyzed.blocked) return analyzed;
    values.push(analyzed.value.text);
    dynamic ||= analyzed.value.dynamic;
  }
  return { blocked: null, value: { text: values.join(""), dynamic } };
}

function analyzeWordPart(
  part: WordPart,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource,
): WordAnalysis {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "Escaped":
      return staticWord(part.value);
    case "DoubleQuoted": {
      const values: string[] = [];
      let dynamic = false;
      for (const nestedPart of part.parts) {
        const analyzed = analyzeWordPart(nestedPart, context, state, segment, stdinSource);
        if (analyzed.blocked) return analyzed;
        values.push(analyzed.value.text);
        dynamic ||= analyzed.value.dynamic;
      }
      return { blocked: null, value: { text: values.join(""), dynamic } };
    }
    case "ParameterExpansion": {
      const result = analyzeParameterOperation(
        part.operation,
        context,
        state,
        segment,
        stdinSource,
      );
      if (result) return { blocked: result };
      return dynamicWord(
        part.operation !== null ? NONTRIVIAL_DYNAMIC_EXPANSION_MARKER : PARAMETER_EXPANSION_MARKER,
      );
    }
    case "CommandSubstitution": {
      const result = analyzeNestedScript(part.body, context, state, segment, stdinSource);
      return result ? { blocked: result } : dynamicWord(COMMAND_SUBSTITUTION_MARKER);
    }
    case "ArithmeticExpansion": {
      const result = analyzeArithmeticExpression(part.expression, context, state, segment);
      return result ? { blocked: result } : dynamicWord(ARITHMETIC_EXPANSION_MARKER);
    }
    case "ProcessSubstitution": {
      const result = analyzeNestedScript(part.body, context, state, segment, stdinSource);
      return result ? { blocked: result } : staticWord("/dev/fd/__LILAC_PROCESS_SUBSTITUTION__");
    }
    case "BraceExpansion": {
      for (const item of part.items) {
        if (item.type === "Word") {
          const analyzed = analyzeWord(item.word, context, state, segment, stdinSource);
          if (analyzed.blocked) return analyzed;
        } else if (item.type !== "Range") {
          return dynamicWord(BRACE_EXPANSION_MARKER);
        }
      }
      return dynamicWord(BRACE_EXPANSION_MARKER);
    }
    case "TildeExpansion":
      return staticWord(`~${part.user ?? ""}`);
    case "Glob":
      if (part.pattern === "[") return staticWord(part.pattern);
      return {
        blocked: null,
        value: { text: `${part.pattern}${GLOB_EXPANSION_MARKER}`, dynamic: true },
      };
    default:
      return dynamicWord();
  }
}

function analyzeParameterOperation(
  operation: Extract<WordPart, { type: "ParameterExpansion" }>["operation"],
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource,
): AnalyzeResult | null {
  if (!operation) return null;
  switch (operation.type) {
    case "DefaultValue":
    case "AssignDefault":
    case "UseAlternative":
      return blockedFromWord(operation.word, context, state, segment, stdinSource);
    case "ErrorIfUnset":
      return operation.word
        ? blockedFromWord(operation.word, context, state, segment, stdinSource)
        : null;
    case "Substring": {
      let result = analyzeArithmeticExpression(operation.offset, context, state, segment);
      if (result) return result;
      if (operation.length) {
        result = analyzeArithmeticExpression(operation.length, context, state, segment);
      }
      return result;
    }
    case "PatternRemoval":
      return blockedFromWord(operation.pattern, context, state, segment, stdinSource);
    case "PatternReplacement": {
      const result = blockedFromWord(operation.pattern, context, state, segment, stdinSource);
      if (result) return result;
      return operation.replacement
        ? blockedFromWord(operation.replacement, context, state, segment, stdinSource)
        : null;
    }
    case "CaseModification":
      return operation.pattern
        ? blockedFromWord(operation.pattern, context, state, segment, stdinSource)
        : null;
    case "Transform":
      return null;
    case "Indirection":
      return operation.innerOp
        ? analyzeParameterOperation(operation.innerOp, context, state, segment, stdinSource)
        : null;
    case "Length":
    case "ArrayKeys":
    case "VarNamePrefix":
      return null;
    case "LengthSliceError":
    case "BadSubstitution":
      return null;
    default:
      return null;
  }
}

function blockedFromWord(
  word: WordNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource,
): AnalyzeResult | null {
  const result = analyzeWord(word, context, state, segment, stdinSource);
  return result.blocked;
}

function analyzeNestedScript(
  script: ScriptNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource,
): AnalyzeResult | null {
  if (context.depth + 1 >= MAX_RECURSION_DEPTH) {
    return null;
  }
  return analyzeScript(
    script,
    { ...context, depth: context.depth + 1 },
    { cwd: state.cwd },
    stdinSource,
  );
}

function analyzeRedirections(
  redirections: readonly RedirectionNode[],
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  for (const redirection of redirections) {
    const redirectionType: string = redirection.type;
    if (redirectionType !== "Redirection") {
      continue;
    }
    if (!REDIRECTION_OPERATORS.has(redirection.operator)) {
      continue;
    }
    const targetType: string = redirection.target.type;
    if (redirection.target.type === "HereDoc") {
      if (!redirection.target.quoted) {
        const analyzed = analyzeWord(
          redirection.target.content,
          context,
          state,
          segment,
          stdinSource,
        );
        if (analyzed.blocked) return analyzed.blocked;
      }
      continue;
    }
    if (targetType !== "Word") {
      continue;
    }

    const analyzed = analyzeWord(redirection.target, context, state, segment, stdinSource);
    if (analyzed.blocked) return analyzed.blocked;

    if (redirection.operator !== "<<<") {
      const reason = analyzeSensitiveTokens([analyzed.value.text]);
      if (reason) return { reason, segment };
    }
  }
  return null;
}

function analyzeShellStdin(
  wrappedTokens: readonly string[] | null,
  stdinSource: ShellStdinSource,
  context: WalkContext,
  effectiveCwd: string | null | undefined,
): AnalyzeResult | null {
  if (!wrappedTokens) return null;
  const staticTokens = wrappedTokens.map(stripExpansionMarkers);
  const shell = normalizeCommandToken(staticTokens[0] ?? "");
  if (!SHELL_WRAPPERS.has(shell)) return null;

  if (stdinSource.kind === "none") return null;
  if (stdinSource.kind === "static") {
    return context.analyzeNestedCommand(stdinSource.payload, context.depth + 1, effectiveCwd);
  }
  return null;
}

type StdinResolution = { readonly source: ShellStdinSource } | { readonly blocked: AnalyzeResult };

function resolveCompoundStdin(
  redirections: readonly RedirectionNode[],
  inheritedSource: ShellStdinSource,
  context: WalkContext,
  state: CwdState,
  segment: string,
): StdinResolution {
  const redirectionResult = analyzeRedirections(
    redirections,
    context,
    state,
    segment,
    inheritedSource,
  );
  if (redirectionResult) return { blocked: redirectionResult };
  return resolveStdinSource(redirections, inheritedSource, context, state, segment);
}

function resolveStdinSource(
  redirections: readonly RedirectionNode[],
  inheritedSource: ShellStdinSource,
  context: WalkContext,
  state: CwdState,
  segment: string,
): StdinResolution {
  const fdSources = new Map<number, ShellStdinSource>();
  fdSources.set(0, inheritedSource);

  for (const redirection of redirections) {
    const fd = redirection.fd ?? defaultRedirectionFd(redirection.operator);
    if (
      redirection.operator === "<<" ||
      redirection.operator === "<<-" ||
      redirection.operator === "<<<"
    ) {
      const word =
        redirection.target.type === "HereDoc" ? redirection.target.content : redirection.target;
      const analyzed = analyzeWord(word, context, state, segment, inheritedSource);
      if (analyzed.blocked) return { blocked: analyzed.blocked };
      fdSources.set(
        fd,
        analyzed.value.dynamic
          ? { kind: "dynamic" }
          : { kind: "static", payload: stripExpansionMarkers(analyzed.value.text) },
      );
      continue;
    }

    if (redirection.target.type !== "Word") continue;
    const target = analyzeWord(redirection.target, context, state, segment, inheritedSource);
    if (target.blocked) return { blocked: target.blocked };
    const staticTarget = stripExpansionMarkers(target.value.text);

    if (redirection.operator === "<" || redirection.operator === "<>") {
      fdSources.set(fd, staticTarget === "/dev/null" ? { kind: "none" } : { kind: "file" });
      continue;
    }

    if (redirection.operator === "<&" || (redirection.operator === ">&" && fd === 0)) {
      if (staticTarget === "-") {
        fdSources.set(fd, { kind: "none" });
        continue;
      }
      const sourceFd = parseFdTarget(staticTarget);
      fdSources.set(
        fd,
        sourceFd === null ? { kind: "unknown" } : (fdSources.get(sourceFd) ?? { kind: "unknown" }),
      );
      if (staticTarget.endsWith("-") && sourceFd !== null) fdSources.delete(sourceFd);
    }
  }

  return { source: fdSources.get(0) ?? { kind: "unknown" } };
}

function defaultRedirectionFd(operator: RedirectionNode["operator"]): number {
  return operator.startsWith("<") ? 0 : 1;
}

function parseFdTarget(target: string): number | null {
  const normalized = target.endsWith("-") ? target.slice(0, -1) : target;
  return /^\d+$/u.test(normalized) ? Number.parseInt(normalized, 10) : null;
}

function unwrapExecutionWrappers(tokens: readonly string[]): string[] | null {
  let result = [...tokens];
  while (
    COMMAND_EXECUTION_WRAPPERS.has(normalizeCommandToken(stripExpansionMarkers(result[0] ?? "")))
  ) {
    const unwrapped = unwrapStaticExecutionWrapper(result);
    if (!unwrapped) return null;
    result = unwrapped;
  }
  return result;
}

function analyzeConditionalExpression(
  expression: ConditionalExpressionNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
  stdinSource: ShellStdinSource = NO_STDIN,
): AnalyzeResult | null {
  switch (expression.type) {
    case "CondBinary": {
      const left = analyzeWord(expression.left, context, state, segment, stdinSource);
      if (left.blocked) return left.blocked;
      const right = analyzeWord(expression.right, context, state, segment, stdinSource);
      if (right.blocked) return right.blocked;
      const reason = analyzeSensitiveTokens([left.value.text, right.value.text]);
      return reason ? { reason, segment } : null;
    }
    case "CondUnary":
    case "CondWord": {
      const word = analyzeWord(
        expression.type === "CondUnary" ? expression.operand : expression.word,
        context,
        state,
        segment,
        stdinSource,
      );
      if (word.blocked) return word.blocked;
      const reason = analyzeSensitiveTokens([word.value.text]);
      return reason ? { reason, segment } : null;
    }
    case "CondNot":
      return analyzeConditionalExpression(expression.operand, context, state, segment, stdinSource);
    case "CondAnd":
    case "CondOr": {
      const left = analyzeConditionalExpression(
        expression.left,
        context,
        state,
        segment,
        stdinSource,
      );
      return (
        left ?? analyzeConditionalExpression(expression.right, context, state, segment, stdinSource)
      );
    }
    case "CondGroup":
      return analyzeConditionalExpression(
        expression.expression,
        context,
        state,
        segment,
        stdinSource,
      );
    default:
      return null;
  }
}

function analyzeArithmeticExpression(
  expression: ArithmeticExpressionNode,
  context: WalkContext,
  state: CwdState,
  _segment: string,
): AnalyzeResult | null {
  const expressionType: string = expression.type;
  if (expressionType !== "ArithmeticExpression") {
    return null;
  }
  return analyzeArithExpr(expression.expression, context, state);
}

function analyzeArithExpr(
  expression: ArithExpr,
  context: WalkContext,
  state: CwdState,
): AnalyzeResult | null {
  switch (expression.type) {
    case "ArithCommandSubst":
      return context.analyzeNestedCommand(expression.command, context.depth + 1, state.cwd);
    case "ArithBinary":
      return (
        analyzeArithExpr(expression.left, context, state) ??
        analyzeArithExpr(expression.right, context, state)
      );
    case "ArithUnary":
      return analyzeArithExpr(expression.operand, context, state);
    case "ArithTernary":
      return (
        analyzeArithExpr(expression.condition, context, state) ??
        analyzeArithExpr(expression.consequent, context, state) ??
        analyzeArithExpr(expression.alternate, context, state)
      );
    case "ArithAssignment": {
      if (expression.subscript) {
        const result = analyzeArithExpr(expression.subscript, context, state);
        if (result) return result;
      }
      return analyzeArithExpr(expression.value, context, state);
    }
    case "ArithDynamicAssignment": {
      let result = analyzeArithExpr(expression.target, context, state);
      if (result) return result;
      if (expression.subscript) {
        result = analyzeArithExpr(expression.subscript, context, state);
        if (result) return result;
      }
      return analyzeArithExpr(expression.value, context, state);
    }
    case "ArithDynamicElement":
      return (
        analyzeArithExpr(expression.nameExpr, context, state) ??
        analyzeArithExpr(expression.subscript, context, state)
      );
    case "ArithGroup":
    case "ArithNested":
      return analyzeArithExpr(expression.expression, context, state);
    case "ArithArrayElement": {
      if (expression.index) {
        const result = analyzeArithExpr(expression.index, context, state);
        if (result) return result;
      }
      return null;
    }
    case "ArithDoubleSubscript":
      return analyzeArithExpr(expression.index, context, state);
    case "ArithConcat":
      for (const part of expression.parts) {
        const result = analyzeArithExpr(part, context, state);
        if (result) return result;
      }
      return null;
    case "ArithSyntaxError":
    case "ArithNumberSubscript":
      return null;
    case "ArithBracedExpansion": {
      const probe = `printf '%s' "\${${expression.content}}"`;
      return context.analyzeNestedCommand(probe, context.depth + 1, state.cwd);
    }
    case "ArithVariable":
    case "ArithDynamicBase":
    case "ArithDynamicNumber":
      return null;
    case "ArithNumber":
    case "ArithSpecialVar":
    case "ArithSingleQuote":
      return null;
    default:
      return null;
  }
}

function updateEffectiveCwd(tokens: readonly string[], state: CwdState): void {
  const wrapperInfo = stripWrappersWithInfo([...tokens]);
  if (wrapperInfo.commandLookupOnly) return;
  const rawUnwrapped = wrapperInfo.tokens;
  const unwrapped = rawUnwrapped.map(stripExpansionMarkers);
  let headIndex = 0;
  if (normalizeCommandToken(unwrapped[0] ?? "") === "builtin") headIndex = 1;
  const head = normalizeCommandToken(unwrapped[headIndex] ?? "");
  if (head !== "cd" && head !== "pushd" && head !== "popd") return;
  if (head !== "cd" || (wrapperInfo.envAssignments.get("CDPATH") ?? "") !== "") {
    state.cwd = null;
    return;
  }

  let targetIndex = headIndex + 1;
  if (unwrapped[targetIndex] === "--") targetIndex++;
  const target = unwrapped[targetIndex];
  const rawTarget = rawUnwrapped[targetIndex];
  if (
    !target ||
    !rawTarget ||
    rawTarget.includes(DYNAMIC_EXPANSION_MARKER) ||
    target.startsWith("-") ||
    target.startsWith("~") ||
    state.cwd == null
  ) {
    state.cwd = null;
    return;
  }

  state.cwd = isAbsolute(target) ? resolve(target) : resolve(state.cwd, target);
}

function resolveChildCwd(
  effectiveCwd: string | null | undefined,
  childCwd: string | undefined,
  childCwdUnknown: boolean,
): string | null | undefined {
  if (childCwdUnknown) return null;
  if (childCwd === undefined) return effectiveCwd;
  if (childCwd.startsWith("~")) return null;
  if (isAbsolute(childCwd)) return resolve(childCwd);
  return effectiveCwd ? resolve(effectiveCwd, childCwd) : null;
}

function commonCwd(cwds: readonly (string | null | undefined)[]): string | null | undefined {
  const first = cwds[0];
  return cwds.every((cwd) => cwd === first) ? first : null;
}

function staticWord(text: string): WordAnalysis {
  return { blocked: null, value: { text, dynamic: false } };
}

function dynamicWord(marker = DYNAMIC_EXPANSION_MARKER): WordAnalysis {
  return {
    blocked: null,
    value: {
      text: marker,
      dynamic: true,
    },
  };
}
