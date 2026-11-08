const MAX_FRAMES = 180;
const STABLE_FRAMES = 5;
const CARD_GAP_PX = 8;

/**
 * Keeps a workflow card at the top of the viewport while the rows above it measure and hydrate.
 * Stops once the position holds, or at the viewer's first input.
 */
export function revealWorkflowCard({
  viewport,
  messageId,
  topInset,
  seek,
}: {
  viewport: HTMLElement;
  messageId: string;
  topInset: number;
  /** Brings the card's row into range while the card is not mounted yet. */
  seek: () => void;
}) {
  let frame = 0;
  let frames = 0;
  let stable = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener("wheel", stop);
    viewport.removeEventListener("pointerdown", stop);
    viewport.ownerDocument.removeEventListener("keydown", stop);
  };
  const step = () => {
    frames += 1;
    if (frames > MAX_FRAMES) return stop();
    const card = viewport.querySelector(`[data-workflow-card="${CSS.escape(messageId)}"]`);
    if (!card) {
      seek();
      frame = requestAnimationFrame(step);
      return;
    }
    const before = viewport.scrollTop;
    const offset =
      card.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      topInset -
      CARD_GAP_PX;
    if (Math.abs(offset) > 1) viewport.scrollTop = before + offset;
    // A card near the end of the thread cannot reach the top, which also counts as settled.
    stable = viewport.scrollTop === before ? stable + 1 : 0;
    if (stable >= STABLE_FRAMES) return stop();
    frame = requestAnimationFrame(step);
  };
  viewport.addEventListener("wheel", stop, { passive: true });
  // Pointer input covers touch and the scrollbar. Keys scroll without an event on the viewport.
  viewport.addEventListener("pointerdown", stop, { passive: true });
  viewport.ownerDocument.addEventListener("keydown", stop);
  frame = requestAnimationFrame(step);
  return stop;
}
