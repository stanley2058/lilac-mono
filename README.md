<p align="center">
  <img src="assets/logo.svg" alt="Lilac" width="160">
</p>

# Lilac

Lilac is an AI assistant you host yourself and talk to on Discord. It can work with files, run
commands, and use web tools. You choose its models and the channels where it can respond. Optional
integrations add computer use and GitHub access.

## Get started

Before you start, have these ready:

- Docker with Compose 2.30 or newer, running Linux containers.
- An account with a model provider or an OpenAI-compatible endpoint.
- A Discord application with a bot token. See [Discord setup](docs/installation.md#discord).

See the [system requirements](docs/installation.md#system-requirements) for supported Linux and macOS
versions. Create a directory for Lilac's files, then start setup:

```sh
mkdir -p lilac
cd lilac
curl -fsSL https://raw.githubusercontent.com/stanley2058/lilac-mono/main/install.sh | bash
```

Use the arrow keys and Enter to work through the wizard. It checks your machine, guides you through
provider authentication and Discord channel selection, then offers optional integrations. You can skip
those and configure them later. Review and confirm the configuration to pull the images and start Lilac.

Once setup reports that Lilac is healthy, mention your bot in an allowed Discord channel to start a
conversation. By default, it responds to mentions and replies.

## After installation: make Lilac your own

Lilac creates prompt files in `data/prompts/` inside your installation directory. Go through these
starter files and update them to fit how you want the assistant to work:

| File | What to personalize |
| --- | --- |
| [USER.md](packages/utils/prompt-templates/USER.md) | Your name, timezone, language, and communication preferences. |
| [IDENTITY.md](packages/utils/prompt-templates/IDENTITY.md) | Lilac's name, personality, voice, and style. |
| [SOUL.md](packages/utils/prompt-templates/SOUL.md) | Values, priorities, and how Lilac relates to you. |
| [AGENTS.md](packages/utils/prompt-templates/AGENTS.md) | Working rules, autonomy, and when to ask before acting. |
| [TOOLS.md](packages/utils/prompt-templates/TOOLS.md) | Environment notes and conventions for using tools. |
| [MEMORY.md](packages/utils/prompt-templates/MEMORY.md) | Decisions and lasting context you want it to remember. |

You can edit the files yourself or talk to Lilac on Discord and ask it to help. For example:

> Help me personalize your prompt files in `/data/prompts`. Ask me about my preferences, then update
> the files to match. Start with `USER.md` and `IDENTITY.md`.

## Manage your installation

Run these commands from the directory you chose during setup:

| Task | Command |
| --- | --- |
| Change configuration or reinstall | `./bin/lilac` |
| Check service status | `docker compose ps` |
| Follow Lilac's logs | `docker compose logs -f lilac` |
| Stop Lilac and its services | `docker compose stop` |
| Start them again | `docker compose start` |

The setup CLI loads your existing configuration. Updates and reinstalls preserve your data. Rerun the
`curl` command from your installation directory to download the current setup CLI. See the
[installation guide](docs/installation.md#files-and-subsequent-setup) for file locations, image
selection, and troubleshooting.

## Documentation

- [Installation and setup](docs/installation.md): providers, Discord, optional integrations, and reconfiguration.
- [Configuration reference](packages/utils/config-templates/core-config.example.yaml): settings available in Core configuration.
- [Configuration upgrades](docs/core-config-migrations.md): migrating an existing Core configuration.
- [Manual Docker deployment](docs/docker-deployment.md): source builds, storage, and diagnostics.
- [Computer use](docs/computer-use.md): desktop setup and operation.
- [Skills](docs/skill-authoring.md): adding reusable instructions and scripts.
- [Claude Code integration](docs/claude-code.md): manual setup for the Claude Code provider.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) to run Lilac from source, build its CLIs and containers, and run
checks. [PROJECT.md](PROJECT.md) covers architecture, terminology, and subsystem ownership.

## License

Lilac is licensed under MIT. See [LICENSE](LICENSE). Vendored projects under `ref/` retain their
upstream license terms.
