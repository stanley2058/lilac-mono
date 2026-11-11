import type { AdapterPlatform, SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import type { WorkflowCard } from "@stanley2058/lilac-client-protocol";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceAdapter } from "./adapter";
import type { SurfaceOperationError } from "./adapter";
import type { ContentOpts, MsgRefFor, RegisteredSurfacePlatform, SessionRefFor } from "./types";
import {
  createDescriptorBoundSurfaceAdapter,
  createDescriptorBoundWorkflowProgressPort,
} from "./produced-ref-guard";
import type { SurfaceProtocolRouting } from "./protocol";
import type { RegisteredSurfaceQuestionPort, SurfaceQuestionPort } from "./question";
import type { SurfaceThreadControlPort } from "./thread-control";

export {
  SurfaceRefInvalid,
  SurfaceReplyTargetInvalid,
  type ReplyTargetResolution,
} from "./protocol";
import type { ReplyTargetResolution, SurfaceRefInvalid } from "./protocol";

export type { MsgRefFor, RegisteredSurfacePlatform, SessionRefFor } from "./types";

export interface SurfaceLifecycleHandle {
  stop(): Promise<void>;
}

export interface SurfaceLifecyclePort<H extends SurfaceLifecycleHandle> {
  start(): Promise<H>;
}

export type SurfaceAdapterIngressHandle<P extends RegisteredSurfacePlatform> =
  SurfaceLifecycleHandle & {
    readonly platform: P;
  };

export interface SurfaceAdapterIngress<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecyclePort<SurfaceAdapterIngressHandle<P>> {}

export type SurfaceRequestIngressHandle = SurfaceLifecycleHandle;

export interface SurfaceRequestIngress extends SurfaceLifecyclePort<SurfaceRequestIngressHandle> {}

export interface SurfaceRelayHandle<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecycleHandle {
  readonly platform: P;
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
}

export interface SurfaceRelayLifecyclePort<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecyclePort<SurfaceRelayHandle<P>> {
  readonly platform: P;
}

export type SurfaceRelayRefs<P extends RegisteredSurfacePlatform> = {
  createSessionRef(sessionId: string): SessionRefFor<P>;
  resolveInitialReplyTarget(input: {
    readonly requestId: string;
    readonly sessionId: string;
  }): ReplyTargetResolution<MsgRefFor<P>>;
  decodeReanchorTarget(input: {
    readonly ref: SurfaceMsgRef;
    readonly expectedSessionId: string;
  }): ResultType<MsgRefFor<P>, SurfaceRefInvalid>;
};

export class SurfaceIngressAcknowledgementCleanupFailed extends TaggedError(
  "SurfaceIngressAcknowledgementCleanupFailed",
)<{
  readonly cause: {
    readonly errorTag: string;
    readonly errorMessage: string;
  };
  readonly message: string;
}> {}

export type SurfaceRelayFinalization<P extends RegisteredSurfacePlatform> = {
  isFinalResponseSuperseded?(input: {
    readonly requestId: string;
    readonly sessionId: string;
  }): boolean;
  clearIngressAcknowledgement?(input: {
    readonly requestId: string;
    readonly sessionId: string;
  }): Promise<ResultType<void, SurfaceIngressAcknowledgementCleanupFailed>>;
  cleanupSkippedOutput?(input: { readonly ref: MsgRefFor<P> }): Promise<void>;
};

export type SurfaceRelayPolicy<P extends RegisteredSurfacePlatform> = {
  readonly refs: SurfaceRelayRefs<P>;
  readonly finalization?: SurfaceRelayFinalization<P>;
};

export type SurfaceRelayDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly lifecycle: SurfaceRelayLifecyclePort<P>;
} & SurfaceRelayPolicy<P>;

type WorkflowProgressOperationFailureBase = {
  readonly operation: "check-message" | "send" | "edit";
  readonly message: string;
};

export type WorkflowProgressOperationFailureFields = WorkflowProgressOperationFailureBase &
  (
    | {
        readonly disposition: "permanent";
        readonly reason:
          | "unsupported"
          | "invalid-input"
          | "platform-mismatch"
          | "session-mismatch"
          | "not-found"
          | "partial-outcome";
        readonly retryAfterMs?: never;
      }
    | {
        readonly disposition: "retryable";
        readonly reason: "rate-limited";
        readonly retryAfterMs?: number;
      }
    | {
        readonly disposition: "retryable";
        readonly reason: "permission-denied" | "unavailable";
        readonly retryAfterMs?: never;
      }
  );

class WorkflowProgressPermanentOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<Extract<WorkflowProgressOperationFailureFields, { readonly disposition: "permanent" }>> {}

class WorkflowProgressRateLimitedOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<Extract<WorkflowProgressOperationFailureFields, { readonly reason: "rate-limited" }>> {}

class WorkflowProgressRetryableOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<
  Extract<
    WorkflowProgressOperationFailureFields,
    { readonly reason: "permission-denied" | "unavailable" }
  >
> {}

export type WorkflowProgressOperationFailed =
  | WorkflowProgressPermanentOperationFailed
  | WorkflowProgressRateLimitedOperationFailed
  | WorkflowProgressRetryableOperationFailed;

export function workflowProgressOperationFailure(
  operation: WorkflowProgressOperationFailed["operation"],
  error: SurfaceOperationError,
): WorkflowProgressOperationFailed {
  switch (error._tag) {
    case "SurfaceOperationUnsupported":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "unsupported",
        message: error.message,
      });
    case "SurfaceInvalidInput":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "invalid-input",
        message: error.message,
      });
    case "SurfacePlatformMismatch":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "platform-mismatch",
        message: error.message,
      });
    case "SurfaceSessionMismatch":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "session-mismatch",
        message: error.message,
      });
    case "SurfaceMessageNotFound":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "not-found",
        message: error.message,
      });
    case "SurfacePermissionDenied":
      return new WorkflowProgressRetryableOperationFailed({
        operation,
        disposition: "retryable",
        reason: "permission-denied",
        message: error.message,
      });
    case "SurfaceRateLimited":
      return new WorkflowProgressRateLimitedOperationFailed({
        operation,
        disposition: "retryable",
        reason: "rate-limited",
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        message: error.message,
      });
    case "SurfaceUnavailable":
      return new WorkflowProgressRetryableOperationFailed({
        operation,
        disposition: "retryable",
        reason: "unavailable",
        message: error.message,
      });
    case "SurfaceOperationPartiallyCompleted":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "partial-outcome",
        message: error.message,
      });
  }
}

export type WorkflowProgressCheckFailure = {
  readonly kind: "failed";
  readonly error: WorkflowProgressOperationFailed;
};

export type WorkflowProgressSendFailure<P extends RegisteredSurfacePlatform> =
  | { readonly kind: "created"; readonly ref: MsgRefFor<P> }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

export type WorkflowProgressEditFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

export type WorkflowProgressMessageTarget = {
  readonly channelId: string;
  readonly messageId: string;
};

/** Workflow card content. Surfaces that render structured cards use `workflow`; others use the text. */
export type WorkflowProgressContent = ContentOpts & { readonly workflow?: WorkflowCard };

export type WorkflowProgressSendInput = {
  readonly channelId: string;
  readonly content: WorkflowProgressContent;
  readonly replyToMessageId?: string;
  readonly silent?: boolean;
};

export type SurfaceWorkflowProgressPort<P extends RegisteredSurfacePlatform> = {
  readonly configurationRevision: string;
  checkMessage(
    target: WorkflowProgressMessageTarget,
  ): Promise<ResultType<"found" | "missing", WorkflowProgressCheckFailure>>;
  send(
    input: WorkflowProgressSendInput,
  ): Promise<ResultType<MsgRefFor<P>, WorkflowProgressSendFailure<P>>>;
  edit(
    target: WorkflowProgressMessageTarget,
    content: WorkflowProgressContent,
  ): Promise<ResultType<void, WorkflowProgressEditFailure>>;
};

export type RegisteredSurfaceWorkflowProgressPort =
  SurfaceWorkflowProgressPort<RegisteredSurfacePlatform>;

export type SurfaceWorkflowProgressRegistration<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly protocol: SurfaceProtocolRouting<P>;
  readonly port: SurfaceWorkflowProgressPort<P>;
};

export type RegisteredSurfaceWorkflowProgressRegistration = {
  [P in RegisteredSurfacePlatform]: SurfaceWorkflowProgressRegistration<P>;
}[RegisteredSurfacePlatform];

export type SurfaceRuntimeHealthCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly impact?: "live" | "ready";
  readonly reason?: string;
  readonly details?: object;
};

