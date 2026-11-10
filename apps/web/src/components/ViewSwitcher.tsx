import { memo, useState, type WheelEvent } from "react";
import { Archive, Globe, MessagesSquare, Workflow } from "lucide-react";
import { createWheelStepper } from "../wheel-stepper";
import { IconButton } from "./ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Views other than the default conversation list, which has no value in the URL. */
export type OtherView = "workflows" | "others" | "archived";

const views = [
  { id: "conversations", label: "Conversations", icon: MessagesSquare, ownerOnly: false },
  { id: "workflows", label: "Workflows", icon: Workflow, ownerOnly: false },
  { id: "others", label: "Other conversations", icon: Globe, ownerOnly: true },
  { id: "archived", label: "Archived", icon: Archive, ownerOnly: false },
] as const;

export const ViewSwitcher = memo(function ViewSwitcher({
  view,
  owner,
  onChange,
}: {
  view?: OtherView;
  owner: boolean;
  onChange: (view?: OtherView) => void;
}) {
  const currentId = view ?? "conversations";
  const current = views.find((item) => item.id === currentId) ?? views[0];
  const CurrentIcon = current.icon;
  const available = views.filter((item) => owner || !item.ownerOnly);
  const [wheelStep] = useState(createWheelStepper);
  // Stops at the ends so trackpad inertia cannot spin past the intended view.
  const onWheel = (event: WheelEvent) => {
    const step = wheelStep(event);
    const next = available[available.findIndex((item) => item.id === currentId) + step];
    if (step === 0 || !next) return;
    onChange(next.id === "conversations" ? undefined : next.id);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton
            label={`View: ${current.label}`}
            tooltip="Switch view"
            aria-pressed={view !== undefined}
            onWheel={onWheel}
          >
            <CurrentIcon />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuRadioGroup value={currentId}>
          {available.map(({ id, label, icon: Icon }) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              closeOnClick
              onClick={() => {
                if (id !== currentId) onChange(id === "conversations" ? undefined : id);
              }}
            >
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
