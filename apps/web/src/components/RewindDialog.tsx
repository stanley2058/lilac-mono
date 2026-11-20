import { RotateCcw } from "lucide-react";
import { type RewindReason, rewindReasonText } from "../rewind-policy";
import { Modal } from "./ui";
import { Button } from "./ui/button";

export function RewindDialog({
  open,
  reason,
  active,
  rewinding,
  onClose,
  onRewind,
  focusTarget,
}: {
  open: boolean;
  reason?: RewindReason;
  active?: boolean;
  rewinding?: boolean;
  onClose: () => void;
  onRewind: () => void;
  focusTarget?: () => HTMLElement | null;
}) {
  const expired = reason === "expired";
  return (
    <Modal
      open={open}
      title={expired ? "Can't rewind" : "Rewind to this turn?"}
      onClose={onClose}
      finalFocus={focusTarget}
    >
      {expired ? (
        <p>
          The rewind window for this turn has expired. Send a follow-up message to correct course
          instead.
        </p>
      ) : (
        <>
          <p>
            Later messages will be removed, and this message returns to your composer. File changes
            won't be reverted.
          </p>
          {reason || active ? (
            <p>
              {reason ? rewindReasonText(reason) : "Wait for the agent to finish before rewinding."}
            </p>
          ) : null}
        </>
      )}
      <div className="dialog-actions flex justify-end gap-2 mt-6">
        <Button variant="secondary" className="gap-2 rounded-sm px-4" onClick={onClose}>
          {expired ? "Got it" : "Cancel"}
        </Button>
        {!expired ? (
          <Button
            variant="destructive"
            className="gap-2 rounded-sm px-4"
            disabled={rewinding || active || !!reason}
            onClick={onRewind}
          >
            <RotateCcw />
            Rewind
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}
