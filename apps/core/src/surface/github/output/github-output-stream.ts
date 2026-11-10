import { Result } from "better-result";

import type { GithubSessionRef, MsgRef } from "../../types";
import type {
  SurfaceOperationResult,
  SurfaceOutputPart,
  SurfaceOutputPartDisposition,
  SurfaceOutputResult,
  SurfaceOutputStream,
} from "../../adapter";

import { markGithubAgentComment } from "../../../github/github-comment-marker";
import { githubReplyPrefix } from "../../../github/github-ids";

export class GithubOutputStream implements SurfaceOutputStream {
  private text = "";
  private created: MsgRef[] = [];

  constructor(
    private readonly sessionRef: GithubSessionRef,
    private readonly api: {
      createComment(body: string): Promise<SurfaceOperationResult<{ readonly id: number }>>;
      resolveWebBaseUrl(): Promise<string>;
    },
    private readonly opts?: { replyTo?: MsgRef },
  ) {}

  async push(
    part: SurfaceOutputPart,
  ): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>> {
    return Result.ok(this.applyPart(part));
  }

  private applyPart(part: SurfaceOutputPart): SurfaceOutputPartDisposition {
    switch (part.type) {
      case "text.delta": {
        // Buffer deltas; GitHub surface posts once at finish.
        this.text += part.delta;
        return "visible";
      }
      case "text.set": {
        this.text = part.text;
        return "visible";
      }
      case "attachment.add": {
        // GitHub omits binary attachments, but attachment-only replies still complete at finish.
        return "terminal";
      }
      case "reasoning.status": {
        // Ignore (no streaming UI for GitHub).
        return "ignored";
      }
      case "tool.status": {
        // GitHub has no tool UI, but tool-only replies still complete at finish.
        return "terminal";
      }
      case "meta.stats": {
        // Ignore (no dedicated stats UI for GitHub).
        return "ignored";
      }
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  /** GitHub comments have no native reply target, so replies carry a permalink prefix instead. */
  private async replyPrefix(): Promise<string> {
    const replyTo = this.opts?.replyTo;
    if (replyTo?.platform !== "github") return "";
    const webBaseUrl = await this.api.resolveWebBaseUrl();
    return githubReplyPrefix({
      sessionId: replyTo.channelId,
      messageId: replyTo.messageId,
      webBaseUrl,
    });
  }

  async finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    const replyPrefix = await this.replyPrefix();

    const text = `${replyPrefix}${this.text}`.trim();
    const capacity = 65_536 - markGithubAgentComment("").length - 1;
    for (let offset = 0; offset < text.length || offset === 0; ) {
      let end = Math.min(text.length, offset + capacity);
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (end < text.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
      const chunk = text.slice(offset, end);
      const res = await this.api.createComment(`${markGithubAgentComment("")}\n${chunk}`);
      const failure = res.match({ ok: () => null, err: (error) => error });
      if (failure) return Result.err(failure);
      const id = res.match({ ok: (value) => value.id, err: () => 0 });
      this.created.push({
        platform: "github",
        channelId: this.sessionRef.channelId,
        messageId: String(id),
      });
      if (end === text.length) break;
      offset = end;
    }
    return Result.ok({ created: this.created, last: this.created[this.created.length - 1]! });
  }

  async abort(_reason?: string): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
}
