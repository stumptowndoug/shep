import type { CodingAssistant } from "../../lib/types";

export const CODING_ASSISTANTS: CodingAssistant[] = [
  { id: "claude", name: "Claude Code", command: "claude", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model" },
  { id: "codex", name: "Codex", command: "codex", yoloFlag: "--yolo", modelFlag: "--model" },
  { id: "cursor", name: "Cursor", command: "cursor-agent", yoloFlag: "--yolo", modelFlag: "--model" },
  { id: "antigravity", name: "Antigravity", command: "agy", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model" },
  { id: "opencode", name: "Open Code", command: "opencode", yoloFlag: "--auto", modelFlag: "--model" },
  { id: "pi", name: "pi", command: "pi", yoloFlag: null, modelFlag: "--model" },
];

export const ASSISTANT_INSTALL_URLS: Record<string, string> = {
  claude: "https://code.claude.com/docs/en",
  codex: "https://github.com/openai/codex",
  cursor: "https://cursor.com/docs/cli/overview",
  antigravity: "https://github.com/google-antigravity/antigravity-cli",
  opencode: "https://opencode.ai/",
  pi: "https://pi.dev/",
};
