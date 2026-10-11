import { useState, useEffect, useRef, useMemo } from "react";
import type { AgentInterface, CodingAssistant, ProjectActionKind, SessionMode } from "../../lib/types";
import tabKindMeta from "../../lib/tabKindMeta";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import { checkCommandExists, getModelsForProvider, installManagedAcpAdapter, revealInFinder } from "../../lib/tauri";
import { chatAdapterAvailable } from "../../lib/acp/adapters";
import { getErrorMessage } from "../../lib/errors";
import { useRepoStore } from "../../stores/useRepoStore";
import { usePiConfigStore } from "../../stores/usePiConfigStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { ArrowRight, Check, Copy, Download, FolderOpen, Info, MessageSquare, SquareTerminal, X } from "lucide-react";
import { getEditorLabel } from "../../lib/editors";
import EditorIcon from "../shared/EditorIcon";
import { useEditorStore } from "../../stores/useEditorStore";
import { useNoticeStore } from "../../stores/useNoticeStore";
import Select from "../shared/Select";
import OptionGroup from "../shared/OptionGroup";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { ASSISTANT_INSTALL_URLS } from "../sidebar/constants";

/** The other things a project can open, below the agents. */
const OPEN_ACTIONS: { kind: Exclude<ProjectActionKind, "assistant">; description: string }[] = [
  { kind: "terminal", description: "A shell here" },
  { kind: "commands", description: "Servers and scripts" },
  { kind: "git", description: "Changed files" },
  { kind: "todos", description: "Project TODO.md" },
];

interface SessionLauncherProps {
  /** Open a non-agent tab (terminal, commands, files, to-dos) in place of this page. */
  onOpen: (action: Exclude<ProjectActionKind, "assistant">) => void;
  /** Open the project in the preferred editor (or ask for one). */
  onOpenInEditor: () => void;
  /** Run a setup command (e.g. an adapter install) in a new terminal tab. */
  onRunInTerminal: (script: string, label: string) => void;
  onStartSession: (
    assistantId: string,
    mode: SessionMode,
    agentInterface: AgentInterface,
    model?: string,
  ) => Promise<boolean>;
}

