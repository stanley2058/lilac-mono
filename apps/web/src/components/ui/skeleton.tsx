import type { ComponentProps } from "react";
import { cn } from "cn";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("motion-safe:animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

function range(count: number): number[] {
  return [...Array(count).keys()];
}

// Fixed widths keep placeholders stable between renders and across server and client.
const widths = ["w-11/12", "w-4/5", "w-2/3", "w-5/6", "w-1/2", "w-3/4", "w-3/5", "w-10/12"];

/** Paragraph-shaped placeholder for text that is still loading. */
export function SkeletonLines({
  label,
  lines = 3,
  className,
}: {
  label: string;
  lines?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-2", className)}>
      {range(lines).map((index) => (
        <Skeleton
          key={index}
          className={cn("h-3", index === lines - 1 ? "w-2/5" : widths[index % widths.length])}
        />
      ))}
    </div>
  );
}

/** List-shaped placeholder: one leading mark and a label per row. */
export function SkeletonRows({
  label,
  rows = 5,
  avatar = false,
  className,
}: {
  label: string;
  rows?: number;
  avatar?: boolean;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-1 p-2", className)}>
      {range(rows).map((index) => (
        <div key={index} className="flex h-8 items-center gap-2.5 px-1">
          <Skeleton className={cn("shrink-0", avatar ? "size-6 rounded-full" : "size-4")} />
          <Skeleton className={cn("h-3", widths[(index + 2) % widths.length])} />
        </div>
      ))}
    </div>
  );
}

/** Code-shaped placeholder with a line-number gutter, for files that are still loading. */
export function SkeletonCode({
  label,
  lines = 14,
  className,
}: {
  label: string;
  lines?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-2.5 p-3", className)}>
      {range(lines).map((index) => (
        <div key={index} className="flex items-center gap-4">
          <Skeleton className="h-3 w-5 shrink-0 opacity-60" />
          <Skeleton
            className={cn("h-3", index % 5 === 4 ? "w-0" : widths[(index * 3) % widths.length])}
          />
        </div>
      ))}
    </div>
  );
}

/** Conversation-shaped placeholder: a sent message, then a reply beside its avatar. */
export function SkeletonConversation({
  label,
  exchanges = 2,
  className,
}: {
  label: string;
  exchanges?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-6", className)}>
      {range(exchanges).map((index) => (
        <div key={index} className="flex flex-col gap-6">
          <Skeleton className={cn("h-10 self-end rounded-2xl", index % 2 ? "w-1/3" : "w-2/5")} />
          <div className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className={cn("h-3", index % 2 ? "w-1/3" : "w-1/2")} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
