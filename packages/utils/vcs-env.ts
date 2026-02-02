import path from "node:path";

function normalizeDataDir(dataDir: string): string {
  // Keep relative paths stable by resolving against CWD.
  // In Docker, this is typically /app.
  return path.resolve(process.cwd(), dataDir);
}

export function resolveVcsPaths(params: {
  dataDir: string;
}): {
  dataDir: string;
  gitConfigGlobal: string;
  secretDir: string;
  gnupgHome: string;
  xdgConfigHome: string;
} {
  const resolved = normalizeDataDir(params.dataDir);
  const secretDir = path.join(resolved, "secret");

  return {
    dataDir: resolved,
    gitConfigGlobal: path.join(resolved, ".gitconfig"),
    secretDir,
    // Store unencrypted signing keys under secret/ and denylist that path.
    gnupgHome: path.join(secretDir, "gnupg"),
    xdgConfigHome: path.join(resolved, ".config"),
  };
}

export function resolveVcsEnv(params: {
  dataDir: string;
}): {
  GIT_CONFIG_GLOBAL: string;
  GNUPGHOME: string;
  XDG_CONFIG_HOME: string;
} {
  const paths = resolveVcsPaths(params);
  return {
    GIT_CONFIG_GLOBAL: paths.gitConfigGlobal,
    GNUPGHOME: paths.gnupgHome,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
  };
}
