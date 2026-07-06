import { useState, useEffect, useRef, useMemo } from "react";
import type { CodingAssistant, SessionMode } from "../../lib/types";
import { CODING_ASSISTANTS } from "../sidebar/constants";
import { checkCommandExists, getModelsForProvider } from "../../lib/tauri";
import { useRepoStore } from "../../stores/useRepoStore";
import { usePiConfigStore } from "../../stores/usePiConfigStore";
import { HandMetal, ChevronDown, Check, Info, X } from "lucide-react";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import { isMac } from "../../lib/platform";
import { ASSISTANT_INSTALL_URLS } from "../sidebar/constants";

interface SessionLauncherProps {
  onStartSession: (
    assistantId: string,
    mode: SessionMode,
    model?: string,
  ) => Promise<boolean>;
}

export default function SessionLauncher({ onStartSession }: SessionLauncherProps) {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);

  const [selectedAssistant, setSelectedAssistant] = useState<CodingAssistant | null>(null);
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [installPopover, setInstallPopover] = useState<string | null>(null);
  const [mode, setMode] = useState<SessionMode>("standard");
  const [launching, setLaunching] = useState(false);

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelFetchStatus, setModelFetchStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
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

  // Check which assistants are installed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results: Record<string, boolean> = {};
      await Promise.all(
        CODING_ASSISTANTS.map(async (a) => {
          results[a.id] = await checkCommandExists(a.command).catch(() => false);
        }),
      );
      if (!cancelled) setAvailable(results);
    })();
    return () => { cancelled = true; };
  }, []);

  // Close install popover on outside click
  useEffect(() => {
    if (!installPopover) return;
    const handleClick = () => setInstallPopover(null);
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
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

  // Close model picker on outside click
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [modelPickerOpen]);

  const filteredModels = useMemo(() => {
    let models = availableModels;
    if (selectedAssistant?.id === "pi" && selectedPiProvider) {
      models = models.filter((m) => m.startsWith(`${selectedPiProvider}/`));
    }
    if (!modelSearch) return models;
    const q = modelSearch.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [availableModels, modelSearch, selectedAssistant, selectedPiProvider]);

  const supportsModelSelection = (id: string) => id !== "pi" && id !== "opencode";
  const supportsMode = (id: string) => id !== "pi" && id !== "opencode";

  const handleSelectAssistant = (assistant: CodingAssistant) => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    setSelectedAssistant(assistant);
    setSelectedModel(null);
    setSelectedPiProvider(null);
    setModelPickerOpen(false);
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

    const started = await onStartSession(
      selectedAssistant.id,
      mode,
      selectedModel ?? undefined,
    );
    if (!started) {
      setLaunching(false);
    }
  };

  const supportsYolo = selectedAssistant?.yoloFlag != null;

  return (
    <div className="absolute inset-0 overflow-y-auto px-1 py-4">
      <h2 className="section-label !p-0 mb-6">Agents</h2>

      {/* Agent Picker */}
      <div className="mb-6">
        <label className="section-label !p-0 mb-3 block text-xs opacity-50">Agent</label>
        <div className="flex flex-wrap gap-2">
          {CODING_ASSISTANTS.map((assistant) => {
            const logoUrl = assistantLogoSrc[assistant.id];
            const isAvailable = available[assistant.id] !== false;
            const logoClassName = [getAssistantLogoClass(assistant.id), !isAvailable ? "logo-unavailable" : null]
              .filter(Boolean)
              .join(" ");
            const isSelected = selectedAssistant?.id === assistant.id;
            const installUrl = ASSISTANT_INSTALL_URLS[assistant.id];
            const showPopover = installPopover === assistant.id;
            return (
              <div key={assistant.id} className="relative">
                <button
                  className={`option-card ${isSelected ? "selected" : ""} ${!isAvailable ? "opacity-40" : ""}`}
                  onClick={() => {
                    if (isAvailable) {
                      handleSelectAssistant(assistant);
                      setInstallPopover(null);
                    } else {
                      setInstallPopover(showPopover ? null : assistant.id);
                    }
                  }}
                >
                  {logoUrl && <img src={logoUrl} alt="" width={18} height={18} className={logoClassName || undefined} />}
                  <span>{assistant.name}</span>
                </button>
                {showPopover && installUrl && (
                  <div
                    className="absolute left-0 top-full mt-2 z-50 rounded-lg p-3"
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      background: "var(--glass-panel-strong)",
                      border: "1px solid var(--glass-border-strong)",
                      backdropFilter: "blur(24px) saturate(155%)",
                      WebkitBackdropFilter: "blur(24px) saturate(155%)",
                      boxShadow: "0 14px 36px rgba(0, 0, 0, 0.28)",
                      minWidth: 200,
                    }}
                  >
                    <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
                      <strong>{assistant.name}</strong> is not installed on this system.
                    </p>
                    <code
                      className="block text-xs mt-1 px-2 py-1 rounded select-all cursor-text"
                      style={{ background: "rgba(255,255,255,0.06)", color: "rgb(122, 162, 247)" }}
                    >
                      {installUrl}
                    </code>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Description + docs link for selected assistant */}
      {selectedAssistant && (selectedAssistant.description || selectedAssistant.docsUrl) && (
        <div className="mb-6 text-xs" style={{ color: "var(--text-muted)" }}>
          {selectedAssistant.description && (
            <p className="leading-relaxed">{selectedAssistant.description}</p>
          )}
          {selectedAssistant.docsUrl && (
            <a
              href={selectedAssistant.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block underline decoration-dotted"
              style={{ color: "rgb(122, 162, 247)" }}
            >
              Docs →
            </a>
          )}
        </div>
      )}

      {/* Pi provider picker */}
      {selectedAssistant?.id === "pi" && (
        <div className="mb-6">
          <div className="flex items-center gap-1.5 mb-3 relative">
            <label className="section-label !p-0 block text-xs opacity-50">Provider</label>
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
                className="absolute left-0 top-full mt-1 z-50 rounded-lg p-3 text-xs leading-relaxed"
                style={{
                  background: "var(--glass-panel-strong)",
                  border: "1px solid var(--glass-border-strong)",
                  backdropFilter: "blur(24px) saturate(155%)",
                  WebkitBackdropFilter: "blur(24px) saturate(155%)",
                  boxShadow: "0 14px 36px rgba(0, 0, 0, 0.28)",
                  minWidth: 260,
                  color: "var(--text-muted)",
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {isMac ? (
                  <>
                    <p className="mb-1"><strong style={{ color: "var(--text-primary)" }}>API keys are stored securely in macOS Keychain</strong></p>
                    <p>Provider config is written to <code style={{ color: "rgb(122, 162, 247)" }}>~/.pi/agent/auth.json</code> as a keychain reference that pi resolves at runtime — your key never sits in plaintext on disk.</p>
                  </>
                ) : (
                  <>
                    <p className="mb-1"><strong style={{ color: "var(--text-primary)" }}>API keys are stored in pi's config file</strong></p>
                    <p>Provider keys are written to <code style={{ color: "rgb(122, 162, 247)" }}>~/.pi/agent/auth.json</code> in your user profile, readable only by your Windows account.</p>
                  </>
                )}
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
              className="usage-provider-row__budget-input"
              style={{ minWidth: 140 }}
            />
            <input
              type="password"
              placeholder="API key"
              value={piKeyInputs.key}
              onChange={(e) => setPiKeyInputs((p) => ({ ...p, key: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void handleAddPiKey(); }}
              className="usage-provider-row__budget-input"
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

      {/* Mode picker */}
      {selectedAssistant && supportsMode(selectedAssistant.id) && (
        <div className="mb-6">
          <label className="section-label !p-0 mb-3 block text-xs opacity-50">Mode</label>
          <div className="flex flex-wrap gap-2">
            <button
              className={`option-card ${mode === "standard" ? "selected" : ""}`}
              onClick={() => setMode("standard")}
            >
              Standard
            </button>
            <button
              className={`option-card ${mode === "yolo" ? "selected" : ""} ${!supportsYolo ? "opacity-40" : ""}`}
              onClick={() => { if (supportsYolo) setMode("yolo"); }}
              title={supportsYolo ? "Auto-accept mode" : `${selectedAssistant.name} does not support auto-accept`}
            >
              <HandMetal size={14} />
              YOLO
            </button>
          </div>
        </div>
      )}

      {/* Model selector */}
      {selectedAssistant && supportsModelSelection(selectedAssistant.id) && (
        <div className="mb-6">
          <label className="section-label !p-0 mb-3 block text-xs opacity-50">Model</label>
          <div className="relative" ref={modelPickerRef}>
            <button
              type="button"
              onClick={() => {
                setModelPickerOpen((open) => {
                  const next = !open;
                  if (next) {
                    setModelSearch("");
                    window.setTimeout(() => modelSearchRef.current?.focus(), 0);
                  }
                  return next;
                });
              }}
              className="option-card option-card--compact justify-between"
              aria-busy={modelFetchStatus === "loading"}
              style={{ minWidth: 240 }}
            >
              <span className="truncate">
                {modelFetchStatus === "loading" ? "Loading..." : selectedModel ?? "Default"}
              </span>
              <ChevronDown size={14} className="shrink-0 opacity-60" />
            </button>

            {modelPickerOpen && (
              <div className="font-picker-dropdown">
                <input
                  ref={modelSearchRef}
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search models..."
                  className="font-picker-search"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setModelPickerOpen(false);
                  }}
                />
                <div className="font-picker-list">
                  {/* Default option — always first */}
                  <button
                    type="button"
                    onClick={() => { setSelectedModel(null); setModelPickerOpen(false); }}
                    className={`font-picker-item ${selectedModel === null ? "font-picker-item--active" : ""}`}
                  >
                    <Check
                      size={14}
                      className={`shrink-0 ${selectedModel === null ? "opacity-100" : "opacity-0"}`}
                    />
                    <span className="font-picker-item__name">Default</span>
                  </button>

                  {modelFetchStatus === "loading" && (
                    <div className="font-picker-empty">Loading models...</div>
                  )}
                  {modelFetchStatus === "error" && (
                    <div className="font-picker-empty">Could not load models - using default</div>
                  )}
                  {modelFetchStatus === "loaded" && availableModels.length === 0 && !modelSearch && (
                    <div className="font-picker-empty">No models found - using default</div>
                  )}
                  {modelFetchStatus === "loaded" && filteredModels.length === 0 && modelSearch && (
                    <div className="font-picker-empty">No matching models</div>
                  )}
                  {modelFetchStatus === "loaded" && filteredModels.map((model) => {
                    const active = selectedModel === model;
                    return (
                      <button
                        key={model}
                        type="button"
                        onClick={() => { setSelectedModel(model); setModelPickerOpen(false); }}
                        className={`font-picker-item ${active ? "font-picker-item--active" : ""}`}
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${active ? "opacity-100" : "opacity-0"}`}
                        />
                        <span className="font-picker-item__name">{model}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Start Button */}
      {selectedAssistant && (
        <div>
          <label className="section-label !p-0 mb-3 block text-xs opacity-50">Start</label>
          <button
            className="btn-cta"
            disabled={launching || (mode === "yolo" && !supportsYolo)}
            aria-busy={launching}
            onClick={handleStart}
          >
            {launching ? "Starting..." : "Start Session"}
          </button>
        </div>
      )}
    </div>
  );
}
