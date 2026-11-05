import type { UpdateBotInput } from "@rakazo/contracts";
import { modelOutputLeavesInputRoom } from "@rakazo/contracts";

/**
 * Why a bot's model limits cannot be saved, or null when they can. A partial
 * update is checked against the stored value it keeps, since the contract only
 * sees both fields when the client sends both.
 */
export function botModelLimitsError(
  existing: { modelMaxTokens: number | null; modelContextWindow: number | null },
  input: Pick<UpdateBotInput, "modelMaxTokens" | "modelContextWindow">,
): string | null {
  if (input.modelMaxTokens === undefined && input.modelContextWindow === undefined) return null;
  const maxTokens =
    input.modelMaxTokens !== undefined ? input.modelMaxTokens : existing.modelMaxTokens;
  const contextWindow =
    input.modelContextWindow !== undefined ? input.modelContextWindow : existing.modelContextWindow;
  return modelOutputLeavesInputRoom(maxTokens, contextWindow ?? undefined)
    ? null
    : "Maximum output tokens must be less than the context window";
}
