import { describe, expect, it } from "vitest";
import { botModelLimitsError } from "./bot-model-limits.js";

const stored = { modelMaxTokens: null, modelContextWindow: null };

describe("botModelLimitsError", () => {
  it("accepts an update that touches neither limit", () => {
    expect(botModelLimitsError(stored, {})).toBeNull();
  });

  it("accepts output below the window when both are sent", () => {
    expect(
      botModelLimitsError(stored, { modelMaxTokens: 16_384, modelContextWindow: 131_072 }),
    ).toBeNull();
  });

  it("rejects output at or above the window", () => {
    expect(
      botModelLimitsError(stored, { modelMaxTokens: 131_072, modelContextWindow: 131_072 }),
    ).toMatch(/less than the context window/);
  });

  it("checks a partial update against the stored value it keeps", () => {
    expect(
      botModelLimitsError(
        { modelMaxTokens: 32_768, modelContextWindow: 65_536 },
        { modelContextWindow: 16_384 },
      ),
    ).toMatch(/less than the context window/);
    expect(
      botModelLimitsError(
        { modelMaxTokens: 32_768, modelContextWindow: 65_536 },
        { modelMaxTokens: 8_192 },
      ),
    ).toBeNull();
  });

  it("lets a cleared window fall back to inherit, so the pair cannot conflict", () => {
    expect(
      botModelLimitsError(
        { modelMaxTokens: 32_768, modelContextWindow: 65_536 },
        { modelContextWindow: null },
      ),
    ).toBeNull();
  });
});
