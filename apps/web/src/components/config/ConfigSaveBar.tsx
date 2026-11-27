import { lazy, Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { RotateCcw } from "lucide-react";
import {
  isConfigObject,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { uiError } from "../ui";
import { useWorkspace } from "../../workspace-context";
import { useConfigDraftStore, useConfigDrafts } from "../../config-ui/draft-store";
import { requiresRestart } from "../../config-ui/field-model";
import { manifestLabel, type Manifest } from "../../config-ui/manifest";
import { decodeSaveFailure } from "../../config-ui/save-failure";
import { configSaveLock, useConfigSaving } from "../../config-ui/save-lock";
import type { ConfigKind } from "../../config-ui/schemas";
import { useMcpReload } from "./McpServerStatus";

const ConfigDiffEditor = lazy(() => import("./ConfigDiffEditor"));

/** Leaf paths whose values differ between two parsed files. */
export function changedConfigPaths(
  before: ConfigValue | undefined,
  after: ConfigValue | undefined,
  path: ConfigPath = [],
): ConfigPath[] {
  if (isConfigObject(before) && isConfigObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => changedConfigPaths(before[key], after[key], [...path, key]));
  }
  if (isConfigObject(before) && after === undefined)
    return Object.keys(before).flatMap((key) =>
      changedConfigPaths(before[key], undefined, [...path, key]),
    );
  if (isConfigObject(after) && before === undefined)
    return Object.keys(after).flatMap((key) =>
      changedConfigPaths(undefined, after[key], [...path, key]),
    );
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [path];
}

function restartLabels<P extends string>(
  manifest: Manifest<P>,
  paths: readonly ConfigPath[],
): string[] {
  return [
    ...new Set(
      paths
        .filter((path) => requiresRestart(manifest.kind, path))
        .map((path) => manifestLabel(manifest, path) ?? path.map(String).join(".")),
    ),
  ];
}

function SaveStatus({
  kind,
  conflict,
  error,
  changes,
  restart,
  status,
}: {
  kind: ConfigKind;
  conflict: boolean;
  error?: string;
  changes: number;
  restart: readonly string[];
  status?: string;
}) {
  if (error) return <span className="whitespace-pre-wrap text-danger">{error}</span>;
  if (conflict) return <span className="text-warning">The file changed outside this editor.</span>;
  if (changes > 0)
    return (
      <span>
        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" />
        {changes === 1 ? "1 unsaved change" : `${changes} unsaved changes`}
      </span>
    );
  if (restart.length > 0)
    return (
      <span className="inline-flex items-center gap-1.5 text-warning">
        <RotateCcw className="size-3.5" />
        Saved. Restart Core to apply {restart.join(", ")}.
      </span>
    );
  if (status === "Saved")
    return (
      <span className="text-muted-foreground">
        {kind === "core" ? "Saved. Core applies changes automatically." : "Saved and reloaded."}
      </span>
    );
  // Status other than plain progress, such as a server that did not load, needs attention.
  const progress = status === RELOADING || status === undefined;
  return <span className={progress ? "text-muted-foreground" : "text-warning"}>{status}</span>;
}

const RELOADING = "Saved. Reloading MCP…";

export function ConfigSaveBar<P extends string>({ manifest }: { manifest: Manifest<P> }) {
  const { kind } = manifest;
  const { client } = useWorkspace();
  const store = useConfigDraftStore();
  const queries = useQueryClient();
  const reload = useMcpReload();
  const draft = useConfigDrafts((state) => state.drafts[kind]);
  const saving = useConfigSaving(kind);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [restart, setRestart] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(false);
  if (!draft) return null;
  const dirty = draft.text !== draft.saved.text;
  const changes = dirty ? changedConfigPaths(draft.savedValue, draft.value).length : 0;

  async function save() {
    const current = store.getState().drafts[kind];
    const rpc = client.rpc;
    if (!rpc || !current) return;
    const attempt = configSaveLock.getState().begin(kind);
    if (attempt === undefined) return;
    // Release the lock even when the attempt fails unexpectedly.
    const outcome = await Result.tryPromise({
      try: () => saveAttempt(rpc, current, attempt),
      catch: uiError,
    });
    configSaveLock.getState().end(kind, attempt);
    outcome.match({ ok: () => undefined, err: setError });
  }

  async function saveAttempt(
    rpc: NonNullable<typeof client.rpc>,
    current: NonNullable<typeof draft>,
    attempt: number,
  ) {
    setError(undefined);
    const changed = changedConfigPaths(current.savedValue, current.value);
    const result = await Result.tryPromise({
      try: () =>
        rpc.config.save({ kind, expectedRevision: current.saved.revision, text: current.text }),
      catch: decodeSaveFailure,
    });
    const saved = result.match({
      ok: (document) => document,
      err: (failure) => {
        if (failure.conflict) setConflict(true);
        else setError(failure.message);
        return undefined;
      },
    });
    if (!saved) return;
    store.getState().completeSave(kind, current.editRevision, saved);
    setConflict(false);
    setReviewing(false);
    setRestart(restartLabels(manifest, changed));
    void queries.invalidateQueries({ queryKey: ["config", kind] });
    if (kind !== "mcp") return;
    // Save stays disabled until the reload settles, so one reload reports per save.
    store.getState().setStatus(kind, RELOADING);
    const failure = await reload();
    // A newer edit or save replaces the status; do not bring back an outdated message.
    const latest = configSaveLock.getState().saves[kind]?.attempt === attempt;
    if (!latest || store.getState().drafts[kind]?.status !== RELOADING) return;
    store.getState().setStatus(kind, failure ? `Saved. ${failure}` : "Saved");
  }

  async function loadLatest(reapply: boolean) {
    const rpc = client.rpc;
    const current = store.getState().drafts[kind];
    if (!rpc || !current || recovering) return;
    setRecovering(true);
    const latest = await Result.tryPromise({
      try: () => rpc.config.read({ kind }),
      catch: uiError,
    });
    setRecovering(false);
    const document = latest.match({
      ok: (value) => value,
      err: (message) => {
        setError(message);
        return undefined;
      },
    });
    if (!document) return;
    if (store.getState().drafts[kind]?.editRevision !== current.editRevision)
      return setError("You edited while the latest file loaded. Try again.");
    if (!reapply || !current.operations) {
      store.getState().replace(document);
      setError(undefined);
      return setConflict(false);
    }
    const failed = store.getState().rebase(document, current.operations);
    if (failed) return setError(`Your changes do not apply to the latest file: ${failed}`);
    setError(undefined);
    setConflict(false);
  }

  if (!dirty && !conflict && !error && restart.length === 0 && !draft.status) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved configuration"
      className="flex flex-none flex-wrap items-center gap-2 border-t border-border pt-3"
    >
      <div className="mr-auto min-w-0 text-sm" role="status">
        <SaveStatus
          kind={kind}
          conflict={conflict}
          error={error}
          changes={dirty ? Math.max(changes, 1) : 0}
          restart={restart}
          status={draft.status}
        />
      </div>
      {conflict && draft.operations ? (
        <Button size="sm" disabled={recovering} onClick={() => void loadLatest(true)}>
          Reapply my changes
        </Button>
      ) : null}
      {conflict ? (
        <Button
          variant="outline"
          size="sm"
          disabled={recovering}
          onClick={() => void loadLatest(false)}
        >
          Load latest
        </Button>
      ) : null}
      {!conflict && dirty ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setReviewing(true)}>
            Review
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              store.getState().discard(kind);
              setError(undefined);
            }}
          >
            Discard
          </Button>
          <Button
            size="sm"
            data-config-save={kind}
            disabled={saving || draft.value === undefined}
            onClick={() => void save()}
          >
            {saving ? "Saving" : "Save"}
          </Button>
        </>
      ) : null}
      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent className="flex h-[min(40rem,_calc(100dvh_-_4rem))] w-[min(56rem,_calc(100vw_-_2rem))] max-w-none flex-col gap-4 sm:max-w-none">
          <DialogTitle>Review changes</DialogTitle>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
            <Suspense fallback={null}>
              <ConfigDiffEditor
                original={draft.saved.text}
                modified={draft.text}
                label={`${kind === "core" ? "Core" : "MCP"} configuration changes`}
              />
            </Suspense>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReviewing(false)}>
              Close
            </Button>
            <Button disabled={saving || draft.value === undefined} onClick={() => void save()}>
              {saving ? "Saving" : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
