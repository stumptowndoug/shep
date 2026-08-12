import claudeSrc from "../../assets/claude.svg";
import codexSrc from "../../assets/openai.svg";
import geminiSrc from "../../assets/gemini.svg";
import opencodeSrc from "../../assets/opencode-logo-dark.svg";
import piSrc from "../../assets/pi.svg";
import grokSrc from "../../assets/grok.svg";

export const assistantLogoSrc: Record<string, string> = {
  claude: claudeSrc,
  codex: codexSrc,
  gemini: geminiSrc,
  // Antigravity is Gemini CLI's successor; reuse the Gemini mark until an official asset lands
  antigravity: geminiSrc,
  opencode: opencodeSrc,
  pi: piSrc,
  grok: grokSrc,
};

const MONO_ASSISTANT_LOGOS = new Set(["codex", "opencode", "pi", "grok"]);

export function getAssistantLogoClass(assistantId: string): string | undefined {
  return MONO_ASSISTANT_LOGOS.has(assistantId) ? "themed-mono-logo" : undefined;
}
