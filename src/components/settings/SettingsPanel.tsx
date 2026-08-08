import { useEffect, useMemo, useRef, useState } from "react";
import { getIdentifier, getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { Upload, ChevronDown, Check } from "lucide-react";
import { EDITOR_OPTIONS } from "../../lib/editors";
import { DARK_THEMES, LIGHT_THEMES, TRANSPARENT_THEMES } from "../../lib/themes";
import { KEYBINDING_PRESETS } from "../../lib/keybindingPresets";
import { useEditorStore } from "../../stores/useEditorStore";
import { useThemeStore } from "../../stores/useThemeStore";
import { useKeybindingStore } from "../../stores/useKeybindingStore";
import { useProjectSettingsStore } from "../../stores/useProjectSettingsStore";
import { useRepoStore } from "../../stores/useRepoStore";
import { useTodoStore } from "../../stores/useTodoStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUpdateStore } from "../../stores/useUpdateStore";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import {
  FONT_SIZE_OPTIONS,
  TERMINAL_FONT_FAMILY,
} from "../../lib/terminalConfig";
import { ALL_USAGE_PROVIDERS } from "../usage/usageHelpers";
import type { CursorStyle, BudgetMode, FontFamily } from "../../lib/types";
import { getErrorMessage } from "../../lib/errors";
import { listMonospaceFamilies } from "../../lib/tauri";

interface AppMeta {
  name: string;
  version: string;
  identifier: string;
  tauriVersion: string;
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="settings-info-tip" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4 }}>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="600">i</text>
      </svg>
      {show && <span className="settings-info-tip__bubble">{text}</span>}
    </span>
  );
}

