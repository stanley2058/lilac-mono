import { useContext, useEffect, useId, useRef } from "react";
import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";
import { readMotionDuration } from "../theme/motion";
import { MessageIdentityContext } from "./message-identity";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import "./agent-avatar.css";

export type AgentProfile = SubagentSummary["profile"];
type AgentShape = "general" | "explore" | "self";

/** "self" is Lilac's own identity; read-only permission profiles share the explore shape. */
function agentShape(profile: AgentProfile): AgentShape {
  if (profile === "self") return "self";
  if (profile === "restricted" || profile === "explore") return "explore";
  return "general";
}
type EyePosition = { x: number; y: number; targetX: number; targetY: number };
const eyes = new Map<HTMLSpanElement, EyePosition>();
let frame = 0;
let previousTime = 0;
let pointer = { x: 0, y: 0 };
let targetsDirty = false;

function resetEyes() {
  cancelAnimationFrame(frame);
  frame = 0;
  previousTime = 0;
  for (const [eye, position] of eyes) {
    eye.style.transform = "";
    position.x = position.y = position.targetX = position.targetY = 0;
  }
}

function animateEyes(time: number) {
  frame = 0;
  const duration = readMotionDuration();
  if (!duration) return resetEyes();
  if (targetsDirty) {
    // Read every position before writing transforms to avoid interleaved layout work.
    for (const [eye, position] of eyes) {
      const bounds = eye.parentElement!.getBoundingClientRect();
      const dx = pointer.x - (bounds.left + bounds.width / 2);
      const dy = pointer.y - (bounds.top + bounds.height / 2);
      const scale = (16 * bounds.width) / (250 * Math.max(100, Math.hypot(dx, dy)));
      const visible =
        bounds.width > 0 &&
        bounds.bottom > 0 &&
        bounds.top < innerHeight &&
        bounds.right > 0 &&
        bounds.left < innerWidth;
      position.targetX = visible ? dx * scale : 0;
      position.targetY = visible ? dy * scale : 0;
    }
    targetsDirty = false;
  }
  const elapsed = previousTime ? Math.min(time - previousTime, 64) : 1000 / 60;
  const blend = 1 - Math.exp(-elapsed / (duration * 0.45));
  previousTime = time;
  let moving = false;
  for (const [eye, position] of eyes) {
    position.x += (position.targetX - position.x) * blend;
    position.y += (position.targetY - position.y) * blend;
    const settled = Math.hypot(position.targetX - position.x, position.targetY - position.y) < 0.01;
    if (settled) {
      position.x = position.targetX;
      position.y = position.targetY;
    }
    moving ||= !settled;
    eye.style.transform = `translate(${position.x}px, ${position.y}px)`;
  }
  if (moving) frame = requestAnimationFrame(animateEyes);
  else previousTime = 0;
}

function followPointer(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  targetsDirty = true;
  if (!frame) frame = requestAnimationFrame(animateEyes);
}

function leaveWindow(event: PointerEvent) {
  if (!event.relatedTarget) resetEyes();
}

function trackEyes(eye: HTMLSpanElement) {
  if (!eyes.size) {
    window.addEventListener("pointermove", followPointer, { passive: true });
    window.addEventListener("pointerout", leaveWindow, { passive: true });
    window.addEventListener("blur", resetEyes);
  }
  eyes.set(eye, { x: 0, y: 0, targetX: 0, targetY: 0 });
  return () => {
    eyes.delete(eye);
    if (eyes.size) return;
    resetEyes();
    window.removeEventListener("pointermove", followPointer);
    window.removeEventListener("pointerout", leaveWindow);
    window.removeEventListener("blur", resetEyes);
  };
}

export function AgentAvatar({
  profile,
  displayName,
  size = "default",
  decorative = false,
  avatarUrl,
}: {
  profile: AgentProfile;
  displayName: string;
  decorative?: boolean;
  avatarUrl?: string;
  size?: "sm" | "default" | "lg";
}) {
  const identities = useContext(MessageIdentityContext);
  const shape = agentShape(profile);
  const configuredAvatar =
    shape === "self"
      ? (avatarUrl ?? (identities.promptingAgent ?? identities.agent).avatarUrl)
      : undefined;
  return (
    <Avatar
      size={size}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : displayName}
      className="agent-avatar after:hidden"
      data-agent-profile={shape}
    >
      {configuredAvatar ? (
        <>
          <AvatarImage src={configuredAvatar} alt="" referrerPolicy="no-referrer" />
          <AvatarFallback className="bg-transparent rounded-none">
            <AgentFace shape={shape} />
          </AvatarFallback>
        </>
      ) : (
        <AgentFace shape={shape} />
      )}
    </Avatar>
  );
}

function AgentFace({ shape }: { shape: AgentShape }) {
  const gradient = useId();
  const eyeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (eyeRef.current) return trackEyes(eyeRef.current);
  }, []);
  return (
    <span className="relative block size-full" aria-hidden="true">
      <svg className="size-full" viewBox="-125 -125 250 250">
        <defs>
          <radialGradient
            id={gradient}
            gradientUnits="userSpaceOnUse"
            cx="-50.56"
            cy="-63.2"
            r="244.9"
          >
            <stop offset="0%" stopColor="var(--ui-agent-highlight)" />
            <stop offset="32%" stopColor="var(--ui-agent-light)" />
            <stop offset="72%" stopColor="var(--ui-agent-base)" />
            <stop offset="100%" stopColor="var(--ui-agent-shadow)" />
          </radialGradient>
        </defs>
        <g fill={`url(#${gradient})`}>
          {shape === "general" ? <circle r="100" /> : null}
          {shape === "explore" ? (
            <rect x="-80" y="-80" width="160" height="160" rx="28" transform="rotate(45)" />
          ) : null}
          {shape === "self" ? <rect x="-96" y="-96" width="192" height="192" rx="56" /> : null}
        </g>
      </svg>
      <span ref={eyeRef} className="agent-avatar-eyes absolute inset-0">
        <svg className="size-full" viewBox="-125 -125 250 250" fill="var(--ui-agent-eyes)">
          <rect
            x="-9.3"
            y="-20.6"
            width="18.6"
            height="41.2"
            rx="9.3"
            transform="matrix(.94,-.2,.23,.97,-26.69,10.48)"
          />
          <rect
            x="-9.3"
            y="-20.6"
            width="18.6"
            height="41.2"
            rx="9.3"
            transform="matrix(.94,-.23,.23,.97,25.25,-1.5)"
          />
        </svg>
      </span>
    </span>
  );
}