export type SurfaceRuntimeHealthContribution = {
  readonly checks: readonly SurfaceRuntimeHealthCheck[];
  readonly info: object;
  readonly memoryDiagnostics?: object;
};

export type SurfaceRuntimeHealthPort = {
  getContribution(input: {
    readonly now: number;
    readonly runtimeFullyStarted: boolean;
    readonly includeMemoryDiagnostics: boolean;
  }): SurfaceRuntimeHealthContribution | Promise<SurfaceRuntimeHealthContribution>;
};

export type SurfaceRuntimeDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly protocol: SurfaceProtocolRouting<P>;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly health?: SurfaceRuntimeHealthPort;
  readonly createRelay?: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<P>;
  readonly createWorkflowProgress?: (
    guardedAdapter: SurfaceAdapter,
  ) => SurfaceWorkflowProgressPort<P>;
  readonly createQuestion?: (guardedAdapter: SurfaceAdapter) => SurfaceQuestionPort<P>;
  readonly createThreadControl?: (guardedAdapter: SurfaceAdapter) => SurfaceThreadControlPort;
};

export type RegisteredSurfaceRuntimeDescriptor = {
  [P in RegisteredSurfacePlatform]: SurfaceRuntimeDescriptor<P>;
}[RegisteredSurfacePlatform];

export type BoundSurfaceRuntimeDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly protocol: SurfaceProtocolRouting<P>;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly health?: SurfaceRuntimeHealthPort;
  readonly relay?: SurfaceRelayDescriptor<P>;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<P>;
  readonly question?: SurfaceQuestionPort<P>;
  readonly threadControl?: SurfaceThreadControlPort;
};

export type RegisteredBoundSurfaceRuntimeDescriptor = {
  [P in RegisteredSurfacePlatform]: BoundSurfaceRuntimeDescriptor<P>;
}[RegisteredSurfacePlatform];

type ResolvedSurfaceDescriptor<T> = T extends RegisteredBoundSurfaceRuntimeDescriptor
  ? Pick<T, "platform" | "protocol" | "adapter">
  : never;

type ResolvedSurfaceProtocolDescriptor<T> = T extends RegisteredBoundSurfaceRuntimeDescriptor
  ? Pick<T, "platform" | "protocol">
  : never;

export type ResolvedSurfaceAdapter =
  ResolvedSurfaceDescriptor<RegisteredBoundSurfaceRuntimeDescriptor>;

export type ResolvedSurfaceProtocol =
  ResolvedSurfaceProtocolDescriptor<RegisteredBoundSurfaceRuntimeDescriptor>;

export type ResolvedSurfaceQuestion = {
  [P in RegisteredSurfacePlatform]: {
    readonly platform: P;
    readonly protocol: SurfaceProtocolRouting<P>;
    readonly question: SurfaceQuestionPort<P>;
  };
}[RegisteredSurfacePlatform];

export type SurfaceProtocolResolver = {
  resolve(platform: AdapterPlatform): ResolvedSurfaceProtocol | null;
};

export type SurfaceAdapterResolver = {
  registeredPlatforms(): readonly RegisteredSurfacePlatform[];
  resolve(platform: AdapterPlatform): ResolvedSurfaceAdapter | null;
};

/** Resolves the thread-control port of the surface that started an agent run, when it has one. */
export type SurfaceThreadControlResolver = {
  resolve(platform: AdapterPlatform): SurfaceThreadControlPort | null;
};

export type SurfaceQuestionResolver = {
  entries(): readonly ResolvedSurfaceQuestion[];
  resolve(platform: AdapterPlatform): ResolvedSurfaceQuestion | null;
};

export class SurfaceRuntimeRegistrationDuplicate extends TaggedError(
  "SurfaceRuntimeRegistrationDuplicate",
)<{
  readonly platform: RegisteredSurfacePlatform;
  readonly message: string;
}> {}

