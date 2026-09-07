import { TaggedError } from "better-result";

export type ToolResultArtifactMetadataIssueCode =
  | "metadata-absent"
  | "unsupported-version"
  | "malformed-serialization"
  | "corrupt-fields"
  | "storage-key-mismatch";

type MetadataErrorContext = {
  readonly issueCode: ToolResultArtifactMetadataIssueCode;
  readonly message: string;
};

export class ToolResultArtifactMetadataAbsent extends TaggedError(
  "ToolResultArtifactMetadataAbsent",
)<MetadataErrorContext> {}

export class ToolResultArtifactMetadataUnsupportedVersion extends TaggedError(
  "ToolResultArtifactMetadataUnsupportedVersion",
)<MetadataErrorContext & { readonly version: number }> {}

export class ToolResultArtifactMetadataMalformed extends TaggedError(
  "ToolResultArtifactMetadataMalformed",
)<MetadataErrorContext> {}

export class ToolResultArtifactMetadataCorrupt extends TaggedError(
  "ToolResultArtifactMetadataCorrupt",
)<MetadataErrorContext> {}

export class ToolResultArtifactMetadataStorageKeyMismatch extends TaggedError(
  "ToolResultArtifactMetadataStorageKeyMismatch",
)<MetadataErrorContext> {}

export type ToolResultArtifactMetadataCodecError =
  | ToolResultArtifactMetadataAbsent
  | ToolResultArtifactMetadataUnsupportedVersion
  | ToolResultArtifactMetadataMalformed
  | ToolResultArtifactMetadataCorrupt
  | ToolResultArtifactMetadataStorageKeyMismatch;
