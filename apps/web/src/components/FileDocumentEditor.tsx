import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, RefreshCw } from "lucide-react";
import { useWorkspace } from "../workspace-context";
import { fileDraftKey } from "../file-editors";
import { fileLanguage, type FileTarget } from "../file-target";
import { queryNativeRPC } from "../queries";
import { attempt, ErrorNotice, IconButton } from "./ui";
import { Button } from "./ui/button";
import { CodeEditor } from "./CodeEditor";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function FileDocumentEditor({
  threadId,
  path,
  target,
  active,
  heading,
  actions,
}: {
  threadId: string;
  path: string;
  target: FileTarget;
  active: boolean;
  heading: ReactNode;
  actions: ReactNode;
}) {
  const { client, fileEditors } = useWorkspace();
  const queries = useQueryClient();
  const key = fileDraftKey(threadId, path);
  const draft = useStore(fileEditors, (state) => state.drafts.get(key));
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string>();
  const [confirmReload, setConfirmReload] = useState(false);
  const query = useQuery({
    queryKey: ["file-document", threadId, path],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.files.document({ threadId, path }, { signal })),
    enabled: active && !draft,
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (query.data && !query.isFetching) fileEditors.getState().load(key, query.data);
  }, [query.data, query.isFetching, fileEditors, key]);
  async function save() {
    const current = fileEditors.getState().drafts.get(key);
    if (!current || saving || reloading || current.text === current.savedText) return;
    setSaving(true);
    setError(undefined);
    const result = await attempt(
      () =>
        queryNativeRPC(client, (rpc) =>
          rpc.files.save({
            threadId,
            path,
            text: current.text,
            expectedRevision: current.revision,
          }),
        ),
      setError,
    );
    setSaving(false);
    if (!result) return;
    fileEditors.getState().saved(key, result);
    void queries.invalidateQueries({ queryKey: ["resource-preview"] });
  }
  async function reload() {
    setConfirmReload(false);
    setReloading(true);
    const result = await attempt(
      () => queryNativeRPC(client, (rpc) => rpc.files.document({ threadId, path })),
      setError,
    );
    // A reload finishing after this editor closed must not replace edits made in a newer editor.
    if (!mounted.current) return;
    setReloading(false);
    if (!result) return;
    fileEditors.getState().discard(key);
    fileEditors.getState().load(key, result);
    setError(undefined);
  }
  const dirty = draft && draft.text !== draft.savedText;
  return (
    <div className="flex flex-col flex-1 min-h-0" data-ui="file-document-editor">
      <div className="file-source-toolbar flex items-center flex-none gap-1 py-1 px-2">
        <div className="file-source-heading flex-1 min-w-0">{heading}</div>
        {actions}
        <IconButton
          label="Reload file"
          disabled={saving || reloading}
          onClick={() => (dirty ? setConfirmReload(true) : void reload())}
        >
          <RefreshCw />
        </IconButton>
        <Button size="sm" disabled={!dirty || saving || reloading} onClick={() => void save()}>
          <Save />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <ErrorNotice message={error ?? query.error?.message} />
      {draft ? (
        <CodeEditor
          value={draft.text}
          language={fileLanguage(path)}
          label={`Edit ${target.name}`}
          readOnly={reloading}
          onChange={(text) => fileEditors.getState().edit(key, text)}
          onSave={() => void save()}
          line={target.line}
          endLine={target.endLine}
          navigation={target}
        />
      ) : (
        <p className="p-3 text-sm text-muted-foreground">
          {query.isFetching ? "Loading file…" : "File unavailable"}
        </p>
      )}
      <Dialog open={confirmReload} onOpenChange={setConfirmReload}>
        <DialogContent>
          <DialogTitle>Discard edits and reload?</DialogTitle>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmReload(false)}>
              Cancel
            </Button>
            <Button onClick={() => void reload()}>Discard and reload</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
