import { shortcutOverlayOpen } from "./shortcuts";

const interactiveSelector = [
  "input",
  "textarea",
  "select",
  "[contenteditable]",
  "button",
  "a[href]",
  "summary",
  '[role="textbox"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
].join(",");

export function shouldFocusComposer(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.key.length !== 1
  )
    return false;
  if (
    event
      .composedPath()
      .some((target) => target instanceof Element && target.closest(interactiveSelector))
  )
    return false;
  if (shortcutOverlayOpen()) return false;
  if (
    document.querySelector(
      '[role="listbox"], [data-slot="popover-content"]:is([data-open], [data-ending-style])',
    )
  )
    return false;
  return true;
}
