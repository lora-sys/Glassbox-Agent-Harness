// apps/server/src/codex/decode.ts
// Decodes a raw JSON-RPC notification into a typed CodexEvent.
// Returns a Promise of CodexEvent (async) or throws Error/SchemaError on failure.
//
// Effect Schema adds value at the provider boundary:
//   - Structural validation of wire payloads with typed errors
//   - Unknown methods produce a typed Error (not a raw TypeError)
//   - Type-safe field access downstream via the CodexEvent discriminated union

import { Effect, Schema } from "effect";
import type { CodexEvent } from "./schema.js";
import { METHOD_TAG, TAG_SCHEMA } from "./schema.js";

/**
 * Decode a raw JSON-RPC notification into a typed CodexEvent.
 *
 * @param raw - the full notification object `{ method, params }`
 * @returns Promise<CodexEvent>
 * @throws {Schema.SchemaError} if params fail structural validation (typed failure)
 * @throws {Error} if the method is not recognized
 */
export async function decodeEvent(
  raw: unknown
): Promise<CodexEvent> {
  // Phase 1: validate the envelope shape
  const envelopeSchema = Schema.Struct({
    method: Schema.String,
    params: Schema.Struct({}), // accept any object-shaped params
  });

  const envelope = Schema.decodeUnknownEffect(envelopeSchema)(raw);

  return Effect.runPromise(
    Effect.flatMap(envelope, ({ method, params }) => {
      // Phase 2: dispatch to the correct schema by method → tag
      const tag = METHOD_TAG.get(method);
      if (!tag) {
        return Effect.fail(
          new Error(`Unrecognized notification method: "${method}"`) as Schema.SchemaError
        );
      }
      const eventSchema = TAG_SCHEMA.get(tag);
      if (!eventSchema) {
        return Effect.fail(
          new Error(`No schema registered for event tag: "${tag}"`) as Schema.SchemaError
        );
      }

      // Phase 3: decode with the tag-aware Schema.Union catalog.
      // We pass the full tagged object directly to the Union schema so it
      // dispatches on _tag without hand-written augmentation.
      const taggedInput = { ...(params as object), _tag: tag };
      return Schema.decodeUnknownEffect(eventSchema as Schema.Schema<unknown>)(
        taggedInput
      ) as Effect.Effect<CodexEvent>;
    })
  );
}
