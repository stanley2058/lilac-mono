import { linkPreviewUrl, readPublicResource } from "./public-resource";
export { isPublicLinkAddress, linkPreviewUrl } from "./public-resource";
import { Result, TaggedError } from "better-result";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";

export type LinkPreview = NativeRpcOutputs["links"]["preview"];
class LinkPreviewFailure extends TaggedError("LinkPreviewFailure")<{ message: string }> {}
const unavailable = () => new LinkPreviewFailure({ message: "Link preview unavailable" });

function cleanText(value: string | null | undefined, limit: number): string | undefined {
  return value?.replace(/\s+/gu, " ").trim().slice(0, limit) || undefined;
}

// Loaded on the first preview: metascraper costs about 33 MiB of RSS per process.
async function createScraper() {
  const [
    { default: metascraper },
    { default: metascraperTitle },
    { default: metascraperDescription },
    { default: metascraperImage },
    { default: metascraperLogo },
  ] = await Promise.all([
    import("metascraper"),
    import("metascraper-title"),
    import("metascraper-description"),
    import("metascraper-image"),
    import("metascraper-logo"),
  ]);
  return metascraper([
    metascraperTitle(),
    metascraperDescription(),
    metascraperImage(),
    metascraperLogo(),
    {
      // The favicon plugin probes URLs itself; keep all network access in the guarded fetcher.
      icon: ({ htmlDom, url }) => {
        const base =
          linkPreviewUrl(htmlDom("base[href]").first().attr("href") ?? "", url)?.href ?? url;
        for (const selector of ['link[rel~="icon" i]', 'link[rel="apple-touch-icon" i]']) {
          for (const element of htmlDom(selector).toArray()) {
            const href = htmlDom(element).attr("href");
            const icon = href ? linkPreviewUrl(href, base) : undefined;
            if (icon) return icon.href;
          }
        }
        return undefined;
      },
    },
  ]);
}

let scraper: ReturnType<typeof createScraper> | undefined;

export async function parseLinkPreview(html: string, href: string): Promise<LinkPreview> {
  scraper ??= createScraper();
  const scrape = await scraper;
  const metadata = await scrape({ html, url: href });
  return {
    title: cleanText(metadata.title, 512),
    description: cleanText(metadata.description, 2048),
    image: metadata.image ? linkPreviewUrl(metadata.image, href)?.href : undefined,
    icon: linkPreviewUrl(metadata.icon ?? metadata.logo ?? "/favicon.ico", href)?.href,
  };
}

export async function readPublicPage(url: URL, signal: AbortSignal) {
  return (await readPublicResource(url, signal, "page")).map((reply) => ({
    html: reply.bytes.toString("utf8"),
    ...(reply.location ? { location: reply.location } : {}),
  }));
}

export async function resolveLinkPreview(
  href: string,
  signal?: AbortSignal,
  readPage = readPublicPage,
): Promise<LinkPreview> {
  let url = linkPreviewUrl(href);
  if (!url) return {};
  const timeout = AbortSignal.timeout(5000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const page = await readPage(url, deadline);
    const reply = page.match({ ok: (value) => value, err: () => undefined });
    if (!reply) return {};
    if (reply.location) {
      url = linkPreviewUrl(reply.location, url.href);
      if (!url) return {};
      continue;
    }
    const pageUrl = url.href;
    const parsed = await Result.tryPromise({
      try: () => parseLinkPreview(reply.html, pageUrl),
      catch: unavailable,
    });
    return parsed.match({ ok: (value) => value, err: () => ({}) });
  }
  return {};
}
