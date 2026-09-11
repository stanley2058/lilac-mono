---
name: image-generation
description: Generate or edit images with generate.image using configured providers. Read this for default model choices, JavaScript request recipes, reference images, and masked edits.
---

# Image generation

Use `tools --help generate.image` to see configured providers. Choose from the catalog below when the user leaves the model unspecified; ordinary generation needs no model research. Provider configuration does not guarantee account access to every model.

## Default catalog

Use the first configured provider in this order. Honor an explicit provider or model choice.

| Provider | Default model | Recipe |
| --- | --- | --- |
| `openai` | `gpt-image-2.5-sunburst` | [OpenAI generation and masked edits](references/openai.md) |
| `openrouter` | `google/gemini-3.1-flash-image-preview` (Nano Banana 2) | [OpenRouter generation and reference images](references/openrouter.md) |
| `xai` | `grok-imagine-image-2.0` | [xAI generation and edits](references/xai.md) |

For fast OpenAI drafts, `gpt-image-2.5-flare` is an alternative. Prefer Sunburst for precise edits. The catalog was checked on 2026-09-11. Read the selected provider's recipe; consult its upstream links for features outside the recipe, an explicit unlisted model, or a model/parameter rejection. A custom endpoint may expose a different catalog.

## Execute

`generate.image` accepts `{ "code": "JavaScript source" }`. Each call runs a fresh Bun process in the caller's cwd with the container environment. It supports top-level await, standard imports, `fetch`, `FormData`, and `Bun.write`. The injected global `providers` contains only configured providers, each with `baseURL` and an optional `apiKey`. Use these values for endpoint and authentication wiring. Keep credentials out of source, output, and saved files.

Adapt a recipe into a local JavaScript file, then submit its contents as code:

```bash
bun -e 'console.log(JSON.stringify({code: await Bun.file("image-request.js").text()}))' | tools generate.image --stdin
```

The tool returns `stdout`, `stderr`, `exitCode`, and `truncated`. A nonzero `exitCode` means the script failed even though execution results were collected successfully. Output is capped at 40 Ki characters per stream; execution stops after 10 minutes or caller cancellation. Save image bytes to files and print paths and small metadata, rather than base64 responses. Pick a fresh output filename for each request.

After success, inspect the saved image with the available image-reading tool before delivering its path or attaching it. On a provider error, use the reported status and message to correct the request. After cancellation, timeout, or uncertain network completion, report the uncertainty before making another paid generation request.
