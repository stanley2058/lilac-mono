import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { WorkflowCardLocation } from "../message-target-store";
import { openThreadAtWorkflowCard } from "../message-target-store";
import { workflowRunOptions } from "../queries";
import { useOptionalWorkspace } from "../workspace-context";
import { ErrorNotice, Modal } from "./ui";
import { Skeleton } from "./ui/skeleton";
import { WorkflowRunCard } from "./WorkflowBoard";

export default function WorkflowRunDialog({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const workspace = useOptionalWorkspace();
  const navigate = useNavigate();
  const query = useQuery({
    ...workflowRunOptions(workspace?.client, runId, false),
    enabled: !!workspace?.client.rpc,
    retry: false,
  });
  const openThread = (threadId: string, source?: WorkflowCardLocation) => {
    onClose();
    if (source) openThreadAtWorkflowCard(threadId, source);
    void navigate({ to: "/threads/$threadId", params: { threadId }, search: {} });
  };
  return (
    <Modal open wide title="Workflow" onClose={onClose}>
      <ErrorNotice message={query.error?.message} />
      {query.data ? (
        <WorkflowRunCard run={query.data} onOpenThread={openThread} body="full" />
      ) : null}
      {!query.data && !query.error ? <Skeleton className="h-40 w-full rounded-xl" /> : null}
    </Modal>
  );
}
