# xAI

Default to `grok-imagine-image-2.0`. The generation endpoint accepts `aspect_ratio` and `response_format: "b64_json"`. Source: [xAI image generation](https://docs.x.ai/developers/model-capabilities/images/generation).

```js
import { resolve } from "node:path";

const provider = providers.xai;
if (!provider) throw new Error("xAI is not configured");
const response = await fetch(`${provider.baseURL}/images/generations`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: "grok-imagine-image-2.0",
    prompt: "A watercolor illustration of a mountain observatory",
    aspect_ratio: "3:2",
    response_format: "b64_json",
    n: 1,
  }),
});
if (!response.ok) throw new Error(`xAI ${response.status}: ${await response.text()}`);
const result = await response.json();
const encoded = result.data?.[0]?.b64_json;
if (!encoded) throw new Error("xAI returned no image");
const path = resolve(`observatory-${crypto.randomUUID()}.jpg`);
const bytes = await Bun.write(path, Buffer.from(encoded, "base64"));
console.log(JSON.stringify({ path, bytes, mimeType: "image/jpeg" }));
```

For edits, send JSON to `/images/edits` with `image: { type: "image_url", url: "data:image/png;base64,..." }` alongside the model and prompt. Build the data URL from the local file's bytes. See the [xAI image editing guide](https://docs.x.ai/developers/model-capabilities/images/editing) for further options. Save URL-based results promptly if choosing that response format instead of base64.
