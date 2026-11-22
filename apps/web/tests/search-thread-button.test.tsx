import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchThreadButton } from "../src/components/SearchThreadButton";

test("SearchThreadButton wraps long unbroken tokens within its width", () => {
  const html = renderToStaticMarkup(
    <SearchThreadButton
      id="thread-1"
      title="Chat with Lilac"
      excerpt="ant quote](lilac-citation://v1/quote?thread=17de7ee&message=np_3d20ffbc39ebe01ada5&prefix=.+Accurate%2C+may)"
      query="gemini"
      onSelect={() => {}}
    />,
  );

  expect(html).toContain("wrap-anywhere");
  expect(html).toContain("min-w-0");
  expect(html).toContain('<strong class="w-full min-w-0">');
  expect(html).toContain('<span class="w-full min-w-0">');
});
