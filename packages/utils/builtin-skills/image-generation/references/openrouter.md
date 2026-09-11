# OpenRouter

Default to `google/gemini-3.1-flash-image-preview` (Nano Banana 2), with one image at 1K. The [model page](https://openrouter.ai/google/gemini-3.1-flash-image-preview) and [image-model catalog](https://openrouter.ai/api/v1/images/models) identify the model. Use the dedicated `/images` endpoint and its base64 response. Source: [OpenRouter image guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).

```js
import { resolve } from "node:path";

const provider = providers.openrouter;
if (!provider) throw new Error("OpenRouter is not configured");
const response = await fetch(`${provider.baseURL}/images`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: "google/gemini-3.1-flash-image-preview",
    prompt: "A watercolor illustration of a mountain observatory",
    resolution: "1K",
    aspect_ratio: "3:2",
    n: 1,
  }),
});
if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
const result = await response.json();
const image = result.data?.[0];
if (!image?.b64_json) throw new Error("OpenRouter returned no image");
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const extension = extensions[image.media_type];
if (!extension) throw new Error(`Inspect the returned image format: ${image.media_type}`);
const path = resolve(`observatory-${crypto.randomUUID()}.${extension}`);
const bytes = await Bun.write(path, Buffer.from(image.b64_json, "base64"));
console.log(JSON.stringify({ path, bytes, mimeType: image.media_type, usage: result.usage }));
```

For reference-image edits, add `input_references` to the JSON body. Each entry is `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }`; build the data URL from the local image bytes. This default supports up to 14 references. Use prompt instructions for edits; consult endpoint capabilities before requesting a mask or another model's options. Sources: [reference inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-generation#image-to-image-reference-images), [default model capabilities](https://openrouter.ai/api/v1/images/models/google/gemini-3.1-flash-image-preview/endpoints).
