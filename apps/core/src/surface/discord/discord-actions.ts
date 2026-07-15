import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import type { SurfaceAction } from "../types";

const ACTION_PREFIX = "lilac_action:v1:";
const CUSTOM_ID_MAX_LENGTH = 100;

export function buildDiscordActionCustomId(actionId: string): string {
  const customId = `${ACTION_PREFIX}${actionId}`;
  if (!actionId || customId.length > CUSTOM_ID_MAX_LENGTH) {
    throw new Error("Discord surface action ID is empty or exceeds the custom_id limit");
  }
  return customId;
}

export function parseDiscordActionCustomId(customId: string): string | null {
  if (!customId.startsWith(ACTION_PREFIX)) return null;
  const actionId = customId.slice(ACTION_PREFIX.length);
  return actionId.length > 0 ? actionId : null;
}

function buttonStyle(style: SurfaceAction["style"]): ButtonStyle {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    case "secondary":
      return ButtonStyle.Secondary;
  }
}

export function buildDiscordActionComponents(
  actions: readonly SurfaceAction[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < actions.length; index += 5) {
    const buttons = actions
      .slice(index, index + 5)
      .map((action) =>
        new ButtonBuilder()
          .setCustomId(buildDiscordActionCustomId(action.actionId))
          .setLabel(action.label)
          .setStyle(buttonStyle(action.style)),
      );
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  }
  return rows;
}
