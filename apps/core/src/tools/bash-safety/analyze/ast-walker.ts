import type { CommandNode, ScriptNode, StatementNode, WordNode } from "just-bash";

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

const REASON_DYNAMIC_REDIRECTION =
  "A redirection target is determined by a dynamic shell expansion and cannot be safely analyzed.";
const REASON_PROMPT_EXPANSION =
  "Bash prompt expansion can execute variable contents and cannot be safely analyzed.";
const REASON_RECURSION_LIMIT =
  "Command could not be safely analyzed because nested shell recursion exceeded the safety limit.";
const REASON_DYNAMIC_SHELL_STDIN =
  "Shell stdin contains dynamic executable content and cannot be safely analyzed.";
const REASON_DYNAMIC_ARITHMETIC =
  "Arithmetic evaluation depends on runtime-controlled content and cannot be safely analyzed.";
const STATEMENT_OPERATORS = new Set(["&&", "||", ";"]);
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
    return unsupportedResult("script node", scriptType, "script");
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
    return unsupportedResult("statement node", statementType, segment);
  }
  const unsupportedOperator = statement.operators.find(
    (operator) => !STATEMENT_OPERATORS.has(operator),
  );
  if (unsupportedOperator) {
    return unsupportedResult("statement operator", unsupportedOperator, segment);
  }
  if (statement.deferredError) {
    return {
      reason: `Command could not be safely analyzed because the parser deferred a syntax error: ${sanitizeDetail(statement.deferredError.message)}.`,
      segment,
    };
  }

  const initialCwd = state.cwd;
  let conditionallyChangedCwd = false;
  for (let i = 0; i < statement.pipelines.length; i++) {
    const beforePipelineCwd = state.cwd;
    const pipeline = statement.pipelines[i];
    if (!pipeline) continue;

    const result = analyzePipeline(pipeline, context, state, segment, stdinSource);
    if (result) return result;

    const precedingOperator = statement.operators[i - 1];
    if (
      i > 0 &&
      (precedingOperator === "&&" || precedingOperator === "||") &&
      state.cwd !== beforePipelineCwd
    ) {
      conditionallyChangedCwd = true;
    }
  }

  if (
    conditionallyChangedCwd ||
    (statement.operators.some((operator) => operator === "&&" || operator === "||") &&
      state.cwd !== initialCwd)
  ) {
    state.cwd = null;
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
    return unsupportedResult("pipeline node", pipelineType, segment);
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
  const commandType: string = command.type;
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
      return unsupportedResult("command node", commandType, segment);
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
      return unsupportedResult("assignment node", assignmentType, segment);
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
  const commandCwd = wrapperInfo.childCwdUnknown ? null : state.cwd;
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
    segment,
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
      return unsupportedResult("case item", itemType, segment);
    }
    if (item.terminator !== ";;" && item.terminator !== ";&" && item.terminator !== ";;&") {
      return unsupportedResult("case terminator", item.terminator, segment);
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
    return { blocked: unsupportedResult("word node", wordType, segment) };
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
  const partType: string = part.type;
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
        const itemType: string = item.type;
        if (item.type === "Word") {
          const analyzed = analyzeWord(item.word, context, state, segment, stdinSource);
          if (analyzed.blocked) return analyzed;
        } else if (item.type !== "Range") {
          return { blocked: unsupportedResult("brace item", itemType, segment) };
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
      return {
        blocked: unsupportedResult("word part", partType, segment),
      };
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
  const operationType: string = operation.type;
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
      return operation.operator === "P" ? { reason: REASON_PROMPT_EXPANSION, segment } : null;
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
      return unsupportedResult("parameter expansion", operationType, segment);
    default:
      return unsupportedResult("parameter operation", operationType, segment);
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
    return { reason: REASON_RECURSION_LIMIT, segment };
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
      return unsupportedResult("redirection node", redirectionType, segment);
    }
    if (!REDIRECTION_OPERATORS.has(redirection.operator)) {
      return unsupportedResult("redirection operator", redirection.operator, segment);
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
      return unsupportedResult("redirection target", targetType, segment);
    }

    const analyzed = analyzeWord(redirection.target, context, state, segment, stdinSource);
    if (analyzed.blocked) return analyzed.blocked;
    if (redirection.operator !== "<<<" && analyzed.value.dynamic) {
      return { reason: REASON_DYNAMIC_REDIRECTION, segment };
    }

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
  segment: string,
): AnalyzeResult | null {
  if (!wrappedTokens) return null;
  const staticTokens = wrappedTokens.map(stripExpansionMarkers);
  const shell = normalizeCommandToken(staticTokens[0] ?? "");
  if (!SHELL_WRAPPERS.has(shell)) return null;

  if (stdinSource.kind === "none") return null;
  if (stdinSource.kind === "static") {
    return context.analyzeNestedCommand(stdinSource.payload, context.depth + 1, effectiveCwd);
  }
  if (stdinSource.kind === "dynamic") return { reason: REASON_DYNAMIC_SHELL_STDIN, segment };
  return {
    reason:
      "Shell stdin may contain uninspectable executable content and cannot be safely analyzed.",
    segment,
  };
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
  const expressionType: string = expression.type;
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
      return unsupportedResult("conditional expression", expressionType, segment);
  }
}

