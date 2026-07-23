import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT_FILES = [
  "system_prompt.md",
  "answer_policy.md",
  "source_policy.md",
  "examples.md",
] as const;

export type PromptBundle = {
  instructions: string;
  version: string;
  files: readonly string[];
};

let cached: PromptBundle | null = null;

export function loadPromptBundle(): PromptBundle {
  if (cached) return cached;
  const contents = PROMPT_FILES.map((file) =>
    readFileSync(join(process.cwd(), "prompts", file), "utf8").trim(),
  );
  const instructions = contents.join("\n\n---\n\n");
  const hash = createHash("sha256").update(instructions).digest("hex").slice(0, 12);
  cached = {
    instructions,
    version: process.env.TAX_PROMPT_VERSION || `tax-policy-${hash}`,
    files: PROMPT_FILES,
  };
  return cached;
}
