import { ConfigDraftContext, createConfigDraftStore } from "../../config-ui/draft-store";
import type { ConfigStoreHolder } from "../../config-ui/store-holder";
import { coreManifest } from "../../config-ui/core-manifest";
import { mcpManifest } from "../../config-ui/mcp-manifest";
import type { ConfigKind } from "../../config-ui/schemas";
import { ConfigEditor } from "./ConfigEditor";

/** Loaded on demand so the schema and YAML parser stay out of the main bundle. */
export default function ConfigEditorPanel({
  kind,
  holder,
}: {
  kind: ConfigKind;
  holder: ConfigStoreHolder;
}) {
  return (
    <ConfigDraftContext value={holder.ensure(createConfigDraftStore)}>
      {kind === "core" ? (
        <ConfigEditor kind="core" title="Core" manifest={coreManifest} />
      ) : (
        <ConfigEditor kind="mcp" title="MCP" manifest={mcpManifest} />
      )}
    </ConfigDraftContext>
  );
}
