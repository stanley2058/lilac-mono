import { tmpdir } from "node:os";

export function isTmpdirOverriddenToNonTemp(
  envAssignments: Map<string, string>,
): boolean {
  if (!envAssignments.has("TMPDIR")) {
    return false;
  }

  const tmpdirValue = envAssignments.get("TMPDIR") ?? "";

  // Empty TMPDIR is dangerous: $TMPDIR/foo expands to /foo.
  if (tmpdirValue === "") {
    return true;
  }

  const sysTmpdir = tmpdir();
  if (
    isPathOrSubpath(tmpdirValue, "/tmp") ||
    isPathOrSubpath(tmpdirValue, "/var/tmp") ||
    isPathOrSubpath(tmpdirValue, sysTmpdir)
  ) {
    return false;
  }

  return true;
}

function isPathOrSubpath(path: string, basePath: string): boolean {
  if (path === basePath) {
    return true;
  }

  const baseWithSlash = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return path.startsWith(baseWithSlash);
}
