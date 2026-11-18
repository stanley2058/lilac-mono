---
name: visualize
description: Create an inline visualization or interactive tool inside a native web reply. Load when a visual would explain more than prose, or before writing an `html-preview-file` fence. Standalone HTML documents and public websites use their publishing skill.
surfaces: [native]
---

# Visualize

Build a compact component for the conversation using this skill's layout and theme rules. Use a standalone-page skill, such as Quire, when the user asks for a separate document or published page. An inline preview does not need that skill's page shell, design system, or theme runtime. If the user explicitly requests both skills, adapt the requested content to the inline constraints below.

A fenced block whose language is `html-preview-file` and whose only content is a file path shows that HTML file inline in your reply:

````markdown
```html-preview-file
/data/outputs/visualize/weekly-runs-a7c2/index.html
```
````

Lilac saves a copy of that one file when your response ends, so the reader sees the page exactly as it was then. Lilac does not read the files the page references. Local scripts, stylesheets, and images must be inlined first; [Build a multi-file preview](#build-a-multi-file-preview) does that.

## Output location

Save previews at `<DATA_DIR>/outputs/visualize/<unique-name>/index.html`, with any source assets beside the HTML. Resolve the active Core `DATA_DIR` from its runtime environment; `/data` above is an example. Use the absolute path as seen by Core, which may differ from the host path when Core runs in a container. When your file tools are limited to `/tmp`, as in restricted mode, save under `/tmp/outputs/visualize/<unique-name>/index.html` and put that `/tmp` path in the fence.

Create a directory with a descriptive name and a unique suffix for each new visualization. Reuse that directory for revisions of the same visualization. Editing the source after a reply ends does not update its saved preview; reference the file in a new reply to capture the revision. Keep these sources together in this output directory unless the user explicitly chooses another destination.

## Steps

1. **Write one self-contained HTML file** in the [output location](#output-location), following [Inline constraints](#inline-constraints). When `bun` is unavailable, as in restricted bash, write that single file directly with your file tools. With Bun, a page can be split across local files and built into one with the [helper](#build-a-multi-file-preview). Done when the file exists at an absolute path readable by Core and references no local files.
2. **Check it in a browser.** Use agent-browser (or an available browser tool) to check the page at about 800px wide and at a narrow phone width. Exercise its controls, take a screenshot, and read the console. Prefer the actual Lilac preview; when unavailable, use a test iframe with `sandbox="allow-scripts allow-forms allow-popups"` and representative host theme variables. Verify light and dark themes, stable height, and no clipping or overflow. A standalone file check alone does not verify those host behaviors.
3. **Reference it** with the fence above, at the point in the reply where the page belongs. A reply saves at most 8 pages.
4. **Write the surrounding text** so it adds only what the page does not show: the conclusion, a caveat, the next step. The reader already sees the page.

## Build a multi-file preview

The [Bun helper](scripts/build.ts) is in the `scripts` directory beside this `SKILL.md`. It needs a shell with `bun`; restricted bash has none, so skip this section there. Run it with the source page and the output path:

```sh
bun <skill-dir>/scripts/build.ts <preview-dir>/page.html <preview-dir>/index.html
```

The helper replaces the URL in `<script src>`, `<link rel="stylesheet">`, and `<img src>` with a `data:` URL when it is a relative or absolute local path. Other attributes, such as `defer` and `media`, stay. Remote `https:` URLs, `data:` URLs, `file:` URLs, `srcset`, and HTML entities stay as written. It stops without writing when a referenced local file is missing. It does not rewrite `url()` inside CSS, so put CSS images and fonts in `data:` URLs. Preview the output file, not the source page.

## Inline constraints

- **Self-contained.** Put CSS in `<style>` and scripts in `<script>`. Remote `https://` URLs, such as a CDN chart library, load as they are. Local paths, `file://` URLs, and `resource://` URIs do not load in the saved page.
- **Part of the reply.** The iframe is transparent and as wide as the reply column, about 800px on desktop and narrower on phones. Use fluid widths and let the surrounding reply carry the title. Keep `html` and `body` transparent, with no decorative backgrounds on their `::before` or `::after` pseudo-elements. Put any needed background on the component that owns it, within its rounded edges.
- **Outer spacing.** Leave the host's body margin intact. It supplies a 1px inset to prevent borders clipping at fractional display scaling. Apply layout spacing within the component; avoid full-page resets that set `body { margin: 0 }` or add an outer page shell.
- **Stable height.** Let content set the page height and give charts a fixed pixel height on their container. Root or body `height`/`min-height` based on the viewport, such as `100vh` or `100%`, can feed back into frame sizing. Tall pages scroll within a capped frame, so keep the visualization compact.
- **Sandbox.** Scripts and forms run in an isolated, opaque-origin iframe. Keep interaction state in memory; `localStorage`, parent-page DOM access, and access to Lilac's authenticated APIs are unavailable. Standalone template scripts that expect these capabilities must be removed or adapted.
- **Links** to `http(s)` pages open in a new browser tab.

## Theme

Lilac sets these CSS variables on `:root` and updates them live when the user changes theme or light/dark mode:

`--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--success`, `--warning`, `--info`, `--border`, `--input`, `--ring`, `--link`, `--chart-1` to `--chart-5`, `--radius`, `--font-sans`, `--font-mono`.

The variables exist only inside Lilac, so give each use a fallback that matches a dark theme, which keeps the browser check in step 2 readable: `color: var(--muted-foreground, #a1a1aa)`.

Consume these variables with `var(...)`; leave their definitions, fonts, and light/dark selection to Lilac. Avoid redefining the supplied tokens on `:root`, setting a fixed `color-scheme`, or importing a competing theme switcher. Style text, surfaces, controls, borders, and charts with the matching host roles. Use a component-specific name for any derived variable, such as `--orbit-label: var(--muted-foreground, #a1a1aa)`.

Canvas chart libraries read colors once, from JavaScript. Read the variables with `getComputedStyle` and repaint when Lilac rewrites its theme `<style id="lilac-theme">`:

```js
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
function paint() {
  chart.data.datasets[0].backgroundColor = css("--chart-1", "#a78bfa");
  chart.options.scales.y.grid.color = css("--border", "#3f3f46");
  chart.update();
}
paint();
const theme = document.getElementById("lilac-theme");
if (theme) new MutationObserver(paint).observe(theme, { childList: true, characterData: true, subtree: true });
```
