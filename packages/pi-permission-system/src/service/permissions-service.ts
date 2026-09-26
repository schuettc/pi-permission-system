import type { AccessIntent } from "#src/access-intent/access-intent";
import { buildAccessIntentForSurface } from "#src/access-intent/input-normalizer";
import type { Authorizer } from "#src/authority/authorizer";
import type { AuthorizerRegistrar } from "#src/authority/authorizer-registry";
import type { OpenPromptRegistry } from "#src/authority/prompt-answerer-registry";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { PermissionsService, PromptAnswerer } from "#src/service";
import type {
  ToolAccessExtractor,
  ToolAccessExtractorLookup,
  ToolAccessExtractorRegistrar,
} from "#src/tool-input/tool-access-extractor-registry";
import type {
  ToolInputFormatter,
  ToolInputFormatterLookup,
  ToolInputFormatterRegistrar,
} from "#src/tool-input/tool-input-formatter-registry";
import type { PermissionCheckResult, PermissionState } from "#src/types";
import { resolveBashAdvisoryCheck } from "./bash-advisory-check";

/**
 * Resolution surface the service needs: answer a gate-style {@link AccessIntent}
 * (composing the session ruleset internally) and report a tool-level state.
 * `PermissionResolver` satisfies it.
 */
interface ResolverForService {
  resolve(intent: AccessIntent): PermissionCheckResult;
  getToolPermission(toolName: string, agentName?: string): PermissionState;
  isToolFullyDenied(toolName: string, agentName?: string): boolean;
}

/** Narrow session view: hands out the cwd-bound path normalizer. */
interface PathNormalizerProvider {
  getPathNormalizer(): PathNormalizer;
}

/**
 * The prompt-answerer authority the service consults per `answer`: the
 * operator's opt-in list, the showing-prompt registry, and a warn sink for the
 * once-per-name notice an unlisted answerer earns.
 */
export interface PromptAnswererDeps {
  /** The operator's `promptAnswerers` list, read live so a config edit applies. */
  getPromptAnswerers: () => string[];
  /** The node's showing-prompt registry, settled by an effective answer. */
  registry: OpenPromptRegistry;
  /** Warns once per unlisted answerer that its answer was inert. */
  warn: (message: string) => void;
}

/**
 * In-process implementation of the cross-extension {@link PermissionsService}.
 *
 * Constructed once in the composition root and backed by the single shared
 * `PermissionResolver` and `PermissionSession` that the gates also use — so
 * service queries and gate-path decisions see the same state. Path-shaped
 * surface queries route through the resolver as an `access-path` intent, so
 * they match the lexical aliases ∪ canonical (symlink-resolved) set the gates
 * do (#503); non-path surfaces stay on the `tool` intent.
 */
export class LocalPermissionsService implements PermissionsService {
  /** Unlisted answerer names already warned about, so the notice fires once. */
  private readonly warnedUnlistedAnswerers = new Set<string>();

  constructor(
    private readonly resolver: ResolverForService,
    private readonly session: PathNormalizerProvider,
    private readonly formatterRegistry: ToolInputFormatterRegistrar &
      ToolInputFormatterLookup,
    private readonly accessExtractorRegistry: ToolAccessExtractorRegistrar &
      ToolAccessExtractorLookup,
    private readonly authorizerRegistry: AuthorizerRegistrar,
    private readonly promptAnswerers: PromptAnswererDeps,
  ) {}

  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): ReturnType<PermissionsService["checkPermission"]> {
    // Bash decomposes at gate parity: a chained/nested command is split into
    // its command-pattern units and resolved most-restrictive, matching what
    // the enforcement gate enforces (#309). A cold parser falls back to the
    // whole-string match inside resolveBashAdvisoryCheck.
    if (surface === "bash") {
      return resolveBashAdvisoryCheck(value ?? "", agentName, this.resolver);
    }
    const intent = buildAccessIntentForSurface(
      surface,
      value,
      this.session.getPathNormalizer(),
      agentName,
    );
    return this.resolver.resolve(intent);
  }

  getToolPermission(
    toolName: string,
    agentName?: string,
  ): ReturnType<PermissionsService["getToolPermission"]> {
    return this.resolver.getToolPermission(toolName, agentName);
  }

  isToolFullyDenied(
    toolName: string,
    agentName?: string,
  ): ReturnType<PermissionsService["isToolFullyDenied"]> {
    return this.resolver.isToolFullyDenied(toolName, agentName);
  }

  registerToolInputFormatter(
    toolName: string,
    formatter: ToolInputFormatter,
  ): ReturnType<PermissionsService["registerToolInputFormatter"]> {
    return this.formatterRegistry.register(toolName, formatter);
  }

  registerToolAccessExtractor(
    toolName: string,
    extractor: ToolAccessExtractor,
  ): ReturnType<PermissionsService["registerToolAccessExtractor"]> {
    return this.accessExtractorRegistry.register(toolName, extractor);
  }

  getToolAccessExtractor(
    toolName: string,
  ): ReturnType<PermissionsService["getToolAccessExtractor"]> {
    // The origin is the gates' concern, not a caller's: this surface answers
    // the capability, and where it came from rides the gate's log context.
    return this.accessExtractorRegistry.resolve(toolName)?.extractor;
  }

  getToolInputFormatter(
    toolName: string,
  ): ReturnType<PermissionsService["getToolInputFormatter"]> {
    return this.formatterRegistry.get(toolName);
  }

  registerAuthorizer(
    name: string,
    authorize: Authorizer["authorize"],
  ): ReturnType<PermissionsService["registerAuthorizer"]> {
    return this.authorizerRegistry.register(name, authorize);
  }

  registerPromptAnswerer(name: string): PromptAnswerer {
    return {
      answer: (requestId, verdict) =>
        this.answerPrompt(name, requestId, verdict),
      dispose: () => {
        // Registration granted nothing (authority is the config's), so there
        // is nothing to unregister; clearing the warn latch lets a later
        // registration under the same name warn afresh.
        this.warnedUnlistedAnswerers.delete(name);
      },
    };
  }

  /**
   * Settle the showing prompt on behalf of `name`, gated by the config.
   *
   * An unlisted answerer decides nothing and is told once; a listed one's
   * answer settles the prompt through the registry, which returns `false` when
   * the prompt is already settled, was never shown, or is queued-not-yet-shown.
   */
  private answerPrompt(
    name: string,
    requestId: string,
    verdict: "allow" | "deny",
  ): boolean {
    if (!this.promptAnswerers.getPromptAnswerers().includes(name)) {
      if (!this.warnedUnlistedAnswerers.has(name)) {
        this.warnedUnlistedAnswerers.add(name);
        this.promptAnswerers.warn(
          `Prompt answerer '${name}' answered a permission prompt but is not ` +
            `listed in promptAnswerers; the answer was ignored. Add '${name}' ` +
            `to promptAnswerers to let it settle prompts.`,
        );
      }
      return false;
    }
    return this.promptAnswerers.registry.settle(requestId, verdict, name);
  }
}
