// Inlines a page's local scripts, stylesheets, and images as data URLs so the preview is one
// HTML file. Usage: bun build.ts SOURCE.html OUTPUT.html
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [source, output] = Bun.argv.slice(2);
if (!source || !output) {
  console.error("Usage: bun build.ts SOURCE.html OUTPUT.html");
  process.exit(1);
}
const sourceDir = dirname(resolve(source));
const missing: string[] = [];

// Remote, data, file, and fragment URLs stay as written. Anything else is a path from the source.
// Scripts and stylesheets get their element's type, so a file without an extension still loads.
function dataUrl(reference: string | null, type?: string): string | undefined {
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference)) return undefined;
  const path = resolve(sourceDir, decodeURIComponent(reference.replace(/[?#].*$/su, "")));
  if (!existsSync(path)) {
    missing.push(reference);
    return undefined;
  }
  const fragment = /#.*$/su.exec(reference)?.[0] ?? "";
  const bytes = readFileSync(path).toString("base64");
  return `data:${type ?? Bun.file(path).type};base64,${bytes}${fragment}`;
}

// Replacing only the URL keeps the element's other attributes, such as `defer` and `media`.
const html = new HTMLRewriter()
  .on("script[src]", {
    element(element) {
      const url = dataUrl(element.getAttribute("src"), "text/javascript");
      if (url) element.setAttribute("src", url);
    },
  })
  .on("img[src]", {
    element(element) {
      const url = dataUrl(element.getAttribute("src"));
      if (url) element.setAttribute("src", url);
    },
  })
  .on("link[rel~=stylesheet][href]", {
    element(element) {
      const url = dataUrl(element.getAttribute("href"), "text/css");
      if (url) element.setAttribute("href", url);
    },
  })
  .transform(readFileSync(source, "utf8"));

if (missing.length > 0) {
  console.error(`Missing local files: ${missing.join(", ")}`);
  process.exit(1);
}
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, html);
console.log(`Wrote ${resolve(output)}`);
