import { describe, expect, it } from "vitest";
import {
  parseSessionEntry,
  isExtractableRole,
  extractTextFromContent,
  extractSessionMessages,
  parseSessionContent,
} from "./session-entry-schema.js";

describe("parseSessionEntry", () => {
  it("parses valid message entry with string content", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: "Hello, world!",
      },
    });

    const result = parseSessionEntry(line);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("message");
    expect(result?.message.role).toBe("user");
    expect(result?.message.content).toBe("Hello, world!");
  });

  it("parses valid message entry with array content", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello!" },
          { type: "text", text: "How can I help?" },
        ],
      },
    });

    const result = parseSessionEntry(line);
    expect(result).not.toBeNull();
    expect(result?.message.role).toBe("assistant");
    expect(Array.isArray(result?.message.content)).toBe(true);
  });

  it("returns null for empty line", () => {
    expect(parseSessionEntry("")).toBeNull();
    expect(parseSessionEntry("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSessionEntry("not json")).toBeNull();
    expect(parseSessionEntry("{broken")).toBeNull();
  });

  it("returns null for non-message type", () => {
    const line = JSON.stringify({
      type: "tool_use",
      tool: { name: "test" },
    });
    expect(parseSessionEntry(line)).toBeNull();
  });

  it("returns null for missing message field", () => {
    const line = JSON.stringify({
      type: "message",
    });
    expect(parseSessionEntry(line)).toBeNull();
  });

  it("returns null for invalid message structure", () => {
    const line = JSON.stringify({
      type: "message",
      message: "not an object",
    });
    expect(parseSessionEntry(line)).toBeNull();
  });
});

describe("isExtractableRole", () => {
  it("returns true for user role", () => {
    expect(isExtractableRole("user")).toBe(true);
  });

  it("returns true for assistant role", () => {
    expect(isExtractableRole("assistant")).toBe(true);
  });

  it("returns false for system role", () => {
    expect(isExtractableRole("system")).toBe(false);
  });

  it("returns false for tool role", () => {
    expect(isExtractableRole("tool")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isExtractableRole("")).toBe(false);
  });
});

describe("extractTextFromContent", () => {
  it("extracts from string content", () => {
    expect(extractTextFromContent("Hello, world!")).toBe("Hello, world!");
  });

  it("normalizes whitespace in string content", () => {
    expect(extractTextFromContent("Hello\n\n  world!")).toBe("Hello world!");
  });

  it("returns null for empty string", () => {
    expect(extractTextFromContent("")).toBeNull();
    expect(extractTextFromContent("   ")).toBeNull();
  });

  it("extracts from text blocks array", () => {
    const content = [
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ];
    expect(extractTextFromContent(content)).toBe("First Second");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", text: "World" },
    ];
    expect(extractTextFromContent(content)).toBe("Hello World");
  });

  it("returns null for empty array", () => {
    expect(extractTextFromContent([])).toBeNull();
  });

  it("returns null for array with no text blocks", () => {
    const content = [{ type: "image", url: "http://example.com/img.png" }];
    expect(extractTextFromContent(content)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractTextFromContent(undefined)).toBeNull();
  });

  it("handles mixed content with empty text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "   " },
      { type: "text", text: "World" },
    ];
    expect(extractTextFromContent(content)).toBe("Hello World");
  });
});

describe("extractSessionMessages", () => {
  it("extracts user and assistant messages", () => {
    const content = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "Hi there!" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const messages = extractSessionMessages(content);
    expect(messages).toEqual(["User: Hello", "Assistant: Hi there!"]);
  });

  it("ignores system messages", () => {
    const content = [
      { type: "message", message: { role: "system", content: "You are helpful" } },
      { type: "message", message: { role: "user", content: "Hello" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const messages = extractSessionMessages(content);
    expect(messages).toEqual(["User: Hello"]);
  });

  it("ignores non-message entries", () => {
    const content = [
      { type: "tool_use", tool: { name: "test" } },
      { type: "message", message: { role: "user", content: "Hello" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const messages = extractSessionMessages(content);
    expect(messages).toEqual(["User: Hello"]);
  });

  it("handles empty lines", () => {
    const content = [
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
      "",
      "   ",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Hi!" } }),
    ].join("\n");

    const messages = extractSessionMessages(content);
    expect(messages).toEqual(["User: Hello", "Assistant: Hi!"]);
  });

  it("skips messages without content", () => {
    const content = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const messages = extractSessionMessages(content);
    expect(messages).toEqual(["User: Hello"]);
  });

  it("handles invalid JSON lines gracefully", () => {
    const content = [
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Hi!" } }),
    ].join("\n");

    const messages = extractSessionMessages(content);
    expect(messages).toEqual(["User: Hello", "Assistant: Hi!"]);
  });

  it("returns empty array for empty content", () => {
    expect(extractSessionMessages("")).toEqual([]);
  });
});

describe("parseSessionContent", () => {
  it("joins messages with newlines", () => {
    const content = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "Hi!" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const result = parseSessionContent(content);
    expect(result).toBe("User: Hello\nAssistant: Hi!");
  });

  it("returns empty string for no valid messages", () => {
    const content = JSON.stringify({ type: "tool_use", tool: {} });
    expect(parseSessionContent(content)).toBe("");
  });
});
