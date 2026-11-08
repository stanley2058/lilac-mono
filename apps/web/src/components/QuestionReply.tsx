import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  MessageCircleQuestion,
  PenLine,
  X,
} from "lucide-react";
import type { NativeQuestion } from "@stanley2058/lilac-client-protocol";
import { questionPrompts } from "../question-reply";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-spinner";
import { toast } from "./ui/toast";
import { isConnectionFailure } from "../connection-lifecycle";

/** Composer header: a way into a waiting question when the user is writing a regular message. */
export function QuestionWaiting({
  waiting,
  onReply,
}: {
  waiting: readonly NativeQuestion[];
  onReply: (messageId: string) => void;
}) {
  const first = waiting[0];
  if (!first) return null;
  return (
    <div
      data-ui="question-waiting"
      className="flex min-h-8 min-w-0 items-center gap-2 pb-2 pl-1 text-sm text-muted-foreground"
    >
      <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 truncate">
        {waiting.length > 1 ? `${waiting.length} questions waiting` : "Question waiting"}
      </span>
      <span className="flex-1" />
      <Button
        variant="ghost"
        className="-mr-1 h-7 px-2 text-primary"
        onClick={() => onReply(first.questionCallId)}
      >
        <CornerDownRight aria-hidden="true" />
        Answer
      </Button>
    </div>
  );
}

/**
 * Composer header for the question being answered: one prompt at a time with its options.
 * Choosing an option moves on; the message box below holds a typed answer instead.
 */
export function QuestionPanel({
  question,
  step,
  chosen,
  typed,
  answered,
  disabled,
  onChoose,
  onStep,
  onExit,
  onDismiss,
}: {
  question: NativeQuestion;
  step: number;
  /** The chosen option for the prompt on screen. */
  chosen?: number;
  /** The prompt on screen has a typed answer, which replaces any option. */
  typed: boolean;
  answered: readonly boolean[];
  disabled?: boolean;
  onChoose: (ordinal: number, index: number) => void;
  onStep: (step: number) => void;
  onExit: () => void;
  /** Resolves with an error message when the dismissal is not accepted. */
  onDismiss: () => Promise<string | undefined>;
}) {
  const prompts = questionPrompts(question);
  const prompt = prompts[step] ?? prompts[0]!;
  const [collapsed, setCollapsed] = useState<number>();
  const open = collapsed !== prompt.ordinal;
  const selected = typed ? undefined : chosen;
  const [dismissing, setDismissing] = useState(false);
  async function dismiss() {
    if (dismissing) return;
    setDismissing(true);
    const failure = await onDismiss();
    // On success the question closes and this panel unmounts, so it stays busy until then.
    if (!failure) return;
    setDismissing(false);
    if (isConnectionFailure(failure)) return;
    toast.add({ title: failure, type: "error" });
  }

  // Number keys choose an option unless the user is typing, matching the numbers shown.
  useEffect(() => {
    if (!open || disabled || dismissing) return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.closest("[contenteditable='true']")) return;
      const option = prompt.options.find((item) => String(item.index) === event.key);
      if (!option) return;
      event.preventDefault();
      onChoose(prompt.ordinal, option.index);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, disabled, dismissing, prompt, onChoose]);

  return (
    <div data-ui="question-panel" data-step={step} className="min-w-0 pb-2">
      <div className="flex min-h-8 min-w-0 items-center gap-1 pl-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setCollapsed(open ? prompt.ordinal : undefined)}
        >
          <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="shrink-0 font-medium text-foreground">{prompt.header}</span>
          {open ? null : (
            <span className="min-w-0 truncate text-muted-foreground">{prompt.question}</span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {prompts.length > 1 ? (
          <div className="flex shrink-0 items-center text-xs text-muted-foreground tabular-nums">
            <IconButton
              label="Previous question"
              className="size-7"
              disabled={step === 0}
              onClick={() => onStep(step - 1)}
            >
              <ChevronLeft />
            </IconButton>
            <span data-ui="question-step" aria-live="polite" className="min-w-7 text-center">
              {step + 1}/{prompts.length}
            </span>
            <IconButton
              label="Next question"
              className="size-7"
              disabled={step === prompts.length - 1 || !answered[step]}
              onClick={() => onStep(step + 1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        ) : null}
        <IconButton
          label="Write a message instead"
          tooltip="Write a message instead"
          className="size-7 shrink-0"
          onClick={onExit}
        >
          <PenLine />
        </IconButton>
        <IconButton
          label="Dismiss question"
          tooltip="Dismiss"
          className="size-7 shrink-0"
          disabled={dismissing}
          onClick={() => void dismiss()}
        >
          {dismissing ? <LoadingSpinner size={14} /> : <X />}
        </IconButton>
      </div>
      {open ? (
        <div className="max-h-[40dvh] overflow-y-auto px-1 pt-1 pb-1">
          <p className="m-0 text-sm text-foreground whitespace-pre-wrap wrap-anywhere">
            {prompt.question}
          </p>
          <ol
            key={prompt.ordinal}
            className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0"
            aria-label={prompt.header}
          >
            {prompt.options.map((option) => {
              const active = selected === option.index;
              return (
                <li key={option.index} className="min-w-0">
                  <button
                    type="button"
                    data-ui="question-option"
                    aria-pressed={active}
                    aria-keyshortcuts={String(option.index)}
                    disabled={disabled || dismissing}
                    className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:opacity-50 ${active ? "bg-surface-hover text-foreground" : "hover:bg-surface-hover/60"}`}
                    onClick={() => onChoose(prompt.ordinal, option.index)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground wrap-anywhere">
                        {option.label}
                      </span>
                      {option.description !== option.label ? (
                        <span className="text-xs text-muted-foreground text-pretty">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {active ? (
                      <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                    ) : (
                      <kbd
                        aria-hidden="true"
                        className="grid size-5 shrink-0 place-items-center text-xs font-medium text-muted-foreground tabular-nums"
                      >
                        {option.index}
                      </kbd>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
