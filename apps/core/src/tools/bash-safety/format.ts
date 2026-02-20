type RedactFn = (text: string) => string;

export interface FormatBlockedMessageInput {
  reason: string;
  command?: string;
  segment?: string;
  maxLen?: number;
  redact?: RedactFn;
}

export function formatBlockedMessage(input: FormatBlockedMessageInput): string {
  const { reason, command, segment } = input;
  const maxLen = input.maxLen ?? 200;
  const redact = input.redact ?? ((t: string) => t);

  let message = `BLOCKED by Bash Safety\n\nReason: ${reason}`;

  if (command) {
    const safeCommand = redact(command);
    message += `\n\nCommand: ${excerpt(safeCommand, maxLen)}`;
  }

  if (segment && segment !== command) {
    const safeSegment = redact(segment);
    message += `\n\nSegment: ${excerpt(safeSegment, maxLen)}`;
  }

  message += "\n\nIf this operation is truly needed, set dangerouslyAllow=true and re-run.";

  return message;
}

function excerpt(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function redactSecrets(text: string): string {
  let result = text;

  result = result.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIALS)[A-Z0-9_]*)=([^\s]+)/gi,
    "$1=<redacted>",
  );

  result = result.replace(/(['"]?\s*authorization\s*:\s*)([^'"]+)(['"]?)/gi, "$1<redacted>$3");
  result = result.replace(/(authorization\s*:\s*)([^\s"']+)(\s+[^\s"']+)?/gi, "$1<redacted>");

  result = result.replace(/(https?:\/\/)([^\s/:@]+):([^\s@]+)@/gi, "$1<redacted>:<redacted>@");

  result = result.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted>");
  result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted>");

  return result;
}
