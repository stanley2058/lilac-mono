import * as React from "react";
import { cn } from "cn";
import { Input } from "./input";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="input-group"
      className={cn(
        "flex h-8 w-full min-w-0 items-center rounded-lg border border-input bg-input-background text-input-foreground transition-colors has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot=input-group-control][aria-invalid=true]]:border-destructive has-[[data-slot=input-group-control][aria-invalid=true]]:ring-3 has-[[data-slot=input-group-control][aria-invalid=true]]:ring-destructive/20 has-[[data-slot=input-group-control]:disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-full flex-1 rounded-none border-0 bg-transparent focus-visible:ring-0 aria-invalid:ring-0 disabled:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupAddon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="input-group-addon"
      className={cn(
        "flex h-full cursor-text items-center pr-2.5 text-sm whitespace-nowrap text-muted-foreground select-none",
        className,
      )}
      onClick={(event) => {
        event.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput };
