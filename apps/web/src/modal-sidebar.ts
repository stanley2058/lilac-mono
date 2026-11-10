import { useEffect, type RefObject } from "react";

/**
 * While the sidebar overlays the conversation, everything behind it is inert, Escape closes it, and
 * focus returns to where it was when it opened.
 */
export function useModalSidebar(
  shell: RefObject<HTMLElement | null>,
  modal: boolean,
  close: () => void,
) {
  useEffect(() => {
    const root = shell.current;
    if (!modal || !root) return;
    const sidebar = root.querySelector<HTMLElement>("#sidebar");
    const toggle = root.querySelector<HTMLElement>(".sidebar-toggle");
    if (!sidebar || !toggle) return;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const covered = modalBackground(root, sidebar, toggle);
    for (const element of covered) element.inert = true;
    if (!sidebar.contains(document.activeElement) && !toggle.contains(document.activeElement))
      // A tap opened the sidebar, so focus moves without the ring and tooltip a key press shows.
      toggle.querySelector<HTMLElement>("button")?.focus({ focusVisible: false });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      for (const element of covered) element.inert = false;
      const focus = document.activeElement;
      const leftBehind =
        !focus || focus === document.body || sidebar.contains(focus) || toggle.contains(focus);
      if (leftBehind && restore?.isConnected && !restore.inert) restore.focus();
    };
  }, [shell, modal, close]);
}

/** Siblings of the sidebar and its toggle, up to the shell, except the click-away overlay. */
function modalBackground(root: HTMLElement, sidebar: HTMLElement, toggle: HTMLElement) {
  const covered: HTMLElement[] = [];
  const keep = (element: Element) =>
    element === toggle ||
    element.contains(sidebar) ||
    (element instanceof HTMLElement && element.dataset.sidebarScrim !== undefined);
  let parent: HTMLElement | null = sidebar;
  while (parent && parent !== root) {
    const container: HTMLElement | null = parent.parentElement;
    if (!container) break;
    for (const child of container.children)
      if (!keep(child) && child instanceof HTMLElement && !child.inert) covered.push(child);
    parent = container;
  }
  // The floating conversation menu is portaled outside the shell.
  const menu = document.querySelector<HTMLElement>("[data-floating-chat-menu]");
  if (menu && !menu.inert) covered.push(menu);
  return covered;
}
