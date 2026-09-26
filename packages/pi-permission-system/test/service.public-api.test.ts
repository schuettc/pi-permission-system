import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeFakePermissionsService } from "#test/helpers/service-fixtures";

// ── the registerPromptAnswerer public surface ───────────────────────────────

describe("PermissionsService.registerPromptAnswerer", () => {
  it("is a function that returns an answer/dispose capability", () => {
    const service = makeFakePermissionsService();
    expect(typeof service.registerPromptAnswerer).toBe("function");

    const answerer = service.registerPromptAnswerer("pi-hail");
    expect(typeof answerer.answer).toBe("function");
    expect(typeof answerer.dispose).toBe("function");
  });
});

// ── runtime-interop invariant ───────────────────────────────────────────────

describe("session-services symbol", () => {
  it("keys the process-global service map on the unchanged upstream literal", () => {
    // pi-auto-review is compiled against @gotgenes/pi-permission-system and
    // resolves the same global slot only while this literal is left verbatim;
    // renaming it under the fork would silently split the map (Task 1.1, §Release).
    const source = readFileSync(
      fileURLToPath(new URL("../src/service.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain(
      'Symbol.for(\n  "@gotgenes/pi-permission-system:session-services",\n)',
    );
  });
});
