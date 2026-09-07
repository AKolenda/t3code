import { isMany, none, type Many } from "stream-chain/defs.js";
import { Assembler } from "stream-json/core/assembler.js";
import { filter } from "stream-json/core/filters/filter.js";
import * as StreamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

// These are the fields consumed by TranscriptRecord. Never assemble tool
// outputs, image data, or compacted replacement histories just to discard them.
const HISTORY_FIELDS =
  /^(?:type|timestamp|cwd|sessionId|aiTitle|isSidechain|isMeta|isCompactSummary|message\.(?:role|model|content(?:\.\d+\.(?:type|text))?)|payload\.(?:id|session_id|type|role|message|model|cwd|content\.\d+\.(?:type|text)|internal_chat_message_metadata_passthrough\.turn_id))$/;

export class TranscriptJsonLimitError extends Error {}

/**
 * Project a single JSONL record without materializing unselected string values.
 * The caller supplies a shared allocation budget for the entire transcript.
 * Budget exhaustion rejects the transcript, never a message within it.
 */
export function createTranscriptJsonReader(reserve: (bytes: number) => void) {
  // The synchronous tokenizer is exported at runtime in 3.6.0, but omitted
  // from its bundled types. Unlike parser(), it does not wrap tokens in an
  // async generator; the file reader already supplies backpressure and UTF-8.
  const { jsonParser } = StreamJson as typeof StreamJson & {
    jsonParser: (
      options: ParserOptions,
    ) => (input: string | typeof none) => Many<Token> | typeof none;
  };
  const tokenize = jsonParser({ packValues: false });
  const select = filter({ filter: HISTORY_FIELDS, streamKeys: false }) as (
    input: Token | typeof none,
  ) => Token | Many<Token> | typeof none;
  const assembler = new Assembler();
  let key: string | null = null;
  let keyTooLong = false;
  let value = "";
  let depth = 0;
  let complete = false;
  let malformed = false;

  const assemble = (token: Token) => {
    reserve(
      64 + ("value" in token && typeof token.value === "string" ? token.value.length * 2 : 0),
    );
    switch (token.name) {
      case "startString":
      case "startNumber":
        value = "";
        break;
      case "stringChunk":
      case "numberChunk":
        value += token.value;
        break;
      case "endString":
        assembler.consume({ name: "stringValue", value });
        value = "";
        break;
      case "endNumber":
        assembler.consume({ name: "numberValue", value });
        value = "";
        break;
      default:
        assembler.consume(token);
    }
  };
  const selectToken = (token: Token | typeof none) => {
    const selected = select(token);
    if (selected === none) return;
    if (isMany(selected)) {
      for (const item of selected.values) assemble(item);
    } else {
      assemble(selected);
    }
  };
  const consume = (input: string | typeof none) => {
    if (malformed) return;
    try {
      const tokens = tokenize(input);
      if (tokens === none) return;
      for (const token of tokens.values) {
        if (token.name === "startObject" || token.name === "startArray") {
          if (++depth > 128)
            throw new TranscriptJsonLimitError("Transcript JSON nesting exceeds 128 levels");
        } else if (token.name === "endObject" || token.name === "endArray") {
          if (--depth === 0) complete = true;
        }
        // Keys are streamed too. Unknown arbitrarily long property names must
        // not become allocations; none of the selected names exceeds 256 chars.
        if (token.name === "startKey") {
          key = "";
          keyTooLong = false;
        } else if (token.name === "stringChunk" && key !== null) {
          if (!keyTooLong && key.length + token.value.length <= 256) key += token.value;
          else keyTooLong = true;
        } else if (token.name === "endKey") {
          selectToken({ name: "keyValue", value: keyTooLong ? "\0unselected" : (key ?? "") });
          key = null;
        } else {
          selectToken(token);
        }
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Parser ")) {
        malformed = true;
      } else {
        throw cause;
      }
    }
  };
  return {
    write: (chunk: string) => consume(chunk),
    finish: (): unknown => {
      consume(none);
      if (malformed || !complete) return undefined;
      selectToken(none);
      return assembler.done ? assembler.current : undefined;
    },
  };
}
