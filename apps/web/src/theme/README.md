# Theme core

`builtin.ts` and imported VS Code theme data go through `resolveTheme`. It resolves a bounded set of
UI roles. `theme.ts` writes those roles as `--ui-*` properties on the document; `tailwind.css` exposes
them to components. `tokens.css` owns spacing, type, radius, control dimensions, shadows, and motion.

Use semantic utilities such as `bg-primary text-primary-foreground`, `bg-input-background
text-input-foreground`, and `bg-selection text-selection-foreground`. A supplied background must
travel with its foreground. Links use `text-link`, independently of button fill. Add a role only for a
distinct use with a source, fallback, and gallery example. `draft` aliases warning; shadcn names such
as destructive and ring are aliases too. The default Tailwind color palette is disabled.

## Registering a pair

The adapter accepts already resolved theme objects. For example, in application bootstrap:

```ts
import light from "./themes/example-light.json";
import dark from "./themes/example-dark.json";
import { resolveTheme } from "./resolve-theme";
import { installThemes } from "./theme";

installThemes({ light: resolveTheme(light, "light"), dark: resolveTheme(dark, "dark") });
```

Treat registered objects as immutable; replacing a theme requires resolving and installing a new
object.

## Built-in themes

`catalog.ts` lists the built-in light/dark pairs shown in Settings. Lilac resolves at startup; other
pairs are dynamic imports of Shiki's bundled VS Code themes, so they stay out of the shell bundle.
`selectTheme` sets one or both kinds and saves the choice in this browser under
`lilac-theme-palette-v1`. Startup awaits the saved pair before the first render and keeps Lilac if the
import fails. Light, Dark, or System remains a separate preference.

`resolve-theme.ts` is the mapping table. Supplied hex colors, including alpha and transparent hex,
win. Missing roles use a related color or the built-in palette for the effective kind. Derived tints,
borders, and shadows are centralized there. The adapter maps editor, sidebar, widget, menu, button,
input, list selection, link, focus, and status roles. It does not duplicate the VS Code workbench.

Lilac uses the Orchard syntax palette in `orchard.ts`, with separate light and dark colors. Its
shared scope map covers keys, strings, literals, keywords, functions, types, and template expressions.

Ordered TextMate `tokenColors` or resolved Shiki `settings` feed both chat highlighting and Monaco.
Monaco uses a separate Shiki instance with shared grammar imports so chat tokenization cannot change
the editor theme. Only code-rendering leaves subscribe to syntax changes; UI colors update through
CSS. The workspace tree uses the same sidebar and selection variables. Monaco and the YAML language
service load on demand. Core and MCP editors use the generated configuration schemas.

Resolve extension `include` files and path-valued `tokenColors` before registration. This module does
not parse JSONC files, fetch extensions, or apply language-server semantic tokens. It supports the
resolved data rather than a VS Code extension package. Catppuccin file icons remain independent and
follow the effective Light/Dark kind.

## Checks

The gallery uses production controls and shows semantic role pairs in Foundations. Check light and
dark, narrow layout, focus, selection, disabled, invalid, open menus, and long labels. Theme tests
exercise bundled GitHub Light/Dark syntax data, sparse palettes, transparency, and cache isolation.
The token guard checks raw UI colors and palette utilities outside theme data and the icon palette.
