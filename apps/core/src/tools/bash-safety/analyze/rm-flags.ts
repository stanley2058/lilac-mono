export function hasRecursiveForceFlags(tokens: readonly string[]): boolean {
  return hasRmFlag(tokens, "recursive") && hasRmFlag(tokens, "force");
}

export function hasRecursiveFlag(tokens: readonly string[]): boolean {
  return hasRmFlag(tokens, "recursive");
}

function hasRmFlag(tokens: readonly string[], flag: "recursive" | "force"): boolean {
  for (const token of tokens) {
    if (token === "--") break;

    if (token.startsWith("--")) {
      if (flag === "recursive" && token.startsWith("--rec")) return true;
      if (flag === "force" && token.startsWith("--for")) return true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") continue;
    if (flag === "recursive" && /[rR]/u.test(token.slice(1))) return true;
    if (flag === "force" && token.slice(1).includes("f")) return true;
  }

  return false;
}
