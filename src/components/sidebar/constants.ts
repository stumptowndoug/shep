import type { CodingAssistant } from "../../lib/types";

export const CODING_ASSISTANTS: CodingAssistant[] = [
  {
    id: "claude", name: "Claude Code", command: "claude", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model",
    acp: {
      command: "claude-agent-acp", args: [], install: "npm i -g @agentclientprotocol/claude-agent-acp", managed: "claude",
      setupNote: "Installs Claude’s chat adapter inside Shep with npm. Needs Node.js.", setupAction: "Install chat adapter",
    },
  },
  {
    id: "codex", name: "Codex", command: "codex", yoloFlag: "--dangerously-bypass-approvals-and-sandbox", modelFlag: "--model",
    acp: {
      command: "codex-acp", args: [], install: "npm i -g @agentclientprotocol/codex-acp", managed: "codex",
      setupNote: "Installs Codex’s chat adapter inside Shep with npm. Needs Node.js.", setupAction: "Install chat adapter",
    },
  },
  {
    id: "cursor", name: "Cursor", command: "cursor-agent", yoloFlag: "--yolo", modelFlag: "--model",
    acp: { command: "cursor-agent", args: ["acp"], install: "Included with Cursor CLI", authMethodId: "cursor_login" },
  },
  {
    id: "antigravity", name: "Antigravity", command: "agy", yoloFlag: "--dangerously-skip-permissions", modelFlag: "--model",
    acp: { command: "agy_acp_server.par", args: [], install: "Google’s Antigravity chat runtime", managed: "antigravity", authMethodId: "oauth-personal",
      standalone: true, setupNote: "Downloads Google’s chat runtime. Sign in with your Google account when you start a chat.", setupAction: "Install chat runtime",
    },
  },
  {
    id: "opencode", name: "Open Code", command: "opencode", yoloFlag: "--auto", modelFlag: "--model",
    acp: { command: "opencode", args: ["acp"], install: "Included with opencode" },
  },
  {
    id: "pi", name: "pi", command: "pi", yoloFlag: null, modelFlag: "--model",
    acp: {
      command: "pi-acp", args: [], install: "npm i -g pi-acp", managed: "pi",
      setupNote: "Installs pi’s chat adapter inside Shep with npm. Needs Node.js.", setupAction: "Install chat adapter",
    },
  },
  {
    id: "muse", name: "Muse Code", command: "muse", yoloFlag: "--yolo", modelFlag: "--model",
    acp: {
      command: "muse-acp", args: [], install: "npm i -g @brokkai/muse-acp", managed: "muse",
      setupNote: "Installs a community chat adapter for Muse inside Shep with npm. Needs Node.js 22 or newer.", setupAction: "Install chat adapter",
    },
  },
];

export const ASSISTANT_INSTALL_URLS: Record<string, string> = {
  claude: "https://code.claude.com/docs/en",
  codex: "https://github.com/openai/codex",
  cursor: "https://cursor.com/docs/cli/overview",
  antigravity: "https://github.com/google-antigravity/antigravity-cli",
  opencode: "https://opencode.ai/",
  pi: "https://pi.dev/",
  muse: "https://dev.meta.ai/products/muse-code",
};
