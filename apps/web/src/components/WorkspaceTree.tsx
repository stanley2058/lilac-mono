import { useEffect, useEffectEvent, useState } from "react";
import { SkeletonRows } from "./ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronsDownUp, RefreshCw } from "lucide-react";
import { useWorkspace } from "../workspace-context";
import { queryNativeRPC } from "../queries";
import { ErrorNotice, IconButton } from "./ui";
import { Input } from "./ui/input";
import "./workspace-tree.css";

export default function WorkspaceTree({ threadId, active }: { threadId: string; active: boolean }) {
  const { client, panels } = useWorkspace();
  const draft = threadId.startsWith("draft:");
  const query = useQuery({
    queryKey: ["file-tree", threadId],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.files.tree({ threadId }, { signal })),
    enabled: active && !draft,
    retry: false,
  });
  const open = (path: string) => {
    if (!query.data) return;
    const root = query.data.root.replace(/\/$/, "");
    panels.getState().openFile(threadId, {
      type: "path",
      path: `${root}/${path}`,
      name: path.split("/").at(-1) ?? path,
    });
  };
  let status: string | undefined;
  if (draft) status = "Start a conversation to browse files";
  else if (query.data?.truncated) status = "Showing the first 10,000 files";
  return (
    <WorkspaceTreeView
      paths={query.data?.paths ?? emptyPaths}
      root={query.data?.root}
      onOpen={open}
      onRefresh={draft ? undefined : () => void query.refetch()}
      refreshing={query.isFetching}
      error={query.error?.message}
      status={status}
      loading={!draft && query.isPending && !query.error}
    />
  );
}

const emptyPaths: readonly string[] = [];

export function WorkspaceTreeView({
  paths,
  root,
  onOpen,
  onRefresh,
  refreshing = false,
  error,
  status,
  loading = false,
}: {
  paths: readonly string[];
  root?: string;
  onOpen: (path: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  error?: string;
  status?: string;
  loading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim() || null;
  const select = useEffectEvent((selected: readonly string[]) => {
    const path = selected[0];
    if (!path || !paths.includes(path)) return;
    onOpen(path);
    // Selection only reports changes, so clear it to let the same file open again.
    model.getItem(path)?.deselect();
  });
  const { model } = useFileTree({
    paths: [],
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    onSelectionChange: (selected) => select(selected),
  });
  // Resetting paths drops search results, and setSearch ignores an unchanged query.
  const reset = useEffectEvent((expanded?: readonly string[]) => {
    model.setSearch(null);
    model.resetPaths(paths, expanded ? { initialExpandedPaths: expanded } : undefined);
    model.setSearch(query);
  });
  useEffect(() => {
    reset();
  }, [model, paths]);
  useEffect(() => {
    model.setSearch(query);
  }, [model, query]);
  return (
    <div
      className="workspace-tree flex flex-col flex-1 min-w-0 min-h-0 bg-sidebar text-sidebar-foreground"
      data-ui="workspace-tree"
    >
      <div className="workspace-tree-toolbar flex items-center flex-none gap-1 px-2 py-1">
        <IconButton
          label="Refresh files"
          disabled={!onRefresh || refreshing}
          onClick={() => onRefresh?.()}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        </IconButton>
        <Input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          title={root}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="workspace-tree-search flex-1 h-[var(--ui-control-compact)] border-0 bg-transparent px-2 md:text-sm focus-visible:ring-0 focus-visible:bg-muted"
        />
        <IconButton label="Collapse folders" disabled={!paths.length} onClick={() => reset([])}>
          <ChevronsDownUp />
        </IconButton>
      </div>
      <ErrorNotice message={error} />
      {status ? <p className="px-3 py-1 text-xs text-muted-foreground">{status}</p> : null}
      {loading ? (
        <SkeletonRows label="Loading files" rows={8} />
      ) : (
        <FileTree model={model} className="workspace-tree flex-1 min-h-0" />
      )}
    </div>
  );
}
