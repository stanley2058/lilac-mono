import { FileIcon } from "./FileIcon";
import { useImageFailure } from "../image-retry";
import { FileActions } from "./FileActions";
import { useState, type ReactNode } from "react";
import type { MessageResource } from "./message-resources";
import { ResourcePreview, attachmentKind } from "./ResourcePreview";
import { Button } from "./ui/button";

export function AttachmentReference({
  href,
  resource,
  children,
}: {
  href: string;
  resource: MessageResource;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [imageFailed, failImage] = useImageFailure<true>();
  const ready = resource.state === "ready";
  const image = ready && resource.mediaType.startsWith("image/") && !imageFailed;
  return (
    <FileActions
      disabled={!ready}
      target={{
        type: "resource",
        href,
        name: resource.name,
        mediaType: resource.mediaType,
        resourceId: resource.resourceId,
      }}
      onPreview={() => setOpen(true)}
    >
      <span className="sent-attachment-reference inline">
        <Button
          type="button"
          data-copy-content
          variant="reference"
          className="sent-attachment-chip inline-flex max-w-full h-auto gap-1 px-2 rounded-sm [font-weight:inherit]"
          disabled={!ready}
          aria-label={`Preview ${resource.name}`}
          onClick={() => setOpen(true)}
        >
          {image ? (
            <img
              src={href}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => failImage(true)}
            />
          ) : (
            <FileIcon name={resource.name} mediaType={resource.mediaType} />
          )}
          <span>{children}</span>
        </Button>
        {open ? (
          <ResourcePreview
            name={resource.name}
            href={href}
            kind={attachmentKind(resource.mediaType, resource.name)}
            target={{
              type: "resource",
              href,
              name: resource.name,
              mediaType: resource.mediaType,
              resourceId: resource.resourceId,
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    </FileActions>
  );
}
