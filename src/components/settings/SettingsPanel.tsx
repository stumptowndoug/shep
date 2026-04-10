import { useEffect, useState } from "react";
import { getIdentifier, getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { EDITOR_OPTIONS } from "../../lib/editors";
import { DARK_THEMES, LIGHT_THEMES, TRANSPARENT_THEMES } from "../../lib/themes";
import { KEYBINDING_PRESETS } from "../../lib/keybindingPresets";
import { useEditorStore } from "../../stores/useEditorStore";
import { useThemeStore } from "../../stores/useThemeStore";
import { useKeybindingStore } from "../../stores/useKeybindingStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";
import { useUsageSettingsStore } from "../../stores/useUsageSettingsStore";
import { useUpdateStore } from "../../stores/useUpdateStore";
import { assistantLogoSrc, getAssistantLogoClass } from "../../lib/assistantLogos";
import {
  displayTerminalFontFamily,
  FONT_OPTIONS,
  FONT_SIZE_OPTIONS,
  normalizeTerminalFontFamily,
} from "../../lib/terminalConfig";
import type { CursorStyle, UsageProvider } from "../../lib/types";
import { getErrorMessage } from "../../lib/errors";

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
  const [customFontInput, setCustomFontInput] = useState(() =>
    displayTerminalFontFamily(useTerminalSettingsStore.getState().settings.fontFamily)
  );
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
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
  const setProviderEnabled = useUsageSettingsStore((s) => s.setProviderEnabled);

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
    if (!kbHasLoaded) void loadKbSettings();
    if (!termHasLoaded) void loadTermSettings();
    if (!usageHasLoaded) void loadUsageSettings();
  }, [hasLoaded, loadSettings, kbHasLoaded, loadKbSettings, termHasLoaded, loadTermSettings, usageHasLoaded, loadUsageSettings]);

  useEffect(() => {
    setCustomFontInput(displayTerminalFontFamily(termSettings.fontFamily));
  }, [termSettings.fontFamily]);

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

  return (
    <div className="absolute inset-0 overflow-y-auto p-6">
      {/* ── Theme ──────────────────────────────────────────── */}
      {/* ── Theme ──────────────────────────────────────────── */}
      <h2 className="section-label !p-0 mb-4">Theme</h2>

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

      <p className="text-xs text-[var(--text-muted)] mt-4">
        Note: CLI tools may need to be relaunched after switching themes. Use /theme to select light or dark if not updating.
      </p>

      <hr className="settings-divider" />

      {/* ── Editor ─────────────────────────────────────────── */}
      <h2 className="section-label !p-0 mb-4">Editor</h2>

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

      <hr className="settings-divider" />

      {/* ── Keybindings ────────────────────────────────────── */}
      <h2 className="section-label !p-0 mb-4">Keybindings</h2>

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

      <hr className="settings-divider" />

      {/* ── Terminal ───────────────────────────────────────── */}
      <h2 className="section-label !p-0 mb-4">Terminal</h2>

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
        <span className="settings-row__label">Font</span>
        <div className="flex flex-wrap gap-2">
          {FONT_OPTIONS.map((font) => (
            <button
              key={font.id}
              onClick={() => {
                setCustomFontInput("");
                void updateTermSettings({ fontFamily: font.id });
              }}
              className={`option-card option-card--compact ${termSettings.fontFamily === font.id ? "selected" : ""}`}
            >
              <span>{font.label}</span>
            </button>
          ))}
          <input
            type="text"
            placeholder="Custom font name..."
            className={`option-card option-card--compact w-48 bg-transparent text-sm ${!FONT_OPTIONS.some((f) => f.id === termSettings.fontFamily) && customFontInput ? "selected" : ""}`}
            value={customFontInput}
            onChange={(e) => {
              setCustomFontInput(e.target.value);
            }}
            onBlur={() => {
              if (customFontInput.trim()) {
                void updateTermSettings({ fontFamily: normalizeTerminalFontFamily(customFontInput) });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
          />
        </div>
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

      <div className="settings-row">
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

      <hr className="settings-divider" />

      {/* ── Usage ──────────────────────────────────────────── */}
      <h2 className="section-label !p-0 mb-4">Usage Providers</h2>

      <div className="flex flex-wrap gap-3">
        {(["claude", "codex", "gemini", "opencode"] as UsageProvider[]).map((provider) => {
          const key = provider === "claude" ? "showClaude" : provider === "codex" ? "showCodex" : provider === "gemini" ? "showGemini" : "showOpencode";
          const active = usageSettings[key];
          const logo = assistantLogoSrc[provider];
          const label = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider === "gemini" ? "Gemini" : "OpenCode";
          return (
            <button
              key={provider}
              onClick={() => void setProviderEnabled(provider, !active)}
              className={`${optionClass} ${active ? "selected" : ""}`}
            >
              {logo && <img src={logo} alt="" width={20} height={20} className={`shrink-0 ${getAssistantLogoClass(provider) ?? ""}`} />}
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {usageIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving...</div>}
      {usageError && <div className="mt-2 text-sm text-red-300">{usageError}</div>}

      <p className="text-xs text-[var(--text-muted)] mt-6">
        Settings are saved to ~/.shep/config.yml
      </p>

      <hr className="settings-divider" />

      {/* ── Updates ─────────────────────────────────────────── */}
      <h2 className="section-label !p-0 mb-4">Updates</h2>

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

      <hr className="settings-divider" />

      <h2 className="section-label !p-0 mb-4">About</h2>

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
    </div>
  );
}
