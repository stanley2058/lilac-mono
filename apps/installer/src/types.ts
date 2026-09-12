import type { JSONValue } from "../../../packages/utils/core-config/types";

export type Prompt = {
  text(options: {
    message: string;
    initial?: string;
    secret?: boolean;
    required?: boolean;
  }): Promise<string>;
  select<T extends string>(
    message: string,
    choices: readonly { value: T; label: string }[],
    initial?: T,
  ): Promise<T>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  note(message: string): void;
};

export type SetupFile = {
  relativePath: string;
  content: string;
  mode?: number;
};

export type SetupDraft = {
  get(path: string[]): JSONValue | undefined;
  set(path: string[], value: JSONValue): void;
  remove(path: string[]): void;
  secrets: Record<string, string>;
  configuredEnvironmentKeys?: Set<string>;
  files: SetupFile[];
  stagingDir: string;
  readExistingFile(relativePath: string): Promise<string | undefined>;
  computerEnabled: boolean;
  computerConfigured?: boolean;
};
