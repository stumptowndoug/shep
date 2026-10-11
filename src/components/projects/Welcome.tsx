import { useEffect, useState } from "react";
import { FolderGit2, FolderPlus, Plus } from "lucide-react";
import type { FolderSuggestion } from "../../lib/types";
import { checkCommandExists, suggestProjectFolders } from "../../lib/tauri";
import { abbreviateHome, formatRelativeTime } from "../../lib/projectTree";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import shepMark from "../../assets/shep-mark.svg";

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

interface WelcomeProps {
  onAddFolder: (path: string) => void;
  onChooseFolder: () => void;
}

/**
 * First run: what a project is, which agents Shep found, and repos the user
 * already works in with their agents, each one click to add.
 */
export default function Welcome({ onAddFolder, onChooseFolder }: WelcomeProps) {
  const [suggestions, setSuggestions] = useState<FolderSuggestion[] | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  // One-time load when the welcome screen mounts.
  useEffect(() => {
    let cancelled = false;
    suggestProjectFolders(5)
      .then((result) => { if (!cancelled) setSuggestions(result); })
      .catch(() => { if (!cancelled) setSuggestions([]); });
    Promise.all(CODING_ASSISTANTS.map((assistant) =>
      checkCommandExists(assistant.command).then((found) => (found ? assistant.id : null)).catch(() => null),
    )).then((ids) => { if (!cancelled) setInstalled(ids.filter((id): id is string => id !== null)); });
    return () => { cancelled = true; };
  }, []);

  const foundAgents = CODING_ASSISTANTS.filter((assistant) => installed?.includes(assistant.id));

  return (
    <div className="page page--narrow welcome">
      <header className="page__heading">
        <img src={shepMark} alt="" className="welcome__mark" />
        <h1 className="page__title">Welcome to Shep.</h1>
        <p className="page__lede">
          Shep runs your coding agents and terminals side by side. Start by adding a project: any folder you work in,
          usually a git repo. Shep remembers it and opens agents there. It doesn’t change your files.
        </p>
      </header>

      {suggestions && suggestions.length > 0 && (
        <section className="page__section">
          <label className="page__label">Recently used with your agents</label>
          <ul className="welcome__list">
            {suggestions.map((folder) => (
              <li key={folder.path} className="welcome__row">
                <FolderGit2 size={16} className="welcome__row-icon" aria-hidden="true" />
                <span className="welcome__row-body">
                  <span className="welcome__row-name">{folder.name}</span>
                  <span className="welcome__row-meta">
                    {abbreviateHome(folder.path)} · {AGENT_NAMES[folder.agent] ?? folder.agent}, {formatRelativeTime(folder.lastUsed).toLowerCase()}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-secondary welcome__add"
                  disabled={adding !== null}
                  onClick={() => {
                    setAdding(folder.path);
                    onAddFolder(folder.path);
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                  {adding === folder.path ? "Adding…" : "Add"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="page__section">
        <button type="button" className="btn-primary welcome__choose" onClick={onChooseFolder}>
          <FolderPlus size={14} aria-hidden="true" />
          {suggestions && suggestions.length > 0 ? "Choose another folder…" : "Choose a folder…"}
        </button>
      </section>

      {installed && (
        <section className="page__section welcome__agents">
          <label className="page__label">Agents found</label>
          {foundAgents.length > 0 ? (
            <div className="welcome__agent-list">
              {foundAgents.map((assistant) => (
                <span key={assistant.id} className="welcome__agent">
                  {assistantLogoSrc[assistant.id] && (
                    <img src={assistantLogoSrc[assistant.id]} alt="" width={16} height={16} className={getAssistantLogoClass(assistant.id)} />
                  )}
                  {assistant.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="page__note">
              No agent CLIs found yet. After adding a project, New tab shows how to set one up.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
