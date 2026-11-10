import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Controls a keyboard user can reach inside a list row. */
const ROW_CONTROLS =
  'a[href], button:not([disabled]), input:not([disabled]), [aria-roledescription="draggable"]';

export type RovingKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** The row a key moves to, skipping rows with nothing to focus, or undefined at either end. */
export function rovingTarget(
  from: number,
  key: RovingKey,
  count: number,
  focusable: (index: number) => boolean,
): number | undefined {
  const step = key === "ArrowDown" || key === "Home" ? 1 : -1;
  let start = from + step;
  if (key === "Home") start = 0;
  if (key === "End") start = count - 1;
  for (let index = start; index >= 0 && index < count; index += step)
    if (focusable(index)) return index;
  return undefined;
}

function rowControls(row: Element): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(ROW_CONTROLS)];
}

function rowIndex(row: Element | null): number | undefined {
  const value = row instanceof HTMLElement ? row.dataset.index : undefined;
  return value === undefined ? undefined : Number(value);
}

/**
 * Makes a virtual list one tab stop. Up and Down move between rows, Home and End jump to the ends,
 * and Left and Right reach the other controls in a row, such as its drag handle and actions.
 */
export function useRovingRows(
  list: RefObject<HTMLElement | null>,
  options: {
    enabled: boolean;
    count: number;
    /** Selects a row's main control; rows without one focus their first control. */
    primary?: string;
    /** Selects the control to start on before the list has had focus, such as the open item. */
    selected?: string;
    scrollToIndex: (index: number) => void;
  },
) {
  // The row last focused in this list; until then the selected row holds the tab stop.
  const current = useRef<number>(undefined);
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  const rows = () =>
    [...(list.current?.querySelectorAll<HTMLElement>("[data-index]") ?? [])].filter(
      (row) => row.closest("[data-roving-list]") === list.current,
    );
  const primaryOf = (row: Element) => {
    const selector = latest.current.primary;
    return (selector ? row.querySelector<HTMLElement>(selector) : null) ?? rowControls(row)[0];
  };
  const applyTabStops = () => {
    const rendered = rows();
    const selected = latest.current.selected;
    const focused = rendered.find((row) => rowIndex(row) === current.current && primaryOf(row));
    const opened =
      current.current === undefined && selected
        ? rendered.find((row) => row.querySelector(selected))
        : undefined;
    const stop = focused ?? opened ?? rendered.find((row) => primaryOf(row));
    const control = stop && primaryOf(stop);
    // Writing only changed values keeps the mutation observer below from looping.
    for (const row of rendered)
      for (const candidate of rowControls(row)) {
        const tabIndex = candidate === control ? 0 : -1;
        if (candidate.tabIndex !== tabIndex) candidate.tabIndex = tabIndex;
      }
  };

  useLayoutEffect(() => {
    if (options.enabled) applyTabStops();
  });

  useEffect(() => {
    const element = list.current;
    if (!element || !options.enabled) return;
    const focusRow = (index: number, attempts = 3) => {
      const row = rows().find((candidate) => rowIndex(candidate) === index);
      const control = row && primaryOf(row);
      if (row && control) {
        current.current = index;
        applyTabStops();
        control.focus();
        return;
      }
      if (!attempts) return;
      latest.current.scrollToIndex(index);
      requestAnimationFrame(() => focusRow(index, attempts - 1));
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest("input, textarea, [contenteditable]"))
        return;
      const row = target.closest<HTMLElement>("[data-index]");
      const index = rowIndex(row);
      if (!row || index === undefined || row.closest("[data-roving-list]") !== element) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const controls = rowControls(row);
        const next = controls[controls.indexOf(target) + (event.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        next.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const rendered = new Map(rows().map((candidate) => [rowIndex(candidate), candidate]));
      const next = rovingTarget(
        index,
        event.key as RovingKey,
        latest.current.count,
        (candidate) => {
          const found = rendered.get(candidate);
          // Rows outside the rendered window are assumed focusable; focusRow scrolls to them.
          return found ? !!primaryOf(found) : true;
        },
      );
      if (next === undefined) return;
      event.preventDefault();
      focusRow(next);
    };
    const focusin = (event: FocusEvent) => {
      const row = event.target instanceof Element ? event.target.closest("[data-index]") : null;
      const index = rowIndex(row);
      if (index === undefined || row?.closest("[data-roving-list]") !== element) return;
      current.current = index;
      applyTabStops();
    };
    element.addEventListener("keydown", keydown);
    element.addEventListener("focusin", focusin);
    // Rows rerender on their own, which can restore their controls' tab stops or move the selection.
    const observer = new MutationObserver(applyTabStops);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["tabindex", "aria-current"],
    });
    return () => {
      observer.disconnect();
      element.removeEventListener("keydown", keydown);
      element.removeEventListener("focusin", focusin);
    };
  }, [list, options.enabled]);
}
