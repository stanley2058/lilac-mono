import { useState } from "react";
import { cn } from "cn";
import { Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { CodeEditor } from "../CodeEditor";

/**
 * A clamped preview of a long value that opens it in a code editor dialog. `onSave` returns a
 * message when the text cannot be saved, which keeps the dialog open.
 */
export function TextEditorField({
  id,
  label,
  value,
  language,
  placeholder = "Not set",
  disabled,
  onSave,
}: {
  id?: string;
  label: string;
  value: string;
  language: "markdown" | "yaml";
  placeholder?: string;
  disabled: boolean;
  onSave: (text: string) => string | undefined;
}) {
  const [draft, setDraft] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const open = draft !== undefined;
  const mono = language === "yaml";
  function close() {
    setDraft(undefined);
    setProblem(undefined);
  }
  function save() {
    if (draft === undefined) return;
    if (draft === value) return close();
    const message = onSave(draft);
    if (message) return setProblem(message);
    close();
  }
  return (
    <>
      <button
        id={id}
        type="button"
        aria-label={`Edit ${label}`}
        disabled={disabled}
        className="group/preview relative w-full min-w-0 rounded-lg border border-input bg-input-background px-2.5 py-2 text-left text-sm text-input-foreground outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => setDraft(value)}
      >
        <span
          className={cn(
            "block line-clamp-4 pr-6 break-words whitespace-pre-wrap",
            mono && "font-mono text-xs leading-5",
            !value && "text-input-placeholder",
          )}
        >
          {value || placeholder}
        </span>
        <Pencil
          aria-hidden
          className="absolute top-2 right-2 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/preview:opacity-100 group-focus-visible/preview:opacity-100"
        />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent className="flex h-[min(40rem,_calc(100dvh_-_4rem))] w-[min(56rem,_calc(100vw_-_2rem))] max-w-none flex-col gap-4 sm:max-w-none">
          <DialogTitle>{label}</DialogTitle>
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border">
            {open ? (
              <CodeEditor
                language={language}
                label={label}
                value={value}
                onChange={(text) => {
                  setDraft(text);
                  setProblem(undefined);
                }}
                onSave={save}
              />
            ) : null}
          </div>
          <DialogFooter className="items-center">
            {problem ? <p className="mr-auto text-xs text-danger">{problem}</p> : null}
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
