import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildDirectionalSessionLabels,
  buildForwardedScopeLabels,
  describeGrantTarget,
} from "#src/presentation/pattern-suggest";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/service/permission-events";
import { buildUiPrompt } from "#src/service/permission-ui-prompt";
import { provenDirectionOf } from "#src/session/approval-grant";
import type { AskDialogAdmission } from "./ask-dialog-queue";
import type { TerminalAuthorizer } from "./authorizer";
import type { DecisionSource } from "./decision-source";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "./permission-dialog";
import type {
  PermissionPromptUi,
  PromptPreferences,
  requestPermissionDecision,
} from "./permission-prompt-component";
import type { PromptPermissionDetails } from "./permission-prompter";
import type { OpenPromptRegistry } from "./prompt-answerer-registry";

/** Dependencies required by {@link LocalUserAuthorizer}. */
export interface LocalUserAuthorizerDeps {
  /** The active session's UI surface (select/input plus the inline `custom` dialog). */
  ui: PermissionPromptUi;
  /** The session run mode; the dispatcher renders the inline dialog only in `"tui"`. */
  mode: ExtensionContext["mode"];
  /** Event bus used for the `permissions:ui_prompt` broadcast. */
  events: PermissionEventBus;
  /** Serializes this session's dialogs so no ask replaces another (#965). */
  dialogs: AskDialogAdmission;
  /** Read live at prompt time so a settings-modal toggle takes effect on the next prompt. */
  getPromptPreferences: () => PromptPreferences;
  /** Injected for testability; production callers pass the real function. */
  requestPermissionDecision: typeof requestPermissionDecision;
  /**
   * The node's open-prompt registry, when the answerer seam is wired.
   *
   * When present, a showing prompt is registered under its `requestId` so a
   * listed prompt answerer can settle it remotely, and unregistered on every
   * resolution path. Absent leaves the dialog the only way to answer -- the
   * fail-safe default, and what keeps the many tests that never exercise the
   * seam calling `requestPermissionDecision` with its original arguments.
   */
  registry?: OpenPromptRegistry;
}

/**
 * Authorizer for a session with an active UI: prompt the human here.
 *
 * Emits the `permissions:ui_prompt` broadcast (moved here from
 * `PermissionPrompter`'s `ctx.hasUI` arm) before showing the dialog, so
 * observers know a decision is imminent. This is the single emit site: a
 * forwarded ask carries its provenance on `details.forwarding`, which this
 * class renders (populated `forwarding` context + "(Subagent)" title) so the
 * broadcast stays non-degraded (#292) without a second emission path.
 *
 * Every ask goes through the session's `AskDialogAdmission`, because the host
 * holds one inline dialog slot: a second presentation mounts over the first and
 * strands its promise (#965).
 */
export class LocalUserAuthorizer implements TerminalAuthorizer {
  constructor(private readonly deps: LocalUserAuthorizerDeps) {}

  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    // The registry disposer is hung off the *outer* run promise, not the inner
    // `present()` one: a release settles the outer promise while the host's own
    // dialog promise (what `present()` awaits) is left pending forever, so a
    // `.finally` on the inner promise would never run and the entry would stay
    // registered — letting a shutdown-time `answer()` return a misleading
    // `true`. Disposing on the outer settle covers the human, remote, and
    // release paths alike.
    let dispose: (() => void) | undefined;
    const decision = this.deps.dialogs.run(
      () =>
        this.present(details, (disposer) => {
          dispose = disposer;
        }),
      unansweredDecision,
    );
    return decision.finally(() => dispose?.());
  }

  /**
   * Announce the imminent prompt, then show it.
   *
   * Both live inside the queued region: `permissions:ui_prompt` is documented
   * as firing immediately before the user-facing UI is invoked, so an emit at
   * admission would alert a notification consumer for a dialog that is still
   * minutes of deliberation away.
   */
  private present(
    details: PromptPermissionDetails,
    captureDispose: (dispose: () => void) => void,
  ): Promise<PermissionPromptDecision> {
    emitUiPromptEvent(this.deps.events, buildUiPrompt(details));
    const view = {
      mode: this.deps.mode,
      ui: this.deps.ui,
      ...this.deps.getPromptPreferences(),
    };
    const title = details.forwarding
      ? "Permission Required (Subagent)"
      : "Permission Required";
    const options = buildRequestOptions(details);
    const registry = this.deps.registry;
    if (!registry) {
      return this.deps.requestPermissionDecision(
        view,
        title,
        details.payload,
        options,
      );
    }
    // Register the showing prompt so a listed answerer can settle it, and
    // unregister on every resolution path. The registration happens as the
    // dialog goes on screen (`onPrompt`), never at admission, so a queued ask
    // has no entry to answer (section 4 of the design).
    return this.deps.requestPermissionDecision(
      view,
      title,
      details.payload,
      options,
      {
        onPrompt: (control) => {
          captureDispose(
            registry.register(details.requestId, (verdict, answererName) =>
              control.settleRemotely(answererDecision(verdict, answererName)),
            ),
          );
        },
      },
    );
  }
}

/**
 * The decision a remote answerer's verdict becomes: an approve-once or a plain
 * deny, stamped with the answerer as its decider so the resolution reads
 * `answerer_approved` / `answerer_denied` and the review log and agent-facing
 * denial name it (#726). A remote answer never scopes a session grant -- that
 * choice stays on the Mac dialog (section 3 of the design).
 */
function answererDecision(
  verdict: "allow" | "deny",
  answererName: string,
): PermissionPromptDecision {
  const decidedBy: DecisionSource = { kind: "answerer", name: answererName };
  return verdict === "allow"
    ? { approved: true, state: "approved", decidedBy }
    : { approved: false, state: "denied", decidedBy };
}

/**
 * The answer an ask gets when the session released it before a human ruled.
 *
 * Mirrors `ParentAuthorizer`'s abandonment: `confirmationUnavailable` keeps it
 * out of the "User denied" family, since a user who was never asked denied
 * nothing (#719), and the agent-facing reason and the provenance record reuse
 * one string so what the model is told and what the log attributes cannot
 * drift (#726).
 */
function unansweredDecision(reason: string): PermissionPromptDecision {
  return {
    approved: false,
    state: "denied",
    confirmationUnavailable: true,
    denialReason: reason,
    decidedBy: { kind: "unavailable", reason },
  };
}

/**
 * The dialog options this ask offers, composed from three independent groups.
 *
 * The label names what the session grant covers (a gate-supplied one, or one
 * derived from the grants themselves for a path ask). An ask whose grants all
 * prove the same direction additionally offers the both-directions width
 * (#813). A forwarded ask additionally offers the scope choice (subagent vs
 * whole session).
 *
 * They compose rather than exclude: a forwarded path ask offers all three, and
 * an ask that qualifies for none passes `undefined` so the dialog keeps its
 * defaults.
 */
function buildRequestOptions(
  details: PromptPermissionDetails,
): RequestPermissionOptions | undefined {
  const grants = details.sessionApproval?.grants ?? [];
  const direction = provenDirectionOf(grants);
  const widths = direction
    ? buildDirectionalSessionLabels(direction, describeGrantTarget(grants))
    : null;
  const sessionLabel = widths?.sessionLabel ?? details.sessionLabel;

  const options: RequestPermissionOptions = {
    ...(sessionLabel ? { sessionLabel } : {}),
    ...(widths ? { sessionWidth: { label: widths.widenedLabel } } : {}),
    ...(details.forwarding && grants.length > 0
      ? {
          sessionScope: buildForwardedScopeLabels(
            details.forwarding.requesterAgentName,
            grants,
          ),
        }
      : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}