function bindRuntimeDescriptor(
  descriptor: RegisteredSurfaceRuntimeDescriptor,
): RegisteredBoundSurfaceRuntimeDescriptor {
  const platform = descriptor.protocol.platform;
  const adapter = createDescriptorBoundSurfaceAdapter(platform, descriptor.adapter);
  const workflowProgress = descriptor.createWorkflowProgress?.(adapter);
  const question = descriptor.createQuestion?.(adapter);
  const threadControl = descriptor.createThreadControl?.(adapter);
  return {
    platform,
    protocol: descriptor.protocol,
    adapter,
    ...(descriptor.adapterIngress ? { adapterIngress: descriptor.adapterIngress } : {}),
    ...(descriptor.requestIngress ? { requestIngress: descriptor.requestIngress } : {}),
    ...(descriptor.health ? { health: descriptor.health } : {}),
    ...(descriptor.createRelay ? { relay: descriptor.createRelay(adapter) } : {}),
    ...(workflowProgress
      ? {
          workflowProgress: createDescriptorBoundWorkflowProgressPort(
            platform,
            workflowProgress as RegisteredSurfaceWorkflowProgressPort,
          ),
        }
      : {}),
    ...(question ? { question } : {}),
    ...(threadControl ? { threadControl } : {}),
  } as RegisteredBoundSurfaceRuntimeDescriptor;
}

export class SurfaceRuntimeRegistry {
  readonly #descriptors: readonly RegisteredBoundSurfaceRuntimeDescriptor[];
  readonly #byPlatform: ReadonlyMap<AdapterPlatform, RegisteredBoundSurfaceRuntimeDescriptor>;

  private constructor(descriptors: readonly RegisteredBoundSurfaceRuntimeDescriptor[]) {
    this.#descriptors = descriptors;
    this.#byPlatform = new Map<AdapterPlatform, RegisteredBoundSurfaceRuntimeDescriptor>(
      descriptors.map((descriptor) => [descriptor.platform, descriptor]),
    );
  }

  static create(
    descriptors: readonly RegisteredSurfaceRuntimeDescriptor[],
  ): ResultType<SurfaceRuntimeRegistry, SurfaceRuntimeRegistrationDuplicate> {
    const platforms = new Set<RegisteredSurfacePlatform>();
    for (const descriptor of descriptors) {
      const platform = descriptor.protocol.platform;
      if (platforms.has(platform)) {
        return Result.err(
          new SurfaceRuntimeRegistrationDuplicate({
            platform,
            message: `Surface runtime already registered for platform '${platform}'`,
          }),
        );
      }
      platforms.add(platform);
    }
    return Result.ok(new SurfaceRuntimeRegistry(descriptors.map(bindRuntimeDescriptor)));
  }

  entries(): readonly RegisteredBoundSurfaceRuntimeDescriptor[] {
    return this.#descriptors;
  }

  adapterResolver(): SurfaceAdapterResolver {
    const registeredPlatforms = this.#descriptors.map((descriptor) => descriptor.platform);
    return {
      registeredPlatforms: () => registeredPlatforms,
      resolve: (platform) => {
        const descriptor = this.#byPlatform.get(platform);
        if (!descriptor) return null;
        return {
          platform: descriptor.platform,
          protocol: descriptor.protocol,
          adapter: descriptor.adapter,
        } as ResolvedSurfaceAdapter;
      },
    };
  }

  protocolResolver(): SurfaceProtocolResolver {
    return {
      resolve: (platform) => {
        const descriptor = this.#byPlatform.get(platform);
        if (!descriptor) return null;
        return {
          platform: descriptor.platform,
          protocol: descriptor.protocol,
        } as ResolvedSurfaceProtocol;
      },
    };
  }

  threadControlResolver(): SurfaceThreadControlResolver {
    return {
      resolve: (platform) => this.#byPlatform.get(platform)?.threadControl ?? null,
    };
  }

  questionResolver(): SurfaceQuestionResolver {
    const entries = this.#descriptors
      .filter(
        (
          descriptor,
        ): descriptor is RegisteredBoundSurfaceRuntimeDescriptor & {
          readonly question: RegisteredSurfaceQuestionPort;
        } => descriptor.question !== undefined,
      )
      .map(
        (descriptor) =>
          ({
            platform: descriptor.platform,
            protocol: descriptor.protocol,
            question: descriptor.question,
          }) as ResolvedSurfaceQuestion,
      );
    const byPlatform = new Map<AdapterPlatform, ResolvedSurfaceQuestion>(
      entries.map((entry) => [entry.platform, entry]),
    );
    return {
      entries: () => entries,
      resolve: (platform) => byPlatform.get(platform) ?? null,
    };
  }

  async validateAdapterPlatforms(): Promise<void> {
    for (const descriptor of this.#descriptors) {
      await descriptor.adapter.getSelf();
    }
  }
}
