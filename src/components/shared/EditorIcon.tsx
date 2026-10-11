import { SquareArrowOutUpRight } from "lucide-react";
import { EDITOR_OPTIONS } from "../../lib/editors";
import { useEditorStore } from "../../stores/useEditorStore";

/** The logo of the editor chosen in Settings, or a generic open icon. */
export default function EditorIcon({ size = 16 }: { size?: number }) {
  const editorId = useEditorStore((s) => s.settings.preferredEditor);
  const editor = EDITOR_OPTIONS.find((option) => option.id === editorId);
  if (!editor) return <SquareArrowOutUpRight size={size} aria-hidden="true" />;
  return <img src={editor.logoSrc} alt="" width={size} height={size} className={editor.logoClassName} />;
}
