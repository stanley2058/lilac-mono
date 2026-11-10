import { swatches, spacings, Section, Specimen } from "./shared";

export function Foundations() {
  return (
    <Section id="foundations" title="Foundations">
      <div className="ds-swatches grid [grid-template-columns:repeat(3,_minmax(0,_1fr))] gap-3">
        {swatches.map(([label, background, foreground]) => (
          <div key={label} className="flex flex-col gap-2 text-xs min-w-0">
            <span
              className="flex items-center h-12 rounded-md px-3 border border-border"
              style={{ background: `var(--ui-${background})`, color: `var(--ui-${foreground})` }}
            >
              {label}
            </span>
            <code className="wrap-anywhere">
              {background} / {foreground}
            </code>
          </div>
        ))}
      </div>
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="Type">
          <div className="ds-type flex flex-col gap-3">
            <span className="ds-type-2xl text-2xl">A little room to think</span>
            <span className="ds-type-lg text-lg">Conversation title</span>
            <span>Body text and message content</span>
            <span className="ds-type-sm text-sm text-muted-foreground">Supporting details</span>
            <span className="ds-type-xs text-xs text-muted-foreground">
              Metadata and timestamps
            </span>
          </div>
        </Specimen>
        <Specimen title="Spacing & corners">
          <div className="ds-spacing flex flex-wrap items-start gap-3">
            {spacings.map((space) => (
              <div key={space}>
                <code>{space}</code>
                <span
                  className="block h-4 bg-primary rounded-sm"
                  style={{ width: `calc(var(--ui-space-unit) * ${space})` }}
                />
              </div>
            ))}
          </div>
          <div className="ds-row flex items-center flex-wrap gap-2">
            <span className="ds-radius p-3 bg-surface-raised text-xs ds-radius-sm rounded-sm">
              sm
            </span>
            <span className="ds-radius p-3 bg-surface-raised text-xs ds-radius-md rounded-md">
              md
            </span>
            <span className="ds-radius p-3 bg-surface-raised text-xs ds-radius-lg rounded-lg">
              lg
            </span>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
