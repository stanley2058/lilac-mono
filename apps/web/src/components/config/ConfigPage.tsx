import { memo, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { formatConfigPath } from "@stanley2058/lilac-utils/config-document";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { isCollection, type Page, type Section } from "../../config-ui/manifest";
import { useConfigDrafts } from "../../config-ui/draft-store";
import { ConfigFieldRow, useConditionMet } from "./ConfigFieldRow";
import { ConfigCollection, type ItemStatus } from "./ConfigCollection";
import { ConfigText } from "./ConfigText";
import { useConfigScope } from "./use-config-field";

function sectionPaths(section: Section<string>): string[] {
  return section.entries.map((entry) => (isCollection(entry) ? entry.collection : entry.path));
}

const ConfigSection = memo(function ConfigSection({
  section,
  yamlPage,
  status,
  hideTitle,
}: {
  section: Section<string>;
  yamlPage: string;
  status?: ItemStatus;
  /** The page tab already names this section. */
  hideTitle?: boolean;
}) {
  const { kind } = useConfigScope();
  const visible = useConditionMet(section.visibleWhen);
  // Field editors remount after Discard or a replaced file, dropping rejected local text.
  const resets = useConfigDrafts((state) => state.drafts[kind]?.resets ?? 0);
  const focus = useConfigDrafts((state) => state.focus[kind]);
  const [open, setOpen] = useState(false);
  const focused =
    focus !== undefined &&
    sectionPaths(section).some((path) => formatConfigPath(focus.path).startsWith(path));
  if (!visible) return null;
  const body = (
    <div className="grid">
      {section.entries.map((entry) =>
        isCollection(entry) ? (
          <ConfigCollection
            key={entry.collection}
            entry={entry}
            yamlPage={yamlPage}
            status={status}
          />
        ) : (
          <ConfigFieldRow key={`${entry.path}:${resets}`} entry={entry} yamlPage={yamlPage} />
        ),
      )}
    </div>
  );
  if (!section.advanced)
    return (
      <section className="grid gap-1">
        {hideTitle ? null : <h3 className="text-sm font-semibold">{section.title}</h3>}
        {section.help ? (
          <p className="text-sm text-muted-foreground">
            <ConfigText text={section.help} />
          </p>
        ) : null}
        {body}
      </section>
    );
  return (
    <Collapsible open={open || focused} onOpenChange={setOpen} render={<section />}>
      <CollapsibleTrigger className="flex items-center gap-1 rounded-md text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            (open || focused) && "rotate-90",
          )}
        />
        {section.title}
        <span className="font-normal text-muted-foreground">Advanced</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        {section.help ? (
          <p className="text-sm text-muted-foreground">
            <ConfigText text={section.help} />
          </p>
        ) : null}
        {body}
      </CollapsibleContent>
    </Collapsible>
  );
});

/** Renders one manifest page and scrolls to a field that search or a link revealed. */
export function ConfigPage({
  page,
  yamlPage,
  status,
}: {
  page: Page<string>;
  yamlPage: string;
  status?: ItemStatus;
}) {
  const { kind } = useConfigScope();
  const container = useRef<HTMLDivElement>(null);
  const focus = useConfigDrafts((state) => state.focus[kind]);
  useEffect(() => {
    if (!focus) return;
    // Wait for collapsed sections and items that the focus opened to render.
    const frame = requestAnimationFrame(() => {
      const target = formatConfigPath(focus.path);
      const rows = container.current?.querySelectorAll<HTMLElement>("[data-config-path]") ?? [];
      let match: HTMLElement | undefined;
      for (const row of rows) {
        const path = row.dataset.configPath ?? "";
        if (target === path || target.startsWith(`${path}.`) || target.startsWith(`${path}[`))
          if (!match || path.length > (match.dataset.configPath ?? "").length) match = row;
      }
      if (!match) return;
      // Scroll only the page panel; scrollIntoView would also move the Settings dialog.
      const panel = container.current?.closest<HTMLElement>("[role=tabpanel]");
      if (panel) {
        const offset = match.getBoundingClientRect().top - panel.getBoundingClientRect().top;
        panel.scrollTop += offset - panel.clientHeight / 2 + match.clientHeight / 2;
      }
      match.dataset.flash = "";
      match.addEventListener("animationend", () => delete match.dataset.flash, { once: true });
      match.querySelector<HTMLElement>("input, textarea, button[role=switch], button")?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  return (
    <div ref={container} className="grid gap-8 pb-6">
      {page.sections.map((section) => (
        <ConfigSection
          key={section.title}
          section={section}
          yamlPage={yamlPage}
          status={status}
          hideTitle={page.sections.length === 1 && section.title === page.title}
        />
      ))}
    </div>
  );
}
