import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { isMap, parseDocument } from "yaml";

import { savedFile, stageFile, validatedText, validateHttpUrl } from "./optional-input";
import type { Prompt, SetupDraft } from "./types";

function validatePort(value: string): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Enter a port from 1 to 65535.";
  }
  return undefined;
}

function validateRenderedHost(value: string): string | undefined {
  const invalidUrl = validateHttpUrl(value);
  if (invalidUrl) return invalidUrl;
  const url = new URL(value);
  if (url.port || url.pathname !== "/" || url.search || url.hash) {
    return "Enter a scheme and hostname without a port, path, query, or fragment.";
  }
  return undefined;
}

async function configureViewer(prompt: Prompt, draft: SetupDraft): Promise<void> {
  draft.secrets.BIND_ADDR = await validatedText(
    prompt,
    "Desktop port bind address",
    draft.secrets.BIND_ADDR ?? "127.0.0.1",
    (value) => (isIP(value) ? undefined : "Enter an IPv4 or IPv6 address."),
  );
  draft.secrets.RENDERED_HOST = await validatedText(
    prompt,
    "Desktop viewer URL host",
    draft.secrets.RENDERED_HOST ?? "http://localhost",
    validateRenderedHost,
  );
  draft.secrets.PORT_RANGE_START = await validatedText(
    prompt,
    "First desktop port",
    draft.secrets.PORT_RANGE_START ?? "17000",
    validatePort,
  );
  draft.secrets.PORT_RANGE_END = await validatedText(
    prompt,
    "Last desktop port",
    draft.secrets.PORT_RANGE_END ?? "17031",
    (value) => {
      const invalidPort = validatePort(value);
      if (invalidPort) return invalidPort;
      if (Number(value) < Number(draft.secrets.PORT_RANGE_START)) {
        return "The last port must be at least the first port.";
      }
      return undefined;
    },
  );
}

export async function configureComputerUse(prompt: Prompt, draft: SetupDraft): Promise<void> {
  prompt.note(
    "Computer use starts a desktop gateway with access to the Docker socket. Desktop viewer ports default to this machine's loopback address.",
  );
  if (!(await prompt.confirm("Enable computer use?", true))) return;

  const existing = await savedFile(draft, "mcp-config.yaml");
  const document = parseDocument(existing ?? "configVersion: 1\nservers: {}\n");
  const servers = document.get("servers", true);
  if (
    document.errors.length ||
    !isMap(document.contents) ||
    document.get("configVersion") !== 1 ||
    (servers !== undefined && !isMap(servers))
  ) {
    prompt.note(
      "The existing mcp-config.yaml is invalid or uses an unsupported version. Computer use was left unchanged; repair that file before configuring it.",
    );
    return;
  }

  const currentServer = document.getIn(["servers", "computer_use"], true);
  const currentUrl = document.getIn(["servers", "computer_use", "url"]);
  const gatewayUrl = "http://computer-use-gateway:8080/mcp";
  if (
    currentServer &&
    currentUrl !== gatewayUrl &&
    !(await prompt.confirm(
      "Replace the existing computer_use MCP server with this installation's desktop gateway?",
      false,
    ))
  )
    return;

  if (await prompt.confirm("Customize the desktop address and port range?", false)) {
    await configureViewer(prompt, draft);
  }

  const currentAuthorization = await savedFile(draft, "secret/computer-use-authorization");
  const existingSecret = currentAuthorization?.trim().replace(/^Bearer\s+/, "");
  const secret =
    draft.secrets.MCP_BEARER_SECRET || existingSecret || randomBytes(32).toString("base64url");
  draft.secrets.MCP_BEARER_SECRET = secret;
  const allowSubagents = document.getIn(["servers", "computer_use", "allowSubagents"]) === true;
  document.setIn(["servers", "computer_use"], {
    allowSubagents,
    transport: "http",
    url: gatewayUrl,
    headers: { Authorization: { file: "/data/secret/computer-use-authorization" } },
  });
  stageFile(draft, { relativePath: "mcp-config.yaml", content: document.toString() });
  stageFile(draft, {
    relativePath: "secret/computer-use-authorization",
    content: `Bearer ${secret}\n`,
    mode: 0o600,
  });
  draft.computerEnabled = true;
  prompt.note(
    "Computer use is selected. The gateway and desktop images will be pulled after review.",
  );
}
