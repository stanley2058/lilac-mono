import { cn } from "cn";

/** A four-petal lilac floret: the brand's dot, drawn as a flower. */
export function LilacMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("lilac-mark", className)}>
      <circle className="lilac-mark-petal" cx="8" cy="4.6" r="3.4" />
      <circle className="lilac-mark-petal-alt" cx="11.4" cy="8" r="3.4" />
      <circle className="lilac-mark-petal" cx="8" cy="11.4" r="3.4" />
      <circle className="lilac-mark-petal-alt" cx="4.6" cy="8" r="3.4" />
      <circle className="lilac-mark-center" cx="8" cy="8" r="1.5" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "brand inline-flex items-baseline gap-1 text-2xl [letter-spacing:-0.07em] font-[650]",
        className,
      )}
    >
      lilac
      <LilacMark />
    </span>
  );
}