export default function SessionLauncher({ onStartSession, onRunInTerminal, onOpen, onOpenInEditor }: SessionLauncherProps) {
  const editorLabel = getEditorLabel(useEditorStore((s) => s.settings.preferredEditor));
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const defaultAgentMode = useProjectSettingsStore((s) => s.settings.defaultAgentMode);
  const defaultAgentInterface = useProjectSettingsStore((s) => s.settings.defaultAgentInterface);

  const [selectedAssistant, setSelectedAssistant] = useState<CodingAssistant | null>(null);
  const selectedAssistantRef = useRef<string | null>(null);
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [chatAvailable, setChatAvailable] = useState<Record<string, boolean>>({});
  const [installPopover, setInstallPopover] = useState<string | null>(null);
  // Explicit picks override the project defaults for this launch only.
  const [modeOverride, setMode] = useState<SessionMode | null>(null);
  const [interfaceOverride, setAgentInterface] = useState<AgentInterface | null>(null);
  const mode = modeOverride ?? defaultAgentMode;
  const [launching, setLaunching] = useState(false);
  const [installingAdapter, setInstallingAdapter] = useState<string | null>(null);
  const [adapterError, setAdapterError] = useState<{ assistantId: string; message: string } | null>(null);

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelFetchStatus, setModelFetchStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const modelRequestRef = useRef(0);

  const piConfig = usePiConfigStore((s) => s.config);
  const piHasLoaded = usePiConfigStore((s) => s.hasLoaded);
  const piSaving = usePiConfigStore((s) => s.isSaving);
  const piError = usePiConfigStore((s) => s.error);
  const loadPiConfig = usePiConfigStore((s) => s.loadConfig);
  const updatePiSettings = usePiConfigStore((s) => s.updateSettings);
  const setPiApiKey = usePiConfigStore((s) => s.setApiKey);
  const removePiApiKey = usePiConfigStore((s) => s.removeApiKey);
  const [selectedPiProvider, setSelectedPiProvider] = useState<string | null>(null);
  const [piKeyInputs, setPiKeyInputs] = useState({ provider: "", key: "" });
  const [piInfoOpen, setPiInfoOpen] = useState(false);

  // Check which assistants (and their chat adapters) are installed
  useEffect(() => {
    let cancelled = false;
    const exists = (command: string) => checkCommandExists(command).catch(() => false);
    (async () => {
      const cli: Record<string, boolean> = {};
      const chat: Record<string, boolean> = {};
      await Promise.all(
        CODING_ASSISTANTS.map(async (a) => {
          const [hasCli, hasChat] = await Promise.all([
            exists(a.command),
            a.acp ? chatAdapterAvailable(a.acp) : Promise.resolve(false),
          ]);
          cli[a.id] = hasCli;
          chat[a.id] = hasChat;
        }),
      );
      if (!cancelled) {
        setAvailable(cli);
        setChatAvailable(chat);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Close install popover on outside click
  useEffect(() => {
    if (!installPopover) return;
    const handleClick = () => setInstallPopover(null);
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setInstallPopover(null); };
    document.addEventListener("keydown", handleKeyDown);
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [installPopover]);

  // Close pi info popover on outside click
  useEffect(() => {
    if (!piInfoOpen) return;
    const handleClick = () => setPiInfoOpen(false);
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [piInfoOpen]);

  const modelChoices = useMemo(() => {
    let models = availableModels;
    if (selectedAssistant?.id === "pi" && selectedPiProvider) {
      models = models.filter((m) => m.startsWith(`${selectedPiProvider}/`));
    }
    return [{ value: "", label: "Default" }, ...models.map((model) => ({ value: model, label: model }))];
  }, [availableModels, selectedAssistant, selectedPiProvider]);

  const supportsModelSelection = (id: string) => id !== "pi" && id !== "opencode";
  const supportsMode = (id: string) => id !== "pi";
  const canChat = Boolean(selectedAssistant?.acp && chatAvailable[selectedAssistant.id]);
  const canTerminal = !selectedAssistant || available[selectedAssistant.id] !== false;
  const agentInterface: AgentInterface = !canTerminal && selectedAssistant?.acp?.managed ? "chat"
    : canChat ? interfaceOverride ?? defaultAgentInterface : "terminal";
  const chatUnavailableReason = selectedAssistant?.acp
    ? "Chat adapter not installed"
    : `Chat isn’t available for ${selectedAssistant?.name ?? "this agent"} in Shep yet.`;

  const handleSelectAssistant = (assistant: CodingAssistant) => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    setSelectedAssistant(assistant);
    selectedAssistantRef.current = assistant.id;
    setAdapterError(null);
    setSelectedModel(null);
    setSelectedPiProvider(null);
    setAvailableModels([]);
    if (assistant.id === "pi" && !piHasLoaded) void loadPiConfig();
    if (!supportsModelSelection(assistant.id)) {
      setModelFetchStatus("idle");
      return;
    }
    setModelFetchStatus("loading");
    getModelsForProvider(assistant.id)
      .then((models) => {
        if (modelRequestRef.current !== requestId) return;
        setAvailableModels(models);
        setModelFetchStatus("loaded");
      })
      .catch((error) => {
        if (modelRequestRef.current !== requestId) return;
        if (import.meta.env.DEV) {
          console.error(`Failed to load models for ${assistant.id}:`, error);
        }
        setAvailableModels([]);
        setModelFetchStatus("error");
      });
  };

  useEffect(() => {
    if (selectedAssistant?.id !== "pi" || !piHasLoaded) return;
    setSelectedPiProvider(piConfig.settings.defaultProvider ?? null);
  }, [piConfig.settings.defaultProvider, piHasLoaded, selectedAssistant?.id]);

  const handleSelectPiProvider = async (provider: string) => {
    const next = selectedPiProvider === provider ? null : provider;
    const previous = selectedPiProvider;
    setSelectedPiProvider(next);
    setSelectedModel(null);
    try {
      await updatePiSettings({ defaultProvider: next, defaultModel: null });
    } catch {
      setSelectedPiProvider(previous);
    }
  };

  const handleAddPiKey = async () => {
    const { provider, key } = piKeyInputs;
    if (!provider.trim() || !key.trim()) return;
    const providerId = provider.trim();
    try {
      await setPiApiKey(providerId, key.trim());
      await updatePiSettings({ defaultProvider: providerId, defaultModel: null });
      setPiKeyInputs({ provider: "", key: "" });
      setSelectedPiProvider(providerId);
    } catch {
      // The store keeps the error message; leave inputs intact for correction.
    }
  };

  const handleRemovePiProvider = async (provider: string) => {
    try {
      await removePiApiKey(provider);
      const nextDefault = selectedPiProvider === provider ? null : selectedPiProvider;
      if (piConfig.settings.defaultProvider === provider) {
        await updatePiSettings({ defaultProvider: null, defaultModel: null });
      }
      setSelectedPiProvider(nextDefault);
    } catch {
      // Error is surfaced below from the store.
    }
  };

  const handleStart = async () => {
    if (!selectedAssistant || !activeRepoPath || launching) return;
    setLaunching(true);

    // Chat sessions pick their model in the composer, from the agent's own list.
    const started = await onStartSession(
      selectedAssistant.id,
      mode,
      agentInterface,
      agentInterface === "terminal" ? selectedModel ?? undefined : undefined,
    );
    if (!started) {
      setLaunching(false);
    }
  };

  const supportsYolo = selectedAssistant?.yoloFlag != null;
  const projectName = activeRepoPath?.split("/").filter(Boolean).pop() ?? null;
  const [copied, setCopied] = useState(false);

  const copyInstall = (command: string) => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const setUpChat = (assistant: CodingAssistant) => {
    if (!assistant.acp) return;
    if (assistant.acp.managed) {
      if (installingAdapter) return;
      setAdapterError(null);
      setInstallingAdapter(assistant.id);
      void installManagedAcpAdapter(assistant.acp.managed).then(() => {
        setChatAvailable(current => ({ ...current, [assistant.id]: true }));
        if (selectedAssistantRef.current === assistant.id) setAgentInterface("chat");
      }).catch(error => setAdapterError({ assistantId: assistant.id, message: getErrorMessage(error) }))
        .finally(() => setInstallingAdapter(null));
      return;
    }
    const script = [
      `echo "Installing ${assistant.name}'s chat adapter"`,
      `echo "+ ${assistant.acp.install}"`,
      `${assistant.acp.install} && echo && echo "Done. Open a new tab again and choose Chat."`,
      'exec "$SHELL" -l',
    ].join("; ");
    onRunInTerminal(script, `Set up ${assistant.name}`);
  };

  return (
    <div className="page page--narrow launcher">
      <header className="page__heading">
        {projectName && <div className="page__eyebrow">{projectName}</div>}
        <h1 className="page__title">{selectedAssistant ? `Start ${selectedAssistant.name}.` : "Start."}</h1>
        <p className="page__lede">
          {selectedAssistant
            ? "Choose how it runs, then start the session. Click the card again to pick something else."
            : "Start an agent, or open something else for this project."}
        </p>
      </header>

      {/* Agent Picker */}
      <div className="page__section">
        <label className="page__label">Agent</label>
        <div className="agent-grid" role="group" aria-label="Choose an agent">
          {CODING_ASSISTANTS.map((assistant) => {
            const logoUrl = assistantLogoSrc[assistant.id];
            const isAvailable = available[assistant.id] !== false || Boolean(assistant.acp?.managed);
            const logoClassName = [getAssistantLogoClass(assistant.id), !isAvailable ? "logo-unavailable" : null]
              .filter(Boolean)
              .join(" ");
            const isSelected = selectedAssistant?.id === assistant.id;
            const installUrl = ASSISTANT_INSTALL_URLS[assistant.id];
            const showPopover = installPopover === assistant.id;
            return (
              <div key={assistant.id} className="relative">
                <button
                  className={`agent-choice ${isSelected ? "selected" : ""} ${!isAvailable ? "unavailable" : ""}`}
                  aria-pressed={isSelected}
                  aria-label={`${assistant.name}${!isAvailable ? " · not installed" : ""}`}
                  onClick={() => {
                    if (isSelected) {
                      // A second click backs out, bringing the other choices back.
                      setSelectedAssistant(null);
                      selectedAssistantRef.current = null;
                    } else if (isAvailable) {
                      handleSelectAssistant(assistant);
                      setInstallPopover(null);
                    } else {
                      setInstallPopover(showPopover ? null : assistant.id);
                    }
                  }}
                >
                  {logoUrl && <img src={logoUrl} alt="" width={22} height={22} className={logoClassName || undefined} />}
                  <span className="agent-choice__body">
                    <span className="agent-choice__name">{assistant.name}</span>
                    <span className="agent-choice__meta">{!isAvailable ? "Set up agent"
                      : chatAvailable[assistant.id] ? available[assistant.id] === false ? "Chat" : "Chat & terminal"
                        : available[assistant.id] === false ? "Set up chat" : "Terminal"}</span>
                  </span>
                  {isSelected && <Check size={15} className="agent-choice__check" />}
                </button>
                {showPopover && installUrl && (
                  <div
                    className="popover absolute left-0 top-full mt-2 !p-3 text-xs"
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{ minWidth: 220 }}
                  >
                    <p className="mb-2" style={{ color: "var(--muted)" }}>
                      <strong style={{ color: "var(--fg)" }}>{assistant.name}</strong> isn’t installed.
                    </p>
                    <code className="inline-code select-all">{installUrl}</code>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Description + docs link for selected assistant */}
      {selectedAssistant && (selectedAssistant.description || selectedAssistant.docsUrl) && (
        <div className="page__section page__note">
          {selectedAssistant.description && (
            <p className="leading-relaxed">{selectedAssistant.description}</p>
          )}
          {selectedAssistant.docsUrl && (
            <a
              href={selectedAssistant.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block underline decoration-dotted"
              style={{ color: "var(--accent)" }}
            >
              Docs →
            </a>
          )}
        </div>
      )}

      {/* Pi provider picker */}
      {selectedAssistant?.id === "pi" && (
        <div className="page__section">
          <div className="flex items-center gap-1.5 mb-3 relative">
            <label className="page__label !m-0">Provider</label>
            <button
              type="button"
              onClick={() => setPiInfoOpen((o) => !o)}
              className="opacity-40 hover:opacity-70 transition-opacity"
              style={{ lineHeight: 0 }}
            >
              <Info size={12} />
            </button>
            {piInfoOpen && (
              <div
                className="popover absolute left-0 top-full mt-1 !p-3 text-xs leading-relaxed"
                style={{ minWidth: 260, color: "var(--muted)" }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <p className="mb-1"><strong style={{ color: "var(--text-primary)" }}>API keys are stored securely in macOS Keychain</strong></p>
                <p>Provider config is written to <code className="inline-code">~/.pi/agent/auth.json</code> as a keychain reference that pi resolves at runtime — your key never sits in plaintext on disk.</p>
              </div>
            )}
          </div>

          {/* Configured providers */}
          {piConfig.configuredProviders.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {piConfig.configuredProviders.map((id) => (
                <div
                  key={id}
                  className={`option-card option-card--compact ${selectedPiProvider === id ? "selected" : ""}`}
                  style={{ gap: 8 }}
                >
                  <button
                    type="button"
                    disabled={piSaving}
                    onClick={() => void handleSelectPiProvider(id)}
                    style={{ background: "transparent", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}
                  >
                    {id}
                  </button>
                  <button
                    type="button"
                    disabled={piSaving}
                    aria-label={`Remove ${id}`}
                    title={`Remove ${id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRemovePiProvider(id);
                    }}
                    style={{ display: "inline-flex", background: "transparent", border: 0, padding: 0, color: "inherit", cursor: "pointer", opacity: 0.55 }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add new key */}
          <div className="flex flex-wrap gap-2 items-center">
            <input
              type="text"
              placeholder="provider"
              value={piKeyInputs.provider}
              onChange={(e) => setPiKeyInputs((p) => ({ ...p, provider: e.target.value }))}
              className="field-input"
              style={{ minWidth: 140 }}
            />
            <input
              type="password"
              placeholder="API key"
              value={piKeyInputs.key}
              onChange={(e) => setPiKeyInputs((p) => ({ ...p, key: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void handleAddPiKey(); }}
              className="field-input"
              style={{ minWidth: 220, fontFamily: "monospace" }}
            />
            <button
              className="option-card option-card--compact"
              disabled={!piKeyInputs.provider.trim() || !piKeyInputs.key.trim() || piSaving}
              onClick={() => void handleAddPiKey()}
            >
              {piSaving ? "Saving..." : "Add"}
            </button>
          </div>
          {piError && (
            <div className="command-form__error mt-3">
              {piError}
            </div>
          )}
        </div>
      )}

      {/* Interface picker */}
      {selectedAssistant && (
        <div className="page__section">
          <label className="page__label">Interface</label>
          <OptionGroup<AgentInterface>
            label="Interface"
            value={agentInterface}
            onChange={setAgentInterface}
            options={[
              { value: "chat", label: "Chat", disabled: !canChat, title: canChat ? "A conversation with messages, tool calls, and changes" : chatUnavailableReason },
              { value: "terminal", label: "Terminal", disabled: !canTerminal, title: canTerminal ? undefined : "Install the agent’s CLI to use Terminal" },
            ]}
          />
          <p className="field-note">{!selectedAssistant.acp
            ? `${chatUnavailableReason} You can use Terminal.`
            : agentInterface === "chat"
              ? "A conversation with messages, tool calls, and changes."
              : "The agent’s own command-line interface, in your workspace."}</p>
          {selectedAssistant.acp && !canChat && (
            <div className="callout mt-3">
              <MessageSquare size={15} />
              <div className="callout__body">
                <div>Set up {selectedAssistant.name} to use chat.</div>
                {selectedAssistant.acp.managed
                  ? <p className="field-note">Downloads Google’s chat runtime. Sign in with your Google account when you start a chat.</p>
                  : <code className="inline-code select-all">{selectedAssistant.acp.install}</code>}
              </div>
              <div className="callout__actions">
                {!selectedAssistant.acp.managed && <button
                  className="icon-btn"
                  onClick={() => copyInstall(selectedAssistant.acp!.install)}
                  title="Copy command"
                  aria-label="Copy install command"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>}
                <button className="btn-secondary" disabled={Boolean(installingAdapter)} onClick={() => setUpChat(selectedAssistant)}>
                  {selectedAssistant.acp.managed ? <Download size={14} /> : <SquareTerminal size={14} />}
                  {installingAdapter === selectedAssistant.id ? "Installing…" : selectedAssistant.acp.managed ? "Install chat runtime" : "Set up in terminal"}
                </button>
              </div>
            </div>
          )}
          {adapterError?.assistantId === selectedAssistant.id && <div className="command-form__error mt-3" role="alert">{adapterError.message}</div>}
        </div>
      )}

      {/* Mode picker */}
      {selectedAssistant && supportsMode(selectedAssistant.id) && (
        <div className="page__section">
          <label className="page__label">Permissions</label>
          <OptionGroup<SessionMode>
            label="Permissions"
            value={mode}
            onChange={setMode}
            options={[
              { value: "standard", label: "Standard" },
              { value: "yolo", label: "YOLO", disabled: !supportsYolo, title: supportsYolo ? "Auto-accept mode" : `${selectedAssistant.name} does not support auto-accept` },
            ]}
          />
          <p className="field-note">{mode === "yolo" ? "Edits files and runs commands without asking." : "Asks before making changes or running commands."}</p>
        </div>
      )}

      {/* Model selector (chat sessions choose in the composer) */}
      {selectedAssistant && agentInterface === "terminal" && supportsModelSelection(selectedAssistant.id) && (
        <div className="page__section">
          <label className="page__label">Model</label>
          <Select
            className="select--field"
            value={selectedModel ?? ""}
            choices={modelChoices}
            onChange={(value) => setSelectedModel(value || null)}
            placeholder={modelFetchStatus === "loading" ? "Loading…" : "Default"}
            searchThreshold={8}
            emptyLabel={modelFetchStatus === "error" ? "Could not load models" : "No models found"}
          />
        </div>
      )}

      {/* Start Button */}
      {selectedAssistant && (
        <div className="page__section">
          <button
            className="btn-primary"
            disabled={launching || (agentInterface === "chat" ? !canChat : !canTerminal)}
            aria-busy={launching}
            onClick={handleStart}
          >
            {launching ? "Starting…" : `Start ${selectedAssistant.name}`}
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      {!selectedAssistant && <div className="page__section launcher__open">
        <label className="page__label">Or open</label>
        <div className="open-grid" role="group" aria-label="Open in this project">
          {[
            ...OPEN_ACTIONS.map(({ kind, description }) => ({
              key: kind,
              label: tabKindMeta[kind].label,
              description,
              icon: tabKindMeta[kind].icon(18),
              shortcut: tabKindMeta[kind].shortcut,
              onClick: () => onOpen(kind),
            })),
            // These open outside Shep, so the page stays put.
            {
              key: "editor",
              label: "Editor",
              description: editorLabel ? `Open in ${editorLabel}` : "Choose your editor",
              icon: <EditorIcon size={18} />,
              shortcut: "⌘E",
              onClick: onOpenInEditor,
            },
            {
              key: "finder",
              label: "Finder",
              description: "Show the folder",
              icon: <FolderOpen size={18} />,
              shortcut: undefined,
              onClick: () => {
                if (!activeRepoPath) return;
                revealInFinder(activeRepoPath).catch((error) => {
                  useNoticeStore.getState().pushNotice({ tone: "error", title: "Couldn’t open in Finder", message: getErrorMessage(error) });
                });
              },
            },
          ].map((action) => (
            <button
              key={action.key}
              type="button"
              className="agent-choice open-choice"
              onClick={action.onClick}
              title={action.shortcut ? `${action.label} (${action.shortcut})` : undefined}
            >
              <span className="open-choice__icon" aria-hidden="true">{action.icon}</span>
              <span className="agent-choice__body">
                <span className="agent-choice__name">{action.label}</span>
                <span className="agent-choice__meta">{action.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>}
    </div>
  );
}
