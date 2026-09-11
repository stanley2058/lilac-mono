# OpenAI

Use `gpt-image-2.5-sunburst` for generation and precise edits; `gpt-image-2.5-flare` is the faster alternative. Quality defaults to `auto`; explicit choices include `low`, `medium`, `high`, `xhigh`, and `max`. Standard sizes are 1024x1024, 1536x1024, and 1024x1536. Custom dimensions require multiples of 16, edges at most 3840, ratios between 1:3 and 3:1, and 655,360–8,294,400 pixels. Above 2560x1440 is experimental. Sources: [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [image guide](https://developers.openai.com/api/docs/guides/image-generation).

## Generate

Edit the prompt, dimensions, and output path. Omit quality to use the provider default. PNG is the default format.

```js
import { resolve } from "node:path";

const provider = providers.openai;
if (!provider) throw new Error("OpenAI is not configured");
const response = await fetch(`${provider.baseURL}/images/generations`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: "gpt-image-2.5-sunburst",
    prompt: "A watercolor illustration of a mountain observatory",
    size: "1536x1024",
  }),
});
if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
const result = await response.json();
const encoded = result.data?.[0]?.b64_json;
if (!encoded) throw new Error("OpenAI returned no image");
const path = resolve(`observatory-${crypto.randomUUID()}.png`);
const bytes = await Bun.write(path, Buffer.from(encoded, "base64"));
console.log(JSON.stringify({ path, bytes, mimeType: "image/png", usage: result.usage }));
```

## Edit or inpaint

Use this recipe for a local input and optional mask. Remove the mask append for an unmasked edit; append more named image blobs for multiple references. Transparent mask pixels identify the edit area on the first image. Follow the [edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit) for input and mask requirements. Explicit multipart filenames avoid Bun's unnamed-blob upload problem.

```js
import { resolve } from "node:path";

const provider = providers.openai;
if (!provider) throw new Error("OpenAI is not configured");
const body = new FormData();
body.append("model", "gpt-image-2.5-sunburst");
body.append("prompt", "Replace the masked background with a sunset sky");
body.append("size", "1536x1024");
body.append("image[]", new Blob([await Bun.file("input.png").arrayBuffer()], { type: "image/png" }), "input.png");
body.append("mask", new Blob([await Bun.file("mask.png").arrayBuffer()], { type: "image/png" }), "mask.png");
const response = await fetch(`${provider.baseURL}/images/edits`, {
  method: "POST",
  headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
  body,
});
if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
const result = await response.json();
const encoded = result.data?.[0]?.b64_json;
if (!encoded) throw new Error("OpenAI returned no image");
const path = resolve(`edited-${crypto.randomUUID()}.png`);
const bytes = await Bun.write(path, Buffer.from(encoded, "base64"));
console.log(JSON.stringify({ path, bytes, mimeType: "image/png", usage: result.usage }));
```

For transparent output, set `background: "transparent"` with PNG or WebP output. Use native request fields to access new options without waiting for an SDK update.
