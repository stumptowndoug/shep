import { useState, useEffect, useRef, useMemo } from "react";
import type { AgentInterface, CodingAssistant, SessionMode } from "../../lib/types";
import { CODING_ASSISTANTS, ASSISTANT_INSTALL_URLS } from "../sidebar/constants";
import { getModelsForProvider, installManagedAcpAdapter, openUrl } from "../../lib/tauri";
import { chatAvailabilityKey, commandAvailabilityKey, useAgentAvailabilityStore, type AvailabilityCheck } from "../../stores/useAgentAvailabilityStore";
import { getErrorMessage } from "../../lib/errors";
import { useRepoStore } from "../../stores/useRepoStore";
import { usePiConfigStore } from "../../stores/usePiConfigStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { ArrowRight, Check, Copy, Download, ExternalLink, Info, MessageSquare, SquareTerminal, X } from "lucide-react";
import Select from "../shared/Select";
import OptionGroup from "../shared/OptionGroup";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { chatHintDone, markChatHintDone } from "../../lib/acp/chatKeys";

const LAST_AGENT_KEY = "shep:last-agent";

/** The launcher opens on the agent you last started. */
function lastStartedAssistant(): CodingAssistant {
  let id: string | null = null;
  try { id = window.localStorage.getItem(LAST_AGENT_KEY); } catch { /* Fall back to the first agent. */ }
  return CODING_ASSISTANTS.find((assistant) => assistant.id === id) ?? CODING_ASSISTANTS[0];
}

function rememberStartedAssistant(id: string) {
  try { window.localStorage.setItem(LAST_AGENT_KEY, id); } catch { /* Only the next launcher's preselection is lost. */ }
}

type AgentReadiness = "checking" | "ready" | "chat-setup" | "missing";

/** One availability summary drives both the tile's dot and the card's status line. */
function agentReadiness(assistant: CodingAssistant, cli: AvailabilityCheck | undefined, chat: AvailabilityCheck | undefined) {
  const isAvailable = cli?.available !== false || Boolean(assistant.acp && chat?.available !== false) || Boolean(assistant.acp?.standalone);
  const checking = cli?.available === undefined || Boolean(assistant.acp && chat?.available === undefined);
  const label = checking ? cli?.error || chat?.error ? "Couldn’t check availability" : "Checking…"
    : !isAvailable ? "Set up agent" : chat?.available ? cli?.available ? "Chat & terminal" : "Chat"
      : cli?.available ? "Terminal" : "Set up chat";
  const readiness: AgentReadiness = checking ? "checking" : !isAvailable ? "missing"
    : assistant.acp && chat?.available === false ? "chat-setup" : "ready";
  const status = readiness === "checking" ? label
    : readiness === "missing" ? "Not installed"
      : readiness === "chat-setup" ? cli?.available ? "Terminal ready · chat needs setup" : "Chat needs setup"
        : chat?.available && cli?.available ? "Chat and terminal ready" : chat?.available ? "Chat ready" : "Terminal ready";
  return { readiness, label, status };
}

interface SessionLauncherProps {
  /** Run a setup command (e.g. an adapter install) in a new terminal tab. */
  onRunInTerminal: (script: string, label: string) => void;
  onStartSession: (
    assistantId: string,
    mode: SessionMode,
    agentInterface: AgentInterface,
    model?: string,
  ) => Promise<boolean>;
}

