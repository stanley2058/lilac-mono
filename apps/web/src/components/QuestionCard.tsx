import { useContext, useState } from "react";
import {
  Ban,
  ChevronDown,
  CircleCheck,
  CornerDownRight,
  CornerRightDown,
  MessageCircleQuestion,
  TimerOff,
  Unplug,
} from "lucide-react";
import type { NativeQuestion } from "@stanley2058/lilac-client-protocol";
import { questionPrompts, questionTitle, type QuestionPrompt } from "../question-reply";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { MessageIdentityContext } from "./message-identity";
import { QuestionReplyContext, useMessageServices } from "./message-services";

type SettledView = Exclude<NativeQuestion["view"], { state: "pending" }>;

const endings = {
  answered: { label: "Answered", icon: CircleCheck, tone: "text-success" },
  cancelled: { label: "Dismissed", icon: Ban, tone: "text-muted-foreground" },
  expired: { label: "Expired", icon: TimerOff, tone: "text-muted-foreground" },
  interrupted: {
    label: "Interrupted",
    icon: Unplug,
    tone: "text-muted-foreground",
  },
} as const;

const cardStyles =
  "flex w-full min-w-0 flex-col gap-3 rounded-xl bg-muted px-4 py-3 ring-1 ring-[color-mix(in_srgb,var(--ui-primary)_28%,transparent)]";
// Settled calls recede to an outlined row so the open question stands out.
const settledStyles = "flex w-full min-w-0 flex-col rounded-xl px-4 py-2 ring-1 ring-border";

export function QuestionCard({ question }: { question: NativeQuestion }) {
  const { canEdit, questions } = useMessageServices();
  const { viewerId } = useContext(MessageIdentityContext);
  const view = question.view;
  if (view.state !== "pending") return <SettledQuestion question={question} view={view} />;
  if (canEdit && !!questions && viewerId === question.respondentId)
    return <PendingQuestion question={question} />;
  const prompts = questionPrompts(question);
  return (
    <section data-ui="question-card" data-state="pending" data-readonly="" className={cardStyles}>
      <CardHeader title={questionTitle(prompts)} />
      <QuestionPrompts prompts={prompts} />
      <p className="m-0 text-sm text-muted-foreground">Waiting for an answer</p>
    </section>
  );
}

function CardHeader({ title }: { title?: string }) {
  return (
    <header className="flex min-h-7 min-w-0 items-center gap-2">
      <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <h3 className="m-0 min-w-0 flex-1 text-sm font-semibold text-foreground wrap-anywhere">
        {title}
      </h3>
    </header>
  );
}

/** The respondent's card stays one line; the composer shows the prompts and takes the answer. */
function PendingQuestion({ question }: { question: NativeQuestion }) {
  const { questions } = useMessageServices();
  const reply = useContext(QuestionReplyContext);
  const messageId = question.questionCallId;
  const replying = reply.messageId === messageId;
  const title = questionTitle(questionPrompts(question));
  return (
    <section
      data-ui="question-card"
      data-state="pending"
      data-replying={replying ? "" : undefined}
      className={`${cardStyles} gap-2 text-sm`}
    >
      <p className="m-0 flex min-h-7 min-w-0 items-center gap-2">
        <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">
            {replying ? "Answering below" : "Needs your answer"}
          </span>
          {title ? <span className="font-medium text-foreground"> · {title}</span> : null}
        </span>
        {replying ? (
          <CornerRightDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Button
            variant="ghost"
            className="-my-1 -mr-2 h-7 px-2 text-primary"
            onClick={() => questions?.onReply(messageId)}
          >
            <CornerDownRight aria-hidden="true" />
            Answer
          </Button>
        )}
      </p>
    </section>
  );
}

/** The call's prompts and options, read-only. Several prompts get numbered subheadings. */
export function QuestionPrompts({
  prompts,
  compact,
}: {
  prompts: readonly QuestionPrompt[];
  compact?: boolean;
}) {
  const many = prompts.length > 1;
  return (
    <div className={`flex min-w-0 flex-col ${compact ? "gap-4" : "gap-5"}`}>
      {prompts.map((prompt) => (
        <div key={prompt.ordinal} className="flex min-w-0 flex-col gap-2">
          {many ? (
            <h4 className="m-0 text-sm font-semibold text-muted-foreground wrap-anywhere">
              {prompt.ordinal}. {prompt.header}
            </h4>
          ) : null}
          <p
            className={`m-0 text-foreground whitespace-pre-wrap wrap-anywhere ${compact ? "text-sm" : "text-base"}`}
          >
            {prompt.question}
          </p>
          <ol className="m-0 flex list-none flex-col gap-1.5 border-l-2 border-border p-0 pl-3">
            {prompt.options.map((option) => (
              <li key={option.index} className="flex w-full min-w-0 items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className="w-4 shrink-0 text-sm text-muted-foreground tabular-nums"
                >
                  {option.index}.
                </span>
                <span className="flex min-w-0 flex-wrap gap-x-2">
                  <span className="text-sm font-medium text-foreground wrap-anywhere">
                    {option.label}
                  </span>
                  <span className="text-sm text-muted-foreground text-pretty">
                    {option.description}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

/** A finished call: its outcome in one line, with the original prompts a click away. */
function SettledQuestion({ question, view }: { question: NativeQuestion; view: SettledView }) {
  const [open, setOpen] = useState(false);
  const prompts = questionPrompts(question);
  const title = questionTitle(prompts);
  const { label, icon: Icon, tone } = endings[view.state];
  const answers =
    view.state === "answered"
      ? view.summary.answers.flatMap((item) =>
          item.answer.kind === "option" ? [{ header: item.header, label: item.answer.label }] : [],
        )
      : [];
  const status = (
    <>
      <Icon aria-hidden="true" className={`size-4 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">
          {title ? label : `Question ${label.toLowerCase()}`}
        </span>
        {title ? <span className="font-medium text-foreground"> · {title}</span> : null}
      </span>
    </>
  );
  const summary = answers.length ? (
    <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
      {answers.map((item, index) => (
        <div key={index} className="contents">
          <dt className="truncate text-muted-foreground">{item.header}</dt>
          <dd className="m-0 min-w-0 text-foreground wrap-anywhere">{item.label}</dd>
        </div>
      ))}
    </dl>
  ) : null;
  const shape = `${settledStyles} gap-2 text-sm`;
  if (!prompts.length)
    return (
      <section data-ui="question-card" data-state={view.state} className={shape}>
        <p className="m-0 flex min-h-7 min-w-0 items-center gap-2">{status}</p>
        {summary}
      </section>
    );
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section data-ui="question-card" data-state={view.state} className={shape} />}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="-mx-1 flex min-h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left focus-visible:outline-2 focus-visible:outline-focus"
          />
        }
      >
        {status}
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      {summary}
      <CollapsibleContent className="pt-1 pb-1">
        <QuestionPrompts compact prompts={prompts} />
      </CollapsibleContent>
    </Collapsible>
  );
}
