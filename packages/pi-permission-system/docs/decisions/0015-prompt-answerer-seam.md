---
status: accepted
date: 2026-09-26
---

# 0015 — A prompt-answer seam for settling a showing prompt remotely

## Status

Accepted.

## Context

A companion surface (a phone, driven by `pi-hail`) needs to answer the same permission prompt the operator sees on the Mac, so an ask can be approved or denied from either place.

The first attempt put `pi-hail` in the `authorizerChain`.
There it held each ask and drew its own dialog, which broke three things at once: it intercepted the capped-allow asks that `pi-auto-review` defers for auto-confirm, so every capped allow became a manual click; it suppressed `permissions:ui_prompt`, so the tmux bell and 🔐 key stopped firing; and its "More options…" produced a second dialog that also bypassed the per-session `AskDialogAdmission` queue, so concurrent asks could stack.

The lesson is that a second decider drawing a second dialog is the wrong shape.
The permission system already owns the one dialog, holds the inline component's `done` callback inside `presentInlinePermissionPrompt`, and serializes presentations through `AskDialogAdmission`.
Only it can settle its own dialog cleanly.

## Decision

Add a **prompt-answer seam**: a way to settle a prompt that is already on screen, owned by the extension that drew it.

1. **Open-prompt registry, per node.**
   `OpenPromptRegistry` records `{ requestId, settle }` when `LocalUserAuthorizer` shows a prompt — right where `permissions:ui_prompt` is emitted, so a queued-not-yet-shown ask has no entry and cannot be answered remotely — and unregisters on every resolution path.
   One instance per factory invocation, like `AskDialogQueue`.

2. **Settlement seam in the dispatcher.**
   `requestPermissionDecision` funnels the human producer and a remote producer through one first-wins settlement.
   The TUI branch tears the inline dialog down by invoking its captured `done`; the `select`/`input` fallback threads an `AbortSignal` and aborts the pending select.
   With no seam supplied the behavior is byte-for-byte the original single-dialog path.

3. **Opt-in service API.**
   `PermissionsService.registerPromptAnswerer(name): PromptAnswerer`, where `PromptAnswerer` is `{ answer(requestId, verdict): boolean; dispose(): void }`.
   Registration grants no authority: `answer` is effective only when `name` is listed in the new `promptAnswerers` config key, the opt-in mirror of `authorizerChain`.
   An unlisted answerer's `answer` returns `false` and is logged once; the first answer wins, later answers return `false`.

4. **Answerer provenance.**
   A remote answer resolves with `decidedBy: { kind: "answerer", name }`, a new `DecisionSource` variant.
   It flows the normal path: `permissions:decision` carries the new resolutions `answerer_approved` / `answerer_denied` and a new required `decidedBy` field; the review log records the answerer's name; the agent-facing denial names it ("Denied from '…'").

5. **Auto-confirm and queueing are untouched.**
   `pi-auto-review`'s auto-confirm still wraps the dialog; whichever of it and a remote answer settles first wins, the other a no-op on a resolved promise.
   `AskDialogAdmission` still serializes, so only the shown prompt is ever answerable.

## Consequences

- `PermissionDecisionEvent` gains a required `decidedBy: DecisionSource`; every emit site already had the decider in hand.
  Consumers reading the event now learn what decided it, which is how `pi-hail` distinguishes a phone answer from a Mac one.
- The runtime-interop symbol `Symbol.for("@gotgenes/pi-permission-system:session-services")` is left verbatim, so a consumer compiled against the upstream package still resolves the same process-global slot.
- The seam is offered upstream to `gotgenes/pi-packages`; it adds a capability the permission system lacked (settling a showing prompt) rather than working around its absence.
