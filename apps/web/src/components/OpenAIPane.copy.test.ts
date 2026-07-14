import { describe, expect, it } from "vitest";
import * as openAIPane from "./OpenAIPane.js";

const copy = openAIPane as unknown as {
  OPENAI_CHAT_TITLE?: string;
  OPENAI_CHAT_WARNING?: string;
  OPENAI_CHAT_EMPTY_HINT?: string;
  OPENAI_CHAT_DISABLED_EXPLANATION?: string;
};

describe("OpenAI Chat quarantine copy", () => {
  it("labels the surface as development-only", () => {
    expect(copy.OPENAI_CHAT_TITLE).toBe("OpenAI Chat — development only");
  });

  it("keeps the chat-only and local-tool warning persistent", () => {
    expect(copy.OPENAI_CHAT_WARNING).toBe(
      "Chat-only experiment. This is not Codex. Local tools are disabled.",
    );
  });

  it("does not advertise bash or local tool execution in the empty-state hint", () => {
    expect(copy.OPENAI_CHAT_EMPTY_HINT).toBeTypeOf("string");
    expect(copy.OPENAI_CHAT_EMPTY_HINT).not.toMatch(/\bbash\b|read_file|write_file/i);
  });

  it("explains the development-only opt-in and bearer-auth requirements", () => {
    expect(copy.OPENAI_CHAT_DISABLED_EXPLANATION).toBeTypeOf("string");
    expect(copy.OPENAI_CHAT_DISABLED_EXPLANATION).toMatch(/development.?only/i);
    expect(copy.OPENAI_CHAT_DISABLED_EXPLANATION).toMatch(
      /DEVHUB_ENABLE_OPENAI_CHAT=1/,
    );
    expect(copy.OPENAI_CHAT_DISABLED_EXPLANATION).toMatch(/access token|bearer/i);
  });
});
