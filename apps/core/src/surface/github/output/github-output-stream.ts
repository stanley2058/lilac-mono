import type {
  MsgRef,
  SessionRef,
  SurfaceAttachment,
} from "../../types";
import type {
  SurfaceOutputPart,
  SurfaceOutputResult,
  SurfaceOutputStream,
} from "../../adapter";

import { createIssueComment } from "../../../github/github-api";
import { parseGithubSessionId } from "../../../github/github-ids";

export class GithubOutputStream implements SurfaceOutputStream {
  private text = "";
  private attachments: SurfaceAttachment[] = [];
  private created: MsgRef[] = [];

  constructor(
    private readonly sessionRef: SessionRef,
    private readonly opts?: { replyTo?: MsgRef },
  ) {
    if (sessionRef.platform !== "github") {
      throw new Error("GithubOutputStream requires a github sessionRef");
    }
  }

  async push(part: SurfaceOutputPart): Promise<void> {
    switch (part.type) {
      case "text.delta": {
        // Buffer deltas; GitHub surface posts once at finish.
        this.text += part.delta;
        return;
      }
      case "text.set": {
        this.text = part.text;
        return;
      }
      case "attachment.add": {
        // Not supported yet; keep for parity.
        this.attachments.push(part.attachment);
        return;
      }
      case "tool.status": {
        // Ignore (no streaming UI for GitHub).
        return;
      }
      case "meta.stats": {
        // Ignore (no dedicated stats UI for GitHub).
        return;
      }
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  async finish(): Promise<SurfaceOutputResult> {
    if (this.sessionRef.platform !== "github") {
      throw new Error("GithubOutputStream.finish requires a github sessionRef");
    }

    const thread = parseGithubSessionId(this.sessionRef.channelId);

    const replyPrefix = (() => {
      const replyTo = this.opts?.replyTo;
      if (!replyTo || replyTo.platform !== "github") return "";
      return `In reply to ${replyTo.messageId}:\n\n`;
    })();

    const body = `${replyPrefix}${this.text}`.trim();
    const res = await createIssueComment({
      owner: thread.owner,
      repo: thread.repo,
      issueNumber: thread.number,
      body,
    });

    const ref: MsgRef = {
      platform: "github",
      channelId: this.sessionRef.channelId,
      messageId: String(res.id),
    };
    this.created.push(ref);

    return {
      created: this.created,
      last: ref,
    };
  }

  async abort(_reason?: string): Promise<void> {
    // No-op: we do not create placeholder comments.
  }
}
