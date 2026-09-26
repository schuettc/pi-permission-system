import { describe, expect, it, vi } from "vitest";
import { OpenPromptRegistry } from "#src/authority/prompt-answerer-registry";

describe("OpenPromptRegistry", () => {
  it("settles a registered prompt once and reports success", () => {
    const registry = new OpenPromptRegistry();
    const settle = vi.fn();
    registry.register("req-1", settle);

    expect(registry.settle("req-1", "allow", "pi-hail")).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("allow", "pi-hail");
  });

  it("reports failure for a second answer (first answer wins)", () => {
    const registry = new OpenPromptRegistry();
    const settle = vi.fn();
    registry.register("req-1", settle);

    expect(registry.settle("req-1", "allow", "pi-hail")).toBe(true);
    expect(registry.settle("req-1", "deny", "pi-hail")).toBe(false);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("reports failure for an unknown request id", () => {
    const registry = new OpenPromptRegistry();
    expect(registry.settle("missing", "allow", "pi-hail")).toBe(false);
  });

  it("stops answering a prompt once its registration is disposed", () => {
    const registry = new OpenPromptRegistry();
    const settle = vi.fn();
    const dispose = registry.register("req-1", settle);

    dispose();

    expect(registry.settle("req-1", "allow", "pi-hail")).toBe(false);
    expect(settle).not.toHaveBeenCalled();
  });

  it("only removes its own entry when disposing after a re-registration", () => {
    const registry = new OpenPromptRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = registry.register("req-1", first);
    // A later ask reuses the id (minted ids are unique in production, but the
    // compare-and-delete guard keeps a stale disposer from evicting a live
    // entry).
    registry.register("req-1", second);

    disposeFirst();

    expect(registry.settle("req-1", "deny", "pi-hail")).toBe(true);
    expect(second).toHaveBeenCalledWith("deny", "pi-hail");
    expect(first).not.toHaveBeenCalled();
  });
});
