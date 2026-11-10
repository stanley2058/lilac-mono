import type { ComputerGeometry } from "../computer-viewer";
import { ComputerViewer } from "../components/ComputerViewer";
import computerDemoUrl from "../assets/computer-demo.html?url";
import { useRef, useState } from "react";
import { FileText } from "lucide-react";
import { VirtualList } from "../components/ui";
import { Button } from "../components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { Wordmark } from "../components/LilacMark";
import { Section } from "./shared";

export const listItems = [...Array.from({ length: 100 }).keys()].map((index) => ({
  id: String(index),
  label: `Conversation ${index + 1}`,
}));
export function Layout() {
  return (
    <Section
      id="layout"
      title="Layout"
      description="Drag the divider. The list renders only visible rows."
    >
      <div className="ds-resizable h-[calc(calc(var(--ui-space-unit)*12)_*_6)] bg-surface rounded-lg overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="35%" minSize="25%">
            <div className="ds-panel flex flex-col h-full gap-3 p-4 text-sm min-w-0">
              <strong>Conversations</strong>
              <VirtualList
                items={listItems}
                label="Example conversations"
                itemKey={(item) => item.id}
                render={(item) => (
                  <Button
                    variant="ghost"
                    className="ds-list-row flex items-center gap-2 py-3 px-0 whitespace-nowrap"
                  >
                    <FileText />
                    {item.label}
                  </Button>
                )}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel minSize="30%">
            <div className="ds-panel flex flex-col h-full gap-3 p-4 text-sm min-w-0 ds-panel-center items-center justify-center text-center">
              <Wordmark />
              <span className="ds-muted">Your next conversation starts here.</span>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Section>
  );
}
export function ComputerDemo() {
  const geometry = useRef<ComputerGeometry | undefined>(undefined);
  const [open, setOpen] = useState(false);
  return (
    <Section id="computer" title="Computer viewer">
      <Button onClick={() => setOpen((value) => !value)}>
        {open ? "Close demo" : "Open demo"}
      </Button>
      {open ? (
        <ComputerViewer
          savedGeometry={geometry.current}
          onGeometryChange={(value) => {
            geometry.current = value;
          }}
          desktop={{
            generation: "demo",
            url: new URL(computerDemoUrl, location.origin).href,
            password: "demo",
            expiresAt: "2099-01-01T00:00:00Z",
          }}
        />
      ) : null}
    </Section>
  );
}