function analyzeArithmeticExpression(
  expression: ArithmeticExpressionNode,
  context: WalkContext,
  state: CwdState,
  segment: string,
): AnalyzeResult | null {
  const expressionType: string = expression.type;
  if (expressionType !== "ArithmeticExpression") {
    return unsupportedResult("arithmetic expression", expressionType, segment);
  }
  return analyzeArithExpr(expression.expression, context, state, segment);
}

function analyzeArithExpr(
  expression: ArithExpr,
  context: WalkContext,
  state: CwdState,
  segment: string,
): AnalyzeResult | null {
  const expressionType: string = expression.type;
  switch (expression.type) {
    case "ArithCommandSubst":
      return (
        context.analyzeNestedCommand(expression.command, context.depth + 1, state.cwd) ?? {
          reason: REASON_DYNAMIC_ARITHMETIC,
          segment,
        }
      );
    case "ArithBinary":
      return (
        analyzeArithExpr(expression.left, context, state, segment) ??
        analyzeArithExpr(expression.right, context, state, segment)
      );
    case "ArithUnary":
      return analyzeArithExpr(expression.operand, context, state, segment);
    case "ArithTernary":
      return (
        analyzeArithExpr(expression.condition, context, state, segment) ??
        analyzeArithExpr(expression.consequent, context, state, segment) ??
        analyzeArithExpr(expression.alternate, context, state, segment)
      );
    case "ArithAssignment": {
      if (expression.subscript) {
        const result = analyzeArithExpr(expression.subscript, context, state, segment);
        if (result) return result;
      }
      return analyzeArithExpr(expression.value, context, state, segment);
    }
    case "ArithDynamicAssignment": {
      let result = analyzeArithExpr(expression.target, context, state, segment);
      if (result) return result;
      if (expression.subscript) {
        result = analyzeArithExpr(expression.subscript, context, state, segment);
        if (result) return result;
      }
      return analyzeArithExpr(expression.value, context, state, segment);
    }
    case "ArithDynamicElement":
      return (
        analyzeArithExpr(expression.nameExpr, context, state, segment) ??
        analyzeArithExpr(expression.subscript, context, state, segment)
      );
    case "ArithGroup":
    case "ArithNested":
      return analyzeArithExpr(expression.expression, context, state, segment);
    case "ArithArrayElement": {
      if (expression.index) {
        const result = analyzeArithExpr(expression.index, context, state, segment);
        if (result) return result;
      }
      return { reason: REASON_DYNAMIC_ARITHMETIC, segment };
    }
    case "ArithDoubleSubscript":
      return analyzeArithExpr(expression.index, context, state, segment);
    case "ArithConcat":
      for (const part of expression.parts) {
        const result = analyzeArithExpr(part, context, state, segment);
        if (result) return result;
      }
      return null;
    case "ArithSyntaxError":
    case "ArithNumberSubscript":
      return unsupportedResult("arithmetic node", expressionType, segment);
    case "ArithBracedExpansion": {
      const probe = `printf '%s' "\${${expression.content}}"`;
      return (
        context.analyzeNestedCommand(probe, context.depth + 1, state.cwd) ?? {
          reason: REASON_DYNAMIC_ARITHMETIC,
          segment,
        }
      );
    }
    case "ArithVariable":
    case "ArithDynamicBase":
    case "ArithDynamicNumber":
      return { reason: REASON_DYNAMIC_ARITHMETIC, segment };
    case "ArithNumber":
    case "ArithSpecialVar":
    case "ArithSingleQuote":
      return null;
    default:
      return unsupportedResult("arithmetic node", expressionType, segment);
  }
}

function updateEffectiveCwd(tokens: readonly string[], state: CwdState): void {
  const unwrapped = stripWrappersWithInfo([...tokens]).tokens.map(stripExpansionMarkers);
  let headIndex = 0;
  if (normalizeCommandToken(unwrapped[0] ?? "") === "builtin") headIndex = 1;
  const head = normalizeCommandToken(unwrapped[headIndex] ?? "");
  if (head !== "cd" && head !== "pushd" && head !== "popd") return;
  state.cwd = null;
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

function unsupportedResult(kind: string, type: string, segment: string): AnalyzeResult {
  return {
    reason: `Command could not be safely analyzed because the AST contained an unsupported ${kind} (${sanitizeDetail(type)}).`,
    segment,
  };
}

function sanitizeDetail(detail: string): string {
  return detail
    .replace(/`[^`]*`/g, "<token>")
    .replace(/'[^']*'/g, "<token>")
    .replace(/"[^"]*"/g, "<token>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^a-zA-Z0-9 _.:()/-]/g, "?")
    .slice(0, 160);
}
