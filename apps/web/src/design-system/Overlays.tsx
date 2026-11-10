import {
  CopySessionIdMenuItem,
  CopySessionIdContextMenuItem,
} from "../components/CopySessionIdMenuItem";
import { CopyReferenceButton } from "../components/ConversationReference";
import { useState } from "react";
import { Archive, Bell, ChevronDown, Copy, Pencil, Trash2 } from "lucide-react";
import { toast } from "../components/ui/toast";
import { showAppUpdateToast } from "../app-update-toast";
import { closeConnectionNotice, showConnectionNotice } from "../use-connection-notice";
import { IconButton, Modal } from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Section, Specimen } from "./shared";

export function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [action, setAction] = useState("");
  return (
    <Section id="overlays" title="Overlays">
      <div className="ds-row flex items-center flex-wrap gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" />}>
            Thread actions
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-44">
            <DropdownMenuItem onClick={() => setAction("Rename selected")}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAction("Archive selected")}>
              <Archive />
              Archive
            </DropdownMenuItem>
            <CopySessionIdMenuItem threadId="demo-thread" />
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setAction("Delete selected")}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" />}>
            DM actions
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-44">
            <CopySessionIdMenuItem threadId="demo-dm" />
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" />}>Popover</PopoverTrigger>
          <PopoverContent>
            <strong>Shared with 2 people</strong>
            <p className="ds-muted">Alex Chen and Morgan Lee can edit this conversation.</p>
          </PopoverContent>
        </Popover>
        <Button variant="secondary" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <IconButton label="Notifications">
          <Bell />
        </IconButton>
        <IconButton label="Copy message">
          <Copy />
        </IconButton>
        <CopyReferenceButton
          target={{ surface: "native", sessionId: "demo", messageId: "message" }}
        />
      </div>
      <ContextMenu>
        <ContextMenuTrigger
          className="ds-context-target flex items-center justify-center min-h-[calc(calc(var(--ui-space-unit)*12)_*_3)] bg-surface text-muted-foreground text-sm rounded-lg mt-4"
          tabIndex={0}
        >
          Right-click for thread actions
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setAction("Rename selected")}>
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setAction("Archive selected")}>
            <Archive />
            Archive
          </ContextMenuItem>
          <CopySessionIdContextMenuItem threadId="demo-thread" />
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setAction("Delete selected")}>
            <Trash2 />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <p className="ds-feedback min-h-6 text-sm text-muted-foreground" role="status">
        {action}
      </p>
      <Specimen title="Toasts">
        <div className="ds-row flex items-center flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              showAppUpdateToast(() => setAction("Reload selected in preview"), "app-update-demo")
            }
          >
            Update
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              showConnectionNotice(
                {
                  reason: "Reconnecting…",
                  retry: () =>
                    new Promise((resolve) => setTimeout(resolve, 1_500)).then(() =>
                      closeConnectionNotice("connection-demo"),
                    ),
                },
                "connection-demo",
              )
            }
          >
            Reconnecting
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              showConnectionNotice(
                {
                  reason: "Could not connect to Lilac. Your drafts are saved on this device.",
                  retry: () => new Promise((resolve) => setTimeout(resolve, 1_500)),
                },
                "connection-demo",
              )
            }
          >
            Retry fails
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              showConnectionNotice({ reason: "This device is offline." }, "connection-demo")
            }
          >
            Device offline
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.add({ title: "Changes saved", type: "success" })}
          >
            Success
          </Button>
        </div>
      </Specimen>
      <Modal open={dialog} title="Rename conversation" onClose={() => setDialog(false)}>
        <label className="ds-field flex flex-col gap-2 text-sm">
          Title
          <Input defaultValue="A quiet weekend" />
        </label>
        <div className="dialog-actions flex justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={() => setDialog(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setDialog(false);
              setAction("Preview title saved");
            }}
          >
            Save
          </Button>
        </div>
      </Modal>
    </Section>
  );
}
