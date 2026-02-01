/**
 * Session entry schema with validation
 *
 * Provides typed parsing for session JSONL entries, replacing
 * fragile `any` type casting with proper schema validation.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// =============================================================================
// Content Block Schemas
// =============================================================================

/** Text content block in a message */
export const TextBlockSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});

export type TextBlock = Static<typeof TextBlockSchema>;

/** Content can be a string or array of content blocks */
export const MessageContentSchema = Type.Union([
  Type.String(),
  Type.Array(
    Type.Union([
      TextBlockSchema,
      // Allow other block types but don't extract text from them
      Type.Object({
        type: Type.String(),
      }),
    ]),
  ),
]);

export type MessageContent = Static<typeof MessageContentSchema>;

// =============================================================================
// Message Schema
// =============================================================================

/** Message roles we extract text from */
export const ExtractableRoleSchema = Type.Union([Type.Literal("user"), Type.Literal("assistant")]);

export type ExtractableRole = Static<typeof ExtractableRoleSchema>;

/** A message within a session entry */
export const SessionMessageSchema = Type.Object({
  role: Type.String(),
  content: Type.Optional(MessageContentSchema),
});

export type SessionMessage = Static<typeof SessionMessageSchema>;

// =============================================================================
// Session Entry Schema
// =============================================================================

/** A session JSONL entry with type="message" */
export const SessionEntrySchema = Type.Object({
  type: Type.Literal("message"),
  message: SessionMessageSchema,
});

export type SessionEntry = Static<typeof SessionEntrySchema>;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Parse a JSON line into a validated session entry
 *
 * @param line - Raw JSON string from session JSONL file
 * @returns Parsed session entry or null if invalid/not a message entry
 */
export function parseSessionEntry(line: string): SessionEntry | null {
  if (!line.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  // Quick type check before full validation
  if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "message") {
    return null;
  }

  // Validate against schema
  if (!Value.Check(SessionEntrySchema, parsed)) {
    return null;
  }

  return parsed;
}

/**
 * Check if a message role is extractable (user or assistant)
 */
export function isExtractableRole(role: string): role is ExtractableRole {
  return role === "user" || role === "assistant";
}

/**
 * Extract text content from a message content value
 *
 * @param content - Message content (string or array of blocks)
 * @returns Extracted text, normalized, or null if no text found
 */
export function extractTextFromContent(content: MessageContent | undefined): string | null {
  if (!content) {
    return null;
  }

  if (typeof content === "string") {
    const normalized = normalizeText(content);
    return normalized || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type !== "text") {
      continue;
    }
    // TypeScript knows this is a TextBlock due to the type check
    const textBlock = block as TextBlock;
    const normalized = normalizeText(textBlock.text);
    if (normalized) {
      parts.push(normalized);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(" ");
}

/**
 * Normalize text by collapsing whitespace
 */
function normalizeText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract all user/assistant messages from session content
 *
 * @param content - Raw session file content (JSONL format)
 * @returns Array of formatted messages like "User: ..." or "Assistant: ..."
 */
export function extractSessionMessages(content: string): string[] {
  const lines = content.split("\n");
  const messages: string[] = [];

  for (const line of lines) {
    const entry = parseSessionEntry(line);
    if (!entry) {
      continue;
    }

    const { message } = entry;
    if (!isExtractableRole(message.role)) {
      continue;
    }

    const text = extractTextFromContent(message.content);
    if (!text) {
      continue;
    }

    const label = message.role === "user" ? "User" : "Assistant";
    messages.push(`${label}: ${text}`);
  }

  return messages;
}

/**
 * Parse session content and return joined text for embedding
 *
 * @param content - Raw session file content (JSONL format)
 * @returns Combined text from all user/assistant messages
 */
export function parseSessionContent(content: string): string {
  return extractSessionMessages(content).join("\n");
}

/**
 * Parse an array of session lines (for delta processing)
 *
 * @param lines - Array of JSON lines from a session file
 * @returns Combined text from all user/assistant messages
 */
export function parseSessionLines(lines: string[]): string {
  const messages: string[] = [];

  for (const line of lines) {
    const entry = parseSessionEntry(line);
    if (!entry) {
      continue;
    }

    const { message } = entry;
    if (!isExtractableRole(message.role)) {
      continue;
    }

    const text = extractTextFromContent(message.content);
    if (!text) {
      continue;
    }

    const label = message.role === "user" ? "User" : "Assistant";
    messages.push(`${label}: ${text}`);
  }

  return messages.join("\n");
}
