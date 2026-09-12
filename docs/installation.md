# Guided installation

Lilac's installer downloads a standalone CLI and runs an interactive setup before starting the
published containers. You need Docker, a model-provider account or an OpenAI-compatible endpoint, and
a Discord application with a bot token. Bun, Node.js, Git, and a source checkout are not required.

## System requirements

- Linux with glibc 2.28 or newer, or macOS 13 or newer.
- An x64 or arm64 processor. Linux x64 binaries use Bun's baseline CPU target, which requires SSE4.2.
- Docker running Linux containers, accessible by your current user.
- Docker Compose 2.30 or newer.
- `curl`, either `sha256sum` or `shasum`, and an interactive terminal.

The bootstrap exits before setup if these requirements are not met. Install Docker using its
[official instructions](https://docs.docker.com/get-started/get-docker/). When connecting over SSH,
allocate a terminal with `ssh -t`.

## Run setup

Open a terminal in the directory where Lilac should store its installation, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/stanley2058/lilac-mono/main/install.sh | bash
```

The script resolves one published release, downloads the binary for your machine, and verifies its
SHA-256 checksum. Interactive input comes from the terminal, so the piped shell script does not consume
your prompt responses.

Use the arrow keys to navigate menus and Enter to select. Press Escape or Ctrl+C to cancel.
Text fields show editable defaults. Credentials are masked; when updating an existing credential,
press Enter without typing to keep it.

Setup follows this sequence:

1. Check Docker and Compose.
2. Choose the installation directory. The default is your current directory.
3. Configure at least one model provider, then select main and fast models.
4. Enter the Discord bot token, open the invite and application-settings links, and choose channel rules.
5. Configure any optional integrations, or skip them.
6. Review the proposed configuration with secrets masked and confirm the write.
7. Pull container images, start Core and Redis, and wait for container health checks.

Once setup finishes, mention the bot in an allowed Discord channel to try it. Container health means
the services started successfully; your first Discord request also exercises model generation.

### Model providers

Model slugs and reasoning levels are separate fields. Setup offers these initial choices:

| Provider | Main model | Main reasoning | Fast model | Fast reasoning |
| --- | --- | --- | --- | --- |
| OpenAI API | `gpt-5.6-sol` | `medium` | `gpt-5.6-luna` | `low` |
| OpenAI OAuth / Codex | `gpt-5.6-sol` | `medium` | `gpt-5.6-luna` | `low` |
| Anthropic API | `opus-5` | `medium` | `sonnet-5` | `medium` |
| Vercel AI Gateway | `openai/gpt-5.6-sol` | `medium` | `openai/gpt-5.6-luna` | `low` |
| OpenRouter | `openai/gpt-5.6-sol` | `medium` | `openai/gpt-5.6-luna` | `low` |
| xAI API | `grok-4.6` | `high` | `grok-4.5` | `medium` |
| Cerebras | Enter a model slug | Select a level | Defaults to main | Defaults to main |
| Groq | Enter a model slug | Select a level | Defaults to main | Defaults to main |
| OpenAI-compatible | Enter a model slug | Select a level | Defaults to main | Defaults to main |

You can configure several providers and select main and fast models independently. API credentials
are checked during setup. Codex uses browser login; an SSH session can complete it by pasting the
localhost callback URL shown in the browser. The installer does not offer the `claude-code` provider.

An OpenAI-compatible base URL must be reachable both from the installer and from the Core container.
For a service on the Docker host, use an address with that reachability rather than container-local
`localhost`.

### Discord

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) and copy
its bot token. The installer supplies an invite URL after validating the token.

Invite URLs grant server permissions. Enable privileged intents separately on the application's Bot
page. Message Content Intent is required. If you enable member presence in Lilac, also enable Server
Members Intent and Presence Intent. The installer displays the application-specific settings link and
instructions for your selection.

Select specific channels or allow an entire server. The initial trigger mode is mention, so Lilac
responds when mentioned or replied to. You can select active mode and optionally customize Lilac's
bot name and status message.

### Optional setup

The optional menu includes computer use, GitHub authentication, blob storage, web providers,
conversation-thread behavior, and user/channel aliases. Each category can be skipped. Skipping a
category while updating an installation preserves its current settings.

- Computer use adds the gateway service and pulls its desktop runner image.
- GitHub accepts a personal access token, GitHub App credentials, or both. App setup takes the App ID,
  installation ID, and private key; Lilac creates installation tokens as needed.
- Blob storage defaults to the filesystem. S3-compatible storage is optional.
- Firecrawl, Exa, and Tavily are available for web tools. Configuring a web provider selects
  `tools.web.fetch.mode: provider-only`.
- Conversation threads and aliases use the same Core configuration fields available to manual edits.

## Files and subsequent setup

The selected installation directory contains:

| Path | Purpose |
| --- | --- |
| `bin/lilac` | Standalone setup CLI |
| `compose.yaml` | Container services and resolved image references |
| `secrets.env` | Environment credentials passed to the containers |
| `data/core-config.yaml` | Your Core configuration |
| `data/secret/` | File-based credentials, including Codex login when configured |
| `data/workspace/` | Lilac's working directory |

Redis keeps its data in a Compose volume. Reinstallation preserves these files and volumes. Published
Core images use UID `1000`. Setup uses a short-lived container to prepare private data files for
that UID and to read them on later runs when your host user cannot. The host-side Compose file,
environment file, and installer remain owned by your user. See
[container storage and UID](docker-deployment.md#storage-and-uid) for manual deployments with a
different build-time UID.

From the installation directory, run:

```sh
./bin/lilac
```

You can also rerun the original `curl` command to download the current setup CLI. Select your existing
installation directory to update configuration or reinstall. Existing values are loaded before the
prompts, and config updates preserve unrelated YAML values and comments. Confirmed updates and
reinstalls recreate containers so startup-only settings take effect, while retaining credentials and
data. Image references already recorded in Compose remain selected unless you provide explicit
overrides.

If image pulling or startup fails, fix the reported problem and rerun setup. You can inspect the
deployment directly from its directory:

```sh
docker compose ps
docker compose logs --tail=100 lilac
```

## Release and image overrides

These environment variables allow another release source or registry without modifying the installer:

| Variable | Value |
| --- | --- |
| `LILAC_RELEASE_BASE_URL` | Exact directory URL containing the CLI assets and `SHA256SUMS` |
| `LILAC_IMAGE` | Full Core image reference, including a tag or digest |
| `LILAC_COMPUTER_GATEWAY_IMAGE` | Full computer-use gateway image reference |
| `LILAC_COMPUTER_RUNNER_IMAGE` | Full computer-use runner image reference |

Export overrides before running the install command. Image overrides take precedence over an existing
Compose file and the CLI's release defaults. Use images built from the same source revision as the CLI.
For a private registry, authenticate Docker before starting setup.

The default published CLI embeds immutable image digests from its own release. It does not depend on
the registry's mutable `latest` tags. `LILAC_RELEASE_BASE_URL` must contain assets named
`lilac-linux-x64`, `lilac-linux-arm64`, `lilac-darwin-x64`, and `lilac-darwin-arm64`, plus `SHA256SUMS` with
standard `sha256sum` output using those basenames. A custom source can provide only the platforms it
supports. Its URL must identify one coherent artifact set.

## Scheduled publication

[`release.yaml`](../.github/workflows/release.yaml) publishes every 12 hours at 00:17 and 12:17 UTC.
It can also be started manually with `workflow_dispatch`. Pushes do not trigger publication.

Each run creates a unique version tied to its source commit and workflow attempt. It builds Core,
computer-use gateway, and computer-use runner images natively for Linux amd64 and arm64, smoke-tests
them, and merges their manifests. The CLI is then compiled and run natively on Linux and macOS for
both architectures, outside the source checkout. A GitHub Release becomes visible only after all
images and binaries succeed. Failed partial builds cannot become the default installer release.

Published packages are:

- `ghcr.io/<repository-owner>/lilac-mono`
- `ghcr.io/<repository-owner>/lilac-computer-gateway`
- `ghcr.io/<repository-owner>/lilac-computer`

The workflow uses `GITHUB_TOKEN` with package-write and release-write permissions. On the first run,
GitHub may create the packages as private. Make each package public in its package settings, then
rerun the workflow. The release job checks anonymous registry access before publishing a downloadable
installer. This avoids requiring registry authentication during public installation. See
[GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

For development, build the current machine's CLI from the repository root:

```sh
bun run build:installer
./apps/installer/dist/lilac-linux-x64 --help
```

Use the matching filename for your platform. `--target` accepts `linux-x64`, `linux-arm64`,
`darwin-x64`, or `darwin-arm64`; `--outdir` chooses the artifact directory. The release workflow supplies
`LILAC_INSTALLER_VERSION`, `LILAC_INSTALLER_COMMIT`, `LILAC_DEFAULT_IMAGE`,
`LILAC_DEFAULT_COMPUTER_GATEWAY_IMAGE`, and `LILAC_DEFAULT_COMPUTER_RUNNER_IMAGE` build-time definitions.
Compiled binaries disable automatic loading of `.env`, `bunfig.toml`, `tsconfig.json`, and `package.json`
from the directory where setup runs.
