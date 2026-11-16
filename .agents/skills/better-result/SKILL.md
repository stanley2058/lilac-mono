---
name: better-result
description: Better Result coding guidance for TypeScript expected failures. Use when writing, modifying, or reviewing code with better-result, Result, TaggedError, Panic, Result codecs, exception adapters, or fallible workflows.
---

# Better Result

Use the installed `better-result` public API and Lilac's local architecture policy. Do not introduce a
wrapper or rely on remembered signatures.

## Establish The Contract

1. Read the nearest Result-returning code, its callers, and its final handling boundary.
2. Inspect the installed `better-result` declarations when a signature or inferred union is uncertain.
3. Classify each failure as an expected caller decision, an external exception to translate once, or a
   defect represented by `Panic`.

The contract is established when every expected error reaches an explicit policy boundary and defects
remain defects.

## Keep Result Workflows Flat

Apply the repository's flat-control-flow rule to fallible workflows.

- Prefer `Result.gen` for sequential fallible steps. It keeps the workflow linear and in one expression.
- When `Result.gen` does not fit, settle a Result with a positive `if (result.isErr())` guard and read
  `result.value` after the terminal Err branch. Match or guard each Result once; never match it a second
  time to extract the value with a placeholder in the impossible arm.
- Settle terminal and loop-only branches immediately with `return`, `continue`, or `break` before the next
  step of the happy path.
- When control flow must leave the Result abstraction before a final boundary, use `match` once to produce
  a data-only domain decision. Branch on that decision outside the callback.
- Keep subsequent operations outside `match`, `map`, `andThen`, and recovery callbacks. Extract a named
  function when a continuation needs multiple steps.

## Choose The Syntax

- Use `Result.ok` and `Result.err` to construct a Result. Use domain-owned `TaggedError` variants when
  callers need to distinguish failures.
- Use `map` for a pure success transformation and `mapError` for error translation. A callback returning a
  Result belongs in `andThen`, not `map`.
- Use `andThen` for one Result-returning continuation. Use `tryRecover` only when the error branch can
  recover to another Result; do not use it as error mapping.
- Use `Result.gen` with `yield*` for linear control flow with multiple fallible steps, intermediate values,
  or Result-based guard clauses. End the generator with `Result.ok(value)`.
- In an async `Result.gen`, write `yield* Result.await(operation())` for `Promise<Result<T, E>>`. Do not
  write `yield* await operation()`.
- For a short async continuation, use `andThenAsync` with a named async Result-returning function. Lilac's
  syntax gate rejects inline async Result callbacks.
- Use `Result.all` when every operation must succeed and `Result.partition` when all successes and errors
  must be retained. Use their async variants only with promises that resolve to Results.
- Use object-form `Result.try` or `Result.tryPromise` at an external exception boundary. Its catch function
  must be total: return a closed captured value and never throw, reject, or signal a host. Classify or
  re-signal retained defects only after leaving protected Better Result callbacks. Settle the captured
  Result with `Result.gen` or a positive `isErr()` guard. Forward cancellation signals when the operation
  supports them.
- Use `match` at a final policy or host boundary, or to project one Result into a data-only domain decision
  required by flat control flow. A `match` handler must not own the remaining workflow, and a continuation
  selected by `match` must not contain another one. Exhaustively match
  tagged error unions at the final boundary rather than spreading error policy through the workflow.
- Use `Result.codec` with boundary-owned schemas for persisted, wire, or independently versioned Result
  data.

## Preserve Local Boundaries

Lilac is stricter than upstream examples: apart from the positive `isErr()` guard on an immutable local or
unchanged parameter, production code composes Results declaratively rather than reading branch
discriminants, calling `isOk` or static guards, or extracting with `unwrap`. The guard must be the complete
`if` condition in the block that declares the Result. Follow diagnostics from `scripts/architecture` and read
`scripts/architecture/README.md` before changing a registered boundary.

Better Result protects combinator and `match` callbacks by wrapping thrown values in a new `Panic`. Treat
an existing thunked `match` as an exception-boundary marker, not as a pattern to copy. Preserve it until
focused tests prove exception identity, cleanup ordering, and transaction behavior. Introduce a thunked
handler only at a reviewed boundary where an operation must execute outside Better Result's protected
callback.

Production `TryStatement` syntax is forbidden. Use `using` or `await using` only when lexical ownership and
`SuppressedError` precedence match the required policy. When cleanup can fail or an original Panic must win,
capture operation and cleanup outcomes separately and settle their precedence outside protected callbacks.

When API details are still unclear, read the smallest relevant page indexed by
`https://better-result.dev/agents.txt` rather than loading the full documentation corpus.

## Verify

Run the focused workspace test and typecheck, then `bun run lint:architecture` for production Result
changes. The change is complete when inferred success and error unions are preserved and every applicable
check passes.
