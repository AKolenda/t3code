import { NonNegativeInt, ProviderSessionStartInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// The adapter validates its native target. Keep the original cursor until the
// checkpoint revert commits so retries never derive a new relative boundary.
export const ConversationRollbackPlan = Schema.Struct({
  source: ProviderSessionStartInput,
  numTurns: NonNegativeInt,
  target: Schema.Unknown,
});
export type ConversationRollbackPlan = typeof ConversationRollbackPlan.Type;