export default function SettingsPanel() {
  const optionClass = "option-card w-44 justify-start";
  const [appMeta, setAppMeta] = useState<AppMeta | null>(null);
  const [appMetaError, setAppMetaError] = useState<string | null>(null);
  const [fontFamilies, setFontFamilies] = useState<FontFamily[]>([]);
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [fontSearch, setFontSearch] = useState("");
  const fontPickerRef = useRef<HTMLDivElement>(null);
  const fontSearchRef = useRef<HTMLInputElement>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const customTheme = useThemeStore((s) => s.customTheme);
  const importTheme = useThemeStore((s) => s.importTheme);
  const themeFileInputRef = useRef<HTMLInputElement | null>(null);
  const settings = useEditorStore((s) => s.settings);
  const hasLoaded = useEditorStore((s) => s.hasLoaded);
  const isSaving = useEditorStore((s) => s.isSaving);
  const error = useEditorStore((s) => s.error);
  const loadSettings = useEditorStore((s) => s.loadSettings);
  const setPreferredEditor = useEditorStore((s) => s.setPreferredEditor);

  const kbSettings = useKeybindingStore((s) => s.settings);
  const kbHasLoaded = useKeybindingStore((s) => s.hasLoaded);
  const kbIsSaving = useKeybindingStore((s) => s.isSaving);
  const kbError = useKeybindingStore((s) => s.error);
  const loadKbSettings = useKeybindingStore((s) => s.loadSettings);
  const setKbEnabled = useKeybindingStore((s) => s.setEnabled);

  const projectSettings = useProjectSettingsStore((s) => s.settings);
  const projectHasLoaded = useProjectSettingsStore((s) => s.hasLoaded);
  const projectIsSaving = useProjectSettingsStore((s) => s.isSaving);
  const projectError = useProjectSettingsStore((s) => s.error);
  const loadProjectSettings = useProjectSettingsStore((s) => s.loadSettings);
  const updateProjectSettings = useProjectSettingsStore((s) => s.updateSettings);

  const termSettings = useTerminalSettingsStore((s) => s.settings);
  const termHasLoaded = useTerminalSettingsStore((s) => s.hasLoaded);
  const termIsSaving = useTerminalSettingsStore((s) => s.isSaving);
  const termError = useTerminalSettingsStore((s) => s.error);
  const loadTermSettings = useTerminalSettingsStore((s) => s.loadSettings);
  const updateTermSettings = useTerminalSettingsStore((s) => s.updateSettings);

  const usageSettings = useUsageSettingsStore((s) => s.settings);
  const usageHasLoaded = useUsageSettingsStore((s) => s.hasLoaded);
  const usageIsSaving = useUsageSettingsStore((s) => s.isSaving);
  const usageError = useUsageSettingsStore((s) => s.error);
  const loadUsageSettings = useUsageSettingsStore((s) => s.loadSettings);
  const updateProvider = useUsageSettingsStore((s) => s.updateProvider);
  const [budgetInputs, setBudgetInputs] = useState<Record<string, string>>({});

  const updateStatus = useUpdateStore((s) => s.status);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const releaseNotesUrl = useUpdateStore((s) => s.releaseNotesUrl);
  const downloadProgress = useUpdateStore((s) => s.downloadProgress);
  const updateError = useUpdateStore((s) => s.error);
  const hasChecked = useUpdateStore((s) => s.hasChecked);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const restartApp = useUpdateStore((s) => s.restartApp);

  useEffect(() => {
    if (!hasLoaded) void loadSettings();
    if (!projectHasLoaded) void loadProjectSettings();
    if (!kbHasLoaded) void loadKbSettings();
    if (!termHasLoaded) void loadTermSettings();
    if (!usageHasLoaded) void loadUsageSettings();
  }, [hasLoaded, loadSettings, projectHasLoaded, loadProjectSettings, kbHasLoaded, loadKbSettings, termHasLoaded, loadTermSettings, usageHasLoaded, loadUsageSettings]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [name, version, identifier, tauriVersion] = await Promise.all([
          getName(),
          getVersion(),
          getIdentifier(),
          getTauriVersion(),
        ]);

        if (!cancelled) {
          setAppMeta({ name, version, identifier, tauriVersion });
          setAppMetaError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setAppMeta(null);
          setAppMetaError(getErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void listMonospaceFamilies()
      .then((families) => {
        if (!cancelled) {
          setFontFamilies(families);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFontError(getErrorMessage(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Close the font picker on outside click / Escape.
  useEffect(() => {
    if (!fontPickerOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      if (!fontPickerRef.current) return;
      if (!fontPickerRef.current.contains(event.target as Node)) {
        setFontPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFontPickerOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [fontPickerOpen]);


  // Assemble the searchable list: always surface the bundled MesloLGS NF
  // (the default) even if CoreText didn't return it as a system-installed
  // family, then append everything from Rust. Dedupe by family name.
  const pickerFamilies = useMemo(() => {
    const seen = new Set<string>();
    const list: FontFamily[] = [];
    const bundled: FontFamily = {
      family: TERMINAL_FONT_FAMILY,
      faceCount: 4,
      isNerdFont: true,
    };
    list.push(bundled);
    seen.add(TERMINAL_FONT_FAMILY);
    for (const family of fontFamilies) {
      if (seen.has(family.family)) continue;
      seen.add(family.family);
      list.push(family);
    }
    return list;
  }, [fontFamilies]);

  const filteredFontFamilies = useMemo(() => {
    const query = fontSearch.trim().toLowerCase();
    if (!query) return pickerFamilies;
    return pickerFamilies.filter((family) =>
      family.family.toLowerCase().includes(query),
    );
  }, [pickerFamilies, fontSearch]);

  const selectFont = (family: string) => {
    setFontPickerOpen(false);
    setFontSearch("");
    void updateTermSettings({ fontFamily: family });
  };

  const importThemeFile = async (file: File | null) => {
    if (!file) return;

    try {
      const source = await file.text();
      importTheme(source);
      setThemeError(null);
    } catch (error) {
      setThemeError(getErrorMessage(error));
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto pt-3 pb-6">
      {/* ── Theme ──────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Theme</h2>

        <div className="flex flex-wrap gap-3">
          {[...DARK_THEMES, ...LIGHT_THEMES, ...TRANSPARENT_THEMES].map((t) => {
            const active = t.id === themeId;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`${optionClass} ${active ? "selected" : ""}`}
              >
                <div
                  className="shrink-0 rounded-full"
                  style={{
                    width: 24,
                    height: 24,
                    background: `linear-gradient(135deg, ${t.bgRadial1} 0%, ${t.bgLinearMid} 50%, ${t.bgRadial3} 100%)`,
                  }}
                />
                <span>{t.name}</span>
              </button>
            );
          })}
        </div>

        <div className="settings-row !mb-0 mt-2">
          <span className="settings-row__label flex items-center gap-2">
            <span>Custom Theme</span>
            <InfoTip text={"Ghostty-style file: background and foreground, plus palette entries 0 through 15. Download examples from terminalcolors.com/themes/."} />
          </span>
          <div className="flex flex-wrap gap-2">
            {customTheme && (
              <button
                onClick={() => setTheme(customTheme.id)}
                className={`option-card option-card--compact ${themeId === customTheme.id ? "selected" : ""}`}
              >
                <div
                  className="shrink-0 rounded-full"
                  style={{
                    width: 18,
                    height: 18,
                    background: `linear-gradient(135deg, ${customTheme.bgRadial1} 0%, ${customTheme.bgLinearMid} 50%, ${customTheme.bgRadial3} 100%)`,
                  }}
                />
                <span>Custom</span>
              </button>
            )}
            <button
              onClick={() => {
                setThemeError(null);
                themeFileInputRef.current?.click();
              }}
              className="option-card option-card--compact"
            >
              <span className="flex items-center gap-2">
                <Upload size={14} />
                <span>{customTheme ? "Update Theme" : "Import Theme"}</span>
              </span>
            </button>
            <input
              ref={themeFileInputRef}
              type="file"
              accept=".txt,.conf,.theme,.config"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                void importThemeFile(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
          {themeError && <div className="mt-2 text-sm text-red-300">{themeError}</div>}
        </div>
      </section>

      {/* ── Editor ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Editor</h2>

        <div className="flex flex-wrap gap-3">
          {EDITOR_OPTIONS.map((option) => {
            const active = option.id === settings.preferredEditor;
            return (
              <button
                key={option.id}
                onClick={() => void setPreferredEditor(option.id)}
                className={`${optionClass} ${active ? "selected" : ""}`}
              >
                <img
                  src={option.logoSrc}
                  alt=""
                  width={20}
                  height={20}
                  className={`shrink-0 ${option.logoClassName ?? ""}`}
                />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>

        {isSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving...</div>}
        {error && <div className="mt-2 text-sm text-red-300">{error}</div>}
      </section>

      {/* ── Keybindings ────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Keybindings</h2>

        <div className="flex flex-wrap gap-3">
          {KEYBINDING_PRESETS.map((preset) => {
            const active = kbSettings[preset.id];
            return (
              <button
                key={preset.id}
                onClick={() => void setKbEnabled(preset.id, !active)}
                className={`keybinding-card ${active ? "selected" : ""}`}
              >
                <span className="keybinding-card__keys">
                  {preset.keys.map((k, i) => (
                    <kbd key={i} className="keybinding-kbd">{k}</kbd>
                  ))}
                </span>
                <span className="keybinding-card__action">{preset.action}</span>
              </button>
            );
          })}
        </div>

        {kbIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving keybindings...</div>}
        {kbError && <div className="mt-2 text-sm text-red-300">{kbError}</div>}
      </section>

      {/* ── Projects ───────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Projects</h2>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Auto-import Worktrees</span>
            <InfoTip text="When enabled, adding a main repo also imports its existing Git worktrees. Adding a worktree directly still adds its main repo so the relationship stays intact." />
          </span>
          <button
            onClick={() => void updateProjectSettings({ autoImportWorktrees: !projectSettings.autoImportWorktrees })}
            className={`option-card option-card--compact ${projectSettings.autoImportWorktrees ? "selected" : ""}`}
          >
            {projectSettings.autoImportWorktrees ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Agent Sessions in Sidebar</span>
            <InfoTip text="Shows the global agent session section above Projects. Project tabs and agent sessions remain available inside each project when this is off." />
          </span>
          <button
            onClick={() => void updateProjectSettings({ showAgentSessionsInSidebar: !projectSettings.showAgentSessionsInSidebar })}
            className={`option-card option-card--compact ${projectSettings.showAgentSessionsInSidebar ? "selected" : ""}`}
          >
            {projectSettings.showAgentSessionsInSidebar ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Agent Label</span>
            <InfoTip text="Choose what identifies live agents in tabs and the sidebar. Session titles are still retained for history when Repository is selected. Manual tab renames always take priority." />
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void updateProjectSettings({ agentLabelMode: "repository" })}
              className={`option-card option-card--compact ${projectSettings.agentLabelMode === "repository" ? "selected" : ""}`}
            >
              Repository
            </button>
            <button
              onClick={() => void updateProjectSettings({ agentLabelMode: "title" })}
              className={`option-card option-card--compact ${projectSettings.agentLabelMode === "title" ? "selected" : ""}`}
            >
              Session title
            </button>
          </div>
        </div>

        {projectIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving project settings...</div>}
        {projectError && <div className="mt-2 text-sm text-red-300">{projectError}</div>}
      </section>

      {/* ── To-dos ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">To-dos</h2>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Project To-dos</span>
            <InfoTip text="Shows a To-dos row in each project that surfaces any TODO.md in the repo as a shared task list for you and your coding agents. Turning this off hides the row and stops scanning for todo files." />
          </span>
          <button
            onClick={() => {
              const enabling = !projectSettings.showTodos;
              void updateProjectSettings({ showTodos: enabling });
              if (enabling) {
                const repoPaths = useRepoStore.getState().repos.map((repo) => repo.path);
                void useTodoStore.getState().refreshAll(repoPaths);
              }
            }}
            className={`option-card option-card--compact ${projectSettings.showTodos ? "selected" : ""}`}
          >
            {projectSettings.showTodos ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-row !mb-0">
          <span className="settings-row__label flex items-center gap-2">
            <span>New File Style</span>
            <InfoTip text="The shape Shep gives a TODO.md it creates for you (when you add your first to-do in a project). Kanban board starts with Backlog / In Progress / Done columns and renders as a board; Simple list is a flat checklist. Existing files are never reformatted." />
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void updateProjectSettings({ todoFileStyle: "kanban" })}
              className={`option-card option-card--compact ${projectSettings.todoFileStyle === "kanban" ? "selected" : ""}`}
            >
              Kanban board
            </button>
            <button
              onClick={() => void updateProjectSettings({ todoFileStyle: "list" })}
              className={`option-card option-card--compact ${projectSettings.todoFileStyle === "list" ? "selected" : ""}`}
            >
              Simple list
            </button>
          </div>
        </div>
      </section>

      {/* ── Terminal ───────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Terminal</h2>

        <div className="settings-row">
          <span className="settings-row__label">Cursor</span>
          <div className="flex flex-wrap gap-2">
            {(["block", "underline", "bar"] as const).map((style) => (
              <button
                key={style}
                onClick={() => void updateTermSettings({ cursorStyle: style as CursorStyle })}
                className={`option-card option-card--compact ${termSettings.cursorStyle === style ? "selected" : ""}`}
              >
                <span className="capitalize">{style}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-row__label">Blink</span>
          <button
            onClick={() => void updateTermSettings({ cursorBlink: !termSettings.cursorBlink })}
            className={`option-card option-card--compact ${termSettings.cursorBlink ? "selected" : ""}`}
          >
            {termSettings.cursorBlink ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Font</span>
            <InfoTip text="Lists every installed monospace font on your Mac. Nerd Font variants are surfaced first — they're the best choice for powerline prompts and devicons." />
          </span>
          <div className="relative" ref={fontPickerRef}>
            <button
              type="button"
              onClick={() => {
                setFontPickerOpen((open) => {
                  const next = !open;
                  if (next) {
                    setFontSearch("");
                    // Autofocus the search input once the dropdown mounts.
                    window.setTimeout(() => fontSearchRef.current?.focus(), 0);
                  }
                  return next;
                });
              }}
              className="option-card option-card--compact justify-between"
              style={{ minWidth: 240 }}
            >
              <span className="truncate">{termSettings.fontFamily || "Select font"}</span>
              <ChevronDown size={14} className="shrink-0 opacity-60" />
            </button>

            {fontPickerOpen && (
              <div className="font-picker-dropdown">
                <input
                  ref={fontSearchRef}
                  type="text"
                  value={fontSearch}
                  onChange={(event) => setFontSearch(event.target.value)}
                  placeholder="Search installed fonts..."
                  className="font-picker-search"
                />
                <div className="font-picker-list">
                  {filteredFontFamilies.length === 0 && (
                    <div className="font-picker-empty">No matching fonts</div>
                  )}
                  {filteredFontFamilies.map((family) => {
                    const active = termSettings.fontFamily === family.family;
                    return (
                      <button
                        key={family.family}
                        type="button"
                        onClick={() => selectFont(family.family)}
                        className={`font-picker-item ${active ? "font-picker-item--active" : ""}`}
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${active ? "opacity-100" : "opacity-0"}`}
                        />
                        <span className="font-picker-item__name">{family.family}</span>
                        {family.isNerdFont && (
                          <span className="font-picker-item__badge">Nerd Font</span>
                        )}
                        <span className="font-picker-item__count">
                          {family.faceCount} {family.faceCount === 1 ? "face" : "faces"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {fontError && <div className="mt-2 text-sm text-red-300">{fontError}</div>}
        </div>

        <div className="settings-row">
          <span className="settings-row__label">Font Size</span>
          <div className="flex flex-wrap gap-2">
            {FONT_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                onClick={() => void updateTermSettings({ fontSize: size })}
                className={`option-card option-card--compact ${termSettings.fontSize === size ? "selected" : ""}`}
              >
                {size}px
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row !mb-0">
          <span className="settings-row__label">
            Scrollback
            <InfoTip text="Number of lines kept in the terminal scroll buffer. Higher values use more memory." />
          </span>
          <div className="flex flex-wrap gap-2">
            {[1000, 5000, 10000, 25000, 50000].map((value) => (
              <button
                key={value}
                onClick={() => void updateTermSettings({ scrollback: value })}
                className={`option-card option-card--compact ${termSettings.scrollback === value ? "selected" : ""}`}
              >
                {value >= 1000 ? `${value / 1000}k` : value}
              </button>
            ))}
          </div>
        </div>

        {termIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving terminal settings...</div>}
        {termError && <div className="mt-2 text-sm text-red-300">{termError}</div>}
      </section>

      {/* ── Usage ──────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Usage Providers</h2>

        <div className="usage-provider-grid">
          {ALL_USAGE_PROVIDERS.map((provider) => {
            const config = usageSettings[provider];
            const logo = assistantLogoSrc[provider];
            const label = provider === "claude"
              ? "Claude"
              : provider === "codex"
                ? "Codex"
                : provider === "antigravity"
                  ? "Antigravity"
                  : provider === "gemini"
                    ? "Gemini"
                    : provider === "opencode"
                      ? "opencode"
                      : "pi";
            const budgetInput = budgetInputs[provider] ?? (config.monthlyBudget != null ? String(config.monthlyBudget) : "");
            return (
              <div key={provider} className="usage-provider-row">
                <span className="usage-provider-row__name">
                  {logo && <img src={logo} alt="" width={18} height={18} className={`shrink-0 ${getAssistantLogoClass(provider) ?? ""}`} />}
                  <span>{label}</span>
                </span>

                <button
                  onClick={() => void updateProvider(provider, { show: !config.show })}
                  className={`option-card option-card--compact ${config.show ? "selected" : ""}`}
                >
                  {config.show ? "On" : "Off"}
                </button>

                {config.show && (
                  <>
                    {(["subscription", "custom"] as BudgetMode[]).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => void updateProvider(provider, { budgetMode: mode })}
                        className={`option-card option-card--compact ${config.budgetMode === mode ? "selected" : ""}`}
                      >
                        <span className="capitalize">{mode}</span>
                      </button>
                    ))}

                    {config.budgetMode === "custom" && (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="decimal"
                        placeholder="$ / month"
                        value={budgetInput}
                        onChange={(event) =>
                          setBudgetInputs((prev) => ({ ...prev, [provider]: event.target.value }))
                        }
                        onBlur={() => {
                          const trimmed = budgetInput.trim();
                          const nextBudget = trimmed === "" ? null : Number(trimmed);
                          if (nextBudget == null || Number.isFinite(nextBudget)) {
                            void updateProvider(provider, { monthlyBudget: nextBudget });
                          }
                          setBudgetInputs((prev) => {
                            const next = { ...prev };
                            delete next[provider];
                            return next;
                          });
                        }}
                        className="usage-provider-row__budget-input"
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {usageIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving...</div>}
        {usageError && <div className="mt-2 text-sm text-red-300">{usageError}</div>}

        <p className="text-xs text-[var(--text-muted)] mt-4">
          Settings are saved to ~/.shep/config.yml
        </p>
      </section>

      {/* ── Updates ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Updates</h2>

        {updateStatus === "available" && (
          <div className="settings-meta-grid mb-4" style={{ border: "1px solid rgba(122,162,247,0.3)", borderRadius: 8, padding: 12 }}>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">New version</span>
              <span>{availableVersion}</span>
            </div>
            {releaseNotesUrl && (
              <div className="settings-meta-row">
                <span className="settings-meta-row__label">Release notes</span>
                <button
                  className="text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-transparent border-0 cursor-pointer p-0"
                  onClick={() => import("../../lib/tauri").then((mod) => mod.openUrl(releaseNotesUrl))}
                >
                  View on GitHub
                </button>
              </div>
            )}
            <button
              className="btn-primary mt-2"
              onClick={() => void downloadAndInstall()}
            >
              Download &amp; Install
            </button>
          </div>
        )}

        {updateStatus === "downloading" && (
          <div className="mb-4">
            <div className="update-progress-track mb-2">
              <div className="update-progress-fill" style={{ width: `${downloadProgress}%` }} />
            </div>
            <div className="text-xs text-[var(--text-muted)]">Downloading... {downloadProgress}%</div>
          </div>
        )}

        {updateStatus === "ready" && (
          <div className="mb-4">
            <div className="text-sm text-[var(--text-secondary)] mb-2">Update downloaded and ready to install.</div>
            <button className="btn-primary" onClick={() => void restartApp()}>
              Restart Now
            </button>
          </div>
        )}

        {updateStatus === "error" && updateError && (
          <div className="text-sm text-red-300 mb-4">{updateError}</div>
        )}

        {updateStatus !== "downloading" && updateStatus !== "ready" && (
          <button
            className="btn-primary"
            disabled={updateStatus === "checking"}
            onClick={() => void checkForUpdate()}
          >
            {updateStatus === "checking" ? "Checking..." : "Check for Updates"}
          </button>
        )}

        {updateStatus === "idle" && hasChecked && (
          <div className="text-xs text-[var(--text-muted)] mt-2">You're on the latest version.</div>
        )}
      </section>

      {/* ── About ───────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">About</h2>

        {appMeta ? (
          <div className="settings-meta-grid">
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">App</span>
              <span>{appMeta.name}</span>
            </div>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">Version</span>
              <span>{appMeta.version}</span>
            </div>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">Identifier</span>
              <span>{appMeta.identifier}</span>
            </div>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">Tauri</span>
              <span>{appMeta.tauriVersion}</span>
            </div>
          </div>
        ) : appMetaError ? (
          <div className="mt-2 text-sm text-red-300">{appMetaError}</div>
        ) : (
          <div className="mt-2 text-xs text-[var(--text-muted)]">Loading app info...</div>
        )}

        <p className="text-xs text-[var(--text-muted)] mt-4 max-w-lg leading-5">
          For tester reports, include the app version, what you were doing, and whether the issue happened in a packaged build or dev mode.
        </p>
      </section>
    </div>
  );
}
