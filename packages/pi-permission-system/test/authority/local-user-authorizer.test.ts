import { describe, expect, it, vi } from "vitest";
import { AskDialogQueue } from "#src/authority/ask-dialog-queue";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import { OpenPromptRegistry } from "#src/authority/prompt-answerer-registry";
import { DECIDED_BY_HUMAN } from "#test/helpers/decision-fixtures";
import {
  makePromptDetails,
  makePromptPayload,
} from "#test/helpers/prompt-details-fixtures";
import { makePromptPreferences } from "#test/helpers/prompt-view-fixtures";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * This file's semantic defaults over the shared structural fixture: several
 * cases assert `agentName` and `toolName` on a no-override call.
 */
function makeDetails(
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  return makePromptDetails({
    requestId: "req-123",
    agentName: "test-agent",
    toolName: "read",
    ...overrides,
  });
}

/** A `PermissionPromptUi` double; the tool-expansion accessors go unused here. */
function makePromptUi() {
  return {
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

/**
 * A `PermissionEventBus` double. `onEmit` observes the emission without
 * replacing it, so a test that cares about emit-versus-present ordering can
 * still build its deps through {@link makeDeps}.
 */
function makeEvents(onEmit?: () => void) {
  return {
    emit: vi.fn(() => {
      onEmit?.();
    }),
    on: vi.fn().mockReturnValue(() => undefined),
  };
}

/** Drain every pending microtask, so a queued presentation has had its turn. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const APPROVED: PermissionPromptDecision = {
  approved: true,
  state: "approved",
  decidedBy: DECIDED_BY_HUMAN,
};

function makeDeps(
  overrides: {
    events?: ReturnType<typeof makeEvents>;
    dialogs?: AskDialogQueue;
    requestPermissionDecision?: typeof requestPermissionDecision;
  } = {},
) {
  const events = overrides.events ?? makeEvents();
  const dialogs = overrides.dialogs ?? new AskDialogQueue();
  const ui = makePromptUi();
  const decisionFn =
    overrides.requestPermissionDecision ??
    vi.fn<typeof requestPermissionDecision>().mockResolvedValue({
      approved: true,
      state: "approved",
      decidedBy: DECIDED_BY_HUMAN,
    });
  return {
    deps: {
      ui,
      mode: "tui" as const,
      events,
      dialogs,
      getPromptPreferences: () => makePromptPreferences(),
      requestPermissionDecision: decisionFn,
    },
    events,
    dialogs,
    ui,
    decisionFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LocalUserAuthorizer", () => {
  it("emits a UI prompt event with normalized surface and value", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        toolName: "bash",
        command: "git push",
        toolInputPreview: "git push",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      agentName: "test-agent",
      request: makePromptPayload().request,
      forwarding: null,
    });
  });

  it("normalizes skill prompt events to the skill surface", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        source: "skill_input",
        toolName: undefined,
        skillName: "deploy-helper",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "skill_input",
      surface: "skill",
      value: "deploy-helper",
      agentName: "test-agent",
      request: makePromptPayload().request,
      forwarding: null,
    });
  });

  it("calls requestPermissionDecision with the threaded view, title, and payload", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);
    const details = makeDetails();

    await authorizer.authorize(details);

    expect(decisionFn).toHaveBeenCalledWith(
      { mode: "tui", ui, ...makePromptPreferences() },
      "Permission Required",
      details.payload,
      undefined,
    );
  });

  it("passes the sessionLabel option when present", async () => {
    const { deps, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({ sessionLabel: "Yes, for 'read' tool" }),
    );

    expect(decisionFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      { sessionLabel: "Yes, for 'read' tool" },
    );
  });

  it("emits the UI event before calling requestPermissionDecision", async () => {
    const calls: string[] = [];
    const decisionFn = vi.fn<typeof requestPermissionDecision>(() => {
      calls.push("dialog");
      return Promise.resolve({
        approved: true,
        state: "approved",
        decidedBy: DECIDED_BY_HUMAN,
      });
    });
    const { deps } = makeDeps({
      events: makeEvents(() => {
        calls.push("emit");
      }),
      requestPermissionDecision: decisionFn,
    });
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(makeDetails());

    expect(calls).toEqual(["emit", "dialog"]);
  });

  describe("forwarded provenance", () => {
    it("emits a non-degraded forwarded event with populated forwarding and the child's display projection", async () => {
      const { deps, events } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          source: "tool_call",
          agentName: "Explore",
          surface: "bash",
          value: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
        requestId: "req-123",
        source: "tool_call",
        surface: "bash",
        value: "git push",
        agentName: "Explore",
        request: makePromptPayload().request,
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });
    });

    it("uses the '(Subagent)' dialog title when the ask is forwarded", async () => {
      const { deps, ui, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);
      const details = makeDetails({
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });

      await authorizer.authorize(details);

      expect(decisionFn).toHaveBeenCalledWith(
        { mode: "tui", ui, ...makePromptPreferences() },
        "Permission Required (Subagent)",
        details.payload,
        undefined,
      );
    });

    it("offers a sessionScope when the forwarded ask carries a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: { grants: [{ surface: "bash", pattern: "git *" }] },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required (Subagent)",
        expect.anything(),
        {
          sessionScope: {
            subagentLabel: "This subagent ('Explore') only",
            servingSessionLabel:
              'The whole session — allow bash "git *" for parent and all subagents',
          },
        },
      );
    });

    it("names every path in the scope label when the ask covers several", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "cat /outside/a.ts > /elsewhere/b.ts",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: {
            grants: [
              { surface: "external_directory_read", pattern: "/outside/*" },
              { surface: "external_directory_write", pattern: "/elsewhere/*" },
            ],
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          sessionScope: expect.objectContaining({
            servingSessionLabel:
              "The whole session — allow external_directory 2 paths for parent and all subagents",
          }),
        }),
      );
    });

    it("offers no sessionScope for a forwarded ask without a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        undefined,
      );
    });
  });

  describe("both-directions session grant (#813)", () => {
    /** Assert the options a bash ask with these grants reaches the dialog with. */
    async function expectOptionsFor(
      grants: { surface: string; pattern: string }[],
      expected: unknown,
    ) {
      const { deps, decisionFn } = makeDeps();
      await new LocalUserAuthorizer(deps).authorize(
        makeDetails({ toolName: "bash", sessionApproval: { grants } }),
      );
      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        expected,
      );
    }

    it("offers the width option when every grant proves one direction", async () => {
      await expectOptionsFor(
        [{ surface: "external_directory_write", pattern: "/tmp/*" }],
        {
          sessionLabel: 'Yes, allow writes to "/tmp/*" for this session',
          sessionWidth: {
            label: 'Yes, allow reads and writes to "/tmp/*" for this session',
          },
        },
      );
    });

    it("counts the paths when several grants prove the same direction", async () => {
      await expectOptionsFor(
        [
          { surface: "external_directory_read", pattern: "/outside/a/*" },
          { surface: "external_directory_read", pattern: "/outside/b/*" },
        ],
        {
          sessionLabel: "Yes, allow reads to 2 paths for this session",
          sessionWidth: {
            label: "Yes, allow reads and writes to 2 paths for this session",
          },
        },
      );
    });

    it("offers no width option when the grants prove different directions", async () => {
      await expectOptionsFor(
        [
          { surface: "external_directory_read", pattern: "/outside/a/*" },
          { surface: "external_directory_write", pattern: "/outside/b/*" },
        ],
        undefined,
      );
    });

    it("offers no width option for a non-directional surface", async () => {
      await expectOptionsFor(
        [{ surface: "bash", pattern: "git *" }],
        undefined,
      );
    });

    it("offers no width option for an ask with no suggestion at all", async () => {
      const { deps, decisionFn } = makeDeps();
      await new LocalUserAuthorizer(deps).authorize(makeDetails());
      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        undefined,
      );
    });
  });

  it("returns the decision from requestPermissionDecision", async () => {
    const decision: PermissionPromptDecision = {
      approved: false,
      state: "denied",
      decidedBy: DECIDED_BY_HUMAN,
    };
    const { deps } = makeDeps({
      requestPermissionDecision: vi
        .fn<typeof requestPermissionDecision>()
        .mockResolvedValue(decision),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    const result = await authorizer.authorize(makeDetails());

    expect(result).toEqual(decision);
  });

  describe("one dialog at a time", () => {
    /**
     * A pair of asks whose first dialog stays open until the test answers it,
     * so "the second one has not been shown yet" is observable.
     */
    function makeOverlappingAsks() {
      const open = Promise.withResolvers<PermissionPromptDecision>();
      const decisionFn = vi
        .fn<typeof requestPermissionDecision>()
        .mockReturnValueOnce(open.promise)
        .mockResolvedValue(APPROVED);
      const { deps, events, dialogs } = makeDeps({
        requestPermissionDecision: decisionFn,
      });
      const authorizer = new LocalUserAuthorizer(deps);
      return {
        decisionFn,
        events,
        dialogs,
        answerFirst: () => {
          open.resolve(APPROVED);
        },
        first: authorizer.authorize(makeDetails()),
        second: authorizer.authorize(makeDetails()),
      };
    }

    it("does not present a second ask while the first dialog is open", async () => {
      const asks = makeOverlappingAsks();
      await settleMicrotasks();

      expect(asks.decisionFn).toHaveBeenCalledTimes(1);

      asks.answerFirst();
      await expect(asks.first).resolves.toEqual(APPROVED);
      await expect(asks.second).resolves.toEqual(APPROVED);
      expect(asks.decisionFn).toHaveBeenCalledTimes(2);
    });

    it("announces the second ask only when its dialog is presented", async () => {
      const asks = makeOverlappingAsks();
      await settleMicrotasks();

      expect(asks.events.emit).toHaveBeenCalledTimes(1);

      asks.answerFirst();
      await asks.first;
      await settleMicrotasks();

      expect(asks.events.emit).toHaveBeenCalledTimes(2);
      await asks.second;
    });

    it("answers a released ask as an unanswered denial", async () => {
      const asks = makeOverlappingAsks();
      await settleMicrotasks();

      asks.dialogs.releaseAll("the session ended");

      await expect(asks.first).resolves.toEqual({
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        denialReason: "the session ended",
        decidedBy: { kind: "unavailable", reason: "the session ended" },
      });
      await expect(asks.second).resolves.toEqual({
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
        denialReason: "the session ended",
        decidedBy: { kind: "unavailable", reason: "the session ended" },
      });
    });
  });

  describe("prompt-answer seam", () => {
    /**
     * A `requestPermissionDecision` double that never settles on its own but
     * exposes the seam's `settleRemotely` to the test, so a registry answer is
     * the only thing that can resolve the ask.
     */
    function remoteOnlyDecisionFn() {
      const decisionFn = vi.fn<typeof requestPermissionDecision>(
        (_view, _title, _payload, _options, seam) =>
          new Promise<PermissionPromptDecision>((resolve) => {
            seam?.onPrompt({ settleRemotely: resolve });
          }),
      );
      return { decisionFn };
    }

    it("registers the showing prompt so an answerer can settle it", async () => {
      const registry = new OpenPromptRegistry();
      const { decisionFn } = remoteOnlyDecisionFn();
      const { deps } = makeDeps({ requestPermissionDecision: decisionFn });
      const authorizer = new LocalUserAuthorizer({ ...deps, registry });

      const result = authorizer.authorize(makeDetails());
      await settleMicrotasks();

      // The prompt is registered only once it is actually on screen.
      expect(registry.settle("req-123", "allow", "pi-hail")).toBe(true);
      await expect(result).resolves.toEqual({
        approved: true,
        state: "approved",
        decidedBy: { kind: "answerer", name: "pi-hail" },
      });
    });

    it("attributes a remote denial to the answerer, not the user", async () => {
      const registry = new OpenPromptRegistry();
      const { decisionFn } = remoteOnlyDecisionFn();
      const { deps } = makeDeps({ requestPermissionDecision: decisionFn });
      const authorizer = new LocalUserAuthorizer({ ...deps, registry });

      const result = authorizer.authorize(makeDetails());
      await settleMicrotasks();
      registry.settle("req-123", "deny", "pi-hail");

      await expect(result).resolves.toEqual({
        approved: false,
        state: "denied",
        decidedBy: { kind: "answerer", name: "pi-hail" },
      });
    });

    it("unregisters the prompt once the human answered", async () => {
      const registry = new OpenPromptRegistry();
      const decisionFn = vi.fn<typeof requestPermissionDecision>(
        (_view, _title, _payload, _options, seam) => {
          // Register through the seam, then resolve as the human would.
          seam?.onPrompt({ settleRemotely: () => undefined });
          return Promise.resolve(APPROVED);
        },
      );
      const { deps } = makeDeps({ requestPermissionDecision: decisionFn });
      const authorizer = new LocalUserAuthorizer({ ...deps, registry });

      await authorizer.authorize(makeDetails());

      // The finally disposed the registration, so a late answer is a no-op.
      expect(registry.settle("req-123", "allow", "pi-hail")).toBe(false);
    });

    it("unregisters the prompt when the session releases it", async () => {
      // A release settles the ask's *outer* run promise while the host's dialog
      // promise stays pending forever, so the disposer must hang off that outer
      // settle \u2014 otherwise the entry lingers and a shutdown-time answer
      // returns a misleading `true`.
      const registry = new OpenPromptRegistry();
      const { decisionFn } = remoteOnlyDecisionFn();
      const { deps, dialogs } = makeDeps({
        requestPermissionDecision: decisionFn,
      });
      const authorizer = new LocalUserAuthorizer({ ...deps, registry });

      const result = authorizer.authorize(makeDetails());
      await settleMicrotasks();

      dialogs.releaseAll("the session ended");
      await settleMicrotasks();

      // The release disposed the registration: no entry, and a late answer is a
      // no-op rather than a misleading success.
      expect(registry.settle("req-123", "allow", "pi-hail")).toBe(false);
      await expect(result).resolves.toMatchObject({
        approved: false,
        confirmationUnavailable: true,
      });
    });

    it("leaves the dialog the only path when no registry is wired", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(makeDetails());

      // Backwards-compatible call shape: no seam argument is passed.
      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.anything(),
        undefined,
      );
    });
  });
});