export default function SessionLauncher({ onStartSession, onRunInTerminal }: SessionLauncherProps) {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const defaultAgentMode = useProjectSettingsStore((s) => s.settings.defaultAgentMode);
  const defaultAgentInterface = useProjectSettingsStore((s) => s.settings.defaultAgentInterface);

  const [selectedAssistant, setSelectedAssistant] = useState<CodingAssistant>(lastStartedAssistant);
  const selectedAssistantRef = useRef<string>(selectedAssistant.id);
  const availability = useAgentAvailabilityStore((s) => s.checks);
  const refreshAvailability = useAgentAvailabilityStore((s) => s.refresh);
  // Explicit picks override the project defaults for this launch only.
  const [modeOverride, setMode] = useState<SessionMode | null>(null);
  const [interfaceOverride, setAgentInterface] = useState<AgentInterface | null>(null);
  const [hintDone, setHintDone] = useState(chatHintDone);
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

  // Keep shared results across launcher mounts; focus catches setup done outside
  // Shep. Each probe publishes independently, without clearing known results.
  useEffect(() => {
    const refresh = () => { void refreshAvailability(); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshAvailability]);

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
    if (selectedAssistant.id === "pi" && selectedPiProvider) {
      models = models.filter((m) => m.startsWith(`${selectedPiProvider}/`));
    }
    return [{ value: "", label: "Default" }, ...models.map((model) => ({ value: model, label: model }))];
  }, [availableModels, selectedAssistant, selectedPiProvider]);

  const supportsModelSelection = (id: string) => id !== "pi" && id !== "opencode";
  const supportsMode = (id: string) => id !== "pi";
  const terminalCheck = availability[commandAvailabilityKey(selectedAssistant.command)];
  const chatCheck = selectedAssistant.acp ? availability[chatAvailabilityKey(selectedAssistant.acp)] : undefined;
  const canChat = chatCheck?.available === true;
  const canTerminal = terminalCheck?.available === true;
  const chatUnknown = Boolean(selectedAssistant.acp && chatCheck?.available === undefined);
  const agentInterface: AgentInterface = terminalCheck?.available === false && (canChat || selectedAssistant.acp?.standalone) ? "chat"
    : canChat || chatUnknown ? interfaceOverride ?? defaultAgentInterface : "terminal";
  const chatUnavailableReason = selectedAssistant.acp
    ? chatUnknown ? chatCheck?.error ? "Couldn’t check chat availability" : "Checking chat availability…" : "Chat adapter not installed"
    : `Chat isn’t available for ${selectedAssistant.name} in Shep yet.`;
  const selected = agentReadiness(selectedAssistant, terminalCheck, chatCheck);
  const agentMissing = selected.readiness === "missing";

  const loadAssistantDetails = (assistant: CodingAssistant) => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
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

  const handleSelectAssistant = (assistant: CodingAssistant) => {
    if (assistant.id === selectedAssistantRef.current) return;
    setSelectedAssistant(assistant);
    selectedAssistantRef.current = assistant.id;
    setAdapterError(null);
    loadAssistantDetails(assistant);
  };

  // One-time init: the preselected agent needs its models and, for pi, its config.
  useEffect(() => {
    loadAssistantDetails(selectedAssistant);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedAssistant.id !== "pi" || !piHasLoaded) return;
    setSelectedPiProvider(piConfig.settings.defaultProvider ?? null);
  }, [piConfig.settings.defaultProvider, piHasLoaded, selectedAssistant.id]);

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
    if (!activeRepoPath || launching) return;
    setLaunching(true);
    if (agentInterface === "chat") markChatHintDone();

    // Chat sessions pick their model in the composer, from the agent's own list.
    const started = await onStartSession(
      selectedAssistant.id,
      mode,
      agentInterface,
      agentInterface === "terminal" ? selectedModel ?? undefined : undefined,
    );
    if (started) rememberStartedAssistant(selectedAssistant.id);
    else setLaunching(false);
  };

  const supportsYolo = selectedAssistant.yoloFlag != null;
  const projectName = activeRepoPath?.split("/").filter(Boolean).pop() ?? null;
  const installUrl = ASSISTANT_INSTALL_URLS[selectedAssistant.id];
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
        useAgentAvailabilityStore.getState().markChatInstalled(assistant.acp!);
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
        <h1 className="page__title">New agent</h1>
      </header>

      <div className="agent-folder">
        <div className="agent-folder__tabs" role="group" aria-label="Choose an agent">
          {CODING_ASSISTANTS.map((assistant) => {
            const logoUrl = assistantLogoSrc[assistant.id];
            const cli = availability[commandAvailabilityKey(assistant.command)];
            const chat = assistant.acp ? availability[chatAvailabilityKey(assistant.acp)] : undefined;
            const { readiness, label } = agentReadiness(assistant, cli, chat);
            const isSelected = selectedAssistant.id === assistant.id;
            return (
              <button
                key={assistant.id}
                type="button"
                className={`agent-tab${isSelected ? " selected" : ""}${readiness === "missing" ? " unavailable" : ""}`}
                aria-pressed={isSelected}
                aria-label={`${assistant.name}${readiness === "missing" ? " · not installed" : ""}`}
                title={`${assistant.name} · ${label}`}
                onClick={() => handleSelectAssistant(assistant)}
              >
                <span className="agent-tab__logo">
                  {logoUrl && <img src={logoUrl} alt="" width={26} height={26} className={getAssistantLogoClass(assistant.id)} />}
                  {(readiness === "chat-setup" || readiness === "missing") && (
                    <span className={`agent-tab__dot agent-tab__dot--${readiness}`} aria-hidden="true" />
                  )}
                </span>
                <span className="agent-tab__name">{assistant.name}</span>
                <span className="agent-tab__status sr-only">{label}</span>
              </button>
            );
          })}
        </div>

        <section className="agent-folder__panel" aria-label={`${selectedAssistant.name} session`}>
          {agentMissing ? (
            <div className="agent-folder__row">
              <p className="agent-folder__note">{selectedAssistant.name} isn’t installed yet.</p>
              {installUrl && (
                <button type="button" className="btn-secondary" onClick={() => void openUrl(installUrl)}>
                  Install {selectedAssistant.name}
                  <ExternalLink size={14} />
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="agent-folder__row">
                <div className="agent-folder__field">
                  <span className="agent-folder__label">Run as</span>
                  <OptionGroup<AgentInterface>
                    label="Interface"
                    value={agentInterface}
                    onChange={setAgentInterface}
                    options={[
                      { value: "chat", label: "Chat", disabled: !canChat, title: canChat ? "A conversation with messages, tool calls, and changes" : chatUnavailableReason },
                      { value: "terminal", label: "Terminal", disabled: !canTerminal, title: canTerminal ? "The agent’s own command-line interface, in your workspace" : terminalCheck?.available === undefined ? "Checking terminal availability…" : "Install the agent’s CLI to use Terminal" },
                    ]}
                  />
                </div>

                {supportsMode(selectedAssistant.id) && (
                  <div className="agent-folder__field">
                    <span className="agent-folder__label">Permissions</span>
                    <OptionGroup<SessionMode>
                      label="Permissions"
                      value={mode}
                      onChange={setMode}
                      options={[
                        { value: "standard", label: "Ask first", title: "Asks before making changes or running commands" },
                        { value: "yolo", label: "YOLO", disabled: !supportsYolo, title: supportsYolo ? "Edits files and runs commands without asking" : `${selectedAssistant.name} does not support auto-accept` },
                      ]}
                    />
                  </div>
                )}

                {agentInterface === "terminal" && supportsModelSelection(selectedAssistant.id) && (
                  <div className="agent-folder__field">
                    <span className="agent-folder__label">Model</span>
                    <Select
                      className="select--field"
                      value={selectedModel ?? ""}
                      choices={modelChoices}
                      onChange={(value) => setSelectedModel(value || null)}
                      placeholder={modelFetchStatus === "loading" ? "Loading…" : "Default"}
                      searchThreshold={8}
                      ariaLabel="Model"
                      emptyLabel={modelFetchStatus === "error" ? "Could not load models" : "No models found"}
                    />
                  </div>
                )}

                <button
                  className="btn-primary agent-folder__start"
                  disabled={launching || (agentInterface === "chat" ? !canChat : !canTerminal)}
                  aria-busy={launching}
                  aria-label={`Start ${selectedAssistant.name}`}
                  onClick={handleStart}
                >
                  {launching ? "Starting…" : "Start"}
                  <ArrowRight size={14} />
                </button>
              </div>
              <p className="agent-folder__note">{selected.status}</p>
            </>
          )}

          {/* Upgraded users keep Terminal; point out Chat once, until they try it or dismiss this. */}
          {!agentMissing && !hintDone && selectedAssistant.acp && defaultAgentInterface === "terminal" && agentInterface === "terminal" && chatCheck?.available !== false && (
            <div className="callout" role="note">
              <MessageSquare size={15} aria-hidden="true" />
              <div className="callout__body">
                <div><strong>New:</strong> run agents as a chat, with tool calls and changes inline.</div>
                <p className="field-note">Pick Chat above, or make it your default in Settings.</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Dismiss chat tip" onClick={() => {
                markChatHintDone();
                setHintDone(true);
              }}><X size={14} aria-hidden="true" /></button>
            </div>
          )}
          {!agentMissing && selectedAssistant.acp && chatCheck?.available === false && (
            <div className="callout">
              <MessageSquare size={15} />
              <div className="callout__body">
                <div>Set up {selectedAssistant.name} to use chat.</div>
                {selectedAssistant.acp.managed
                  ? <p className="field-note">{selectedAssistant.acp.setupNote}</p>
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
                  {installingAdapter === selectedAssistant.id ? "Installing…" : selectedAssistant.acp.managed ? selectedAssistant.acp.setupAction : "Set up in terminal"}
                </button>
              </div>
            </div>
          )}
          {(chatCheck?.error || terminalCheck?.error) && (
            <div className="callout" role="alert">
              <div className="callout__body">Couldn’t check agent availability. {chatCheck?.error ?? terminalCheck?.error}</div>
              <button className="btn-secondary" onClick={() => void refreshAvailability(true)}>Retry</button>
            </div>
          )}
          {adapterError?.assistantId === selectedAssistant.id && <div className="command-form__error" role="alert">{adapterError.message}</div>}

          {/* Pi provider picker */}
          {selectedAssistant.id === "pi" && !agentMissing && (
            <div className="agent-folder__field">
              <div className="flex items-center gap-1.5 relative">
                <span className="agent-folder__label">Provider</span>
                <button
                  type="button"
                  onClick={() => setPiInfoOpen((o) => !o)}
                  className="opacity-40 hover:opacity-70 transition-opacity"
                  style={{ lineHeight: 0 }}
                  aria-label="About pi API keys"
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
                <div className="flex flex-wrap gap-2">
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
                  aria-label="Provider"
                  value={piKeyInputs.provider}
                  onChange={(e) => setPiKeyInputs((p) => ({ ...p, provider: e.target.value }))}
                  className="field-input"
                  style={{ minWidth: 140 }}
                />
                <input
                  type="password"
                  placeholder="API key"
                  aria-label="API key"
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
                <div className="command-form__error">
                  {piError}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
