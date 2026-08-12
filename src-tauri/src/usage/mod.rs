pub mod db;
mod helpers;
pub mod ingest;
mod providers;
mod queries;
pub mod types;

pub use db::UsageDb;
pub use types::{LocalUsageDetails, ProviderUsageSnapshot, UsageOverview, UsageProjectAliasReviewItem};

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use types::UsageWindowSnapshot;
use helpers::now_epoch_seconds;

/// Cooldown after a successful provider API call.
const COOLDOWN_SUCCESS_SECS: u64 = 300; // 5 minutes

/// Initial cooldown after a failed provider API call.
const COOLDOWN_ERROR_BASE_SECS: u64 = 30;

/// Maximum cooldown after repeated failures (caps the exponential backoff).
const COOLDOWN_ERROR_MAX_SECS: u64 = 300; // 5 minutes

struct ProviderState {
    cache: Option<ProviderCacheData>,
    fetched_at: u64,
    consecutive_errors: u32,
    last_error: String,
    last_error_logged: bool,
}

impl ProviderState {
    const fn new() -> Self {
        Self {
            cache: None,
            fetched_at: 0,
            consecutive_errors: 0,
            last_error: String::new(),
            last_error_logged: false,
        }
    }

    fn cooldown_secs(&self) -> u64 {
        if self.consecutive_errors == 0 {
            return COOLDOWN_SUCCESS_SECS;
        }
        // Exponential backoff: 30s, 60s, 120s, 240s, capped at 300s
        let backoff = COOLDOWN_ERROR_BASE_SECS * (1u64 << (self.consecutive_errors - 1).min(4));
        backoff.min(COOLDOWN_ERROR_MAX_SECS)
    }

    fn is_stale(&self, now: u64) -> bool {
        now - self.fetched_at >= self.cooldown_secs()
    }

    fn record_success(&mut self, now: u64) {
        self.fetched_at = now;
        self.consecutive_errors = 0;
        self.last_error.clear();
        self.last_error_logged = false;
    }

    fn record_error(&mut self, now: u64, error: &str) {
        self.fetched_at = now;
        // Only log if the error message changed or this is the first occurrence
        if self.last_error != error {
            self.last_error = error.to_string();
            self.last_error_logged = false;
        }
        if !self.last_error_logged {
            self.last_error_logged = true;
            // Will be logged by caller
        }
        self.consecutive_errors = self.consecutive_errors.saturating_add(1);
    }

    fn should_log_error(&self) -> bool {
        // Log on first occurrence or when error message changes
        // (last_error_logged is set to false when error changes)
        !self.last_error_logged
    }
}

enum ProviderCacheData {
    Claude(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>),
    Codex(Vec<UsageWindowSnapshot>),
    Cursor(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>),
    Gemini(Vec<UsageWindowSnapshot>),
    Antigravity(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>),
    Grok(Vec<UsageWindowSnapshot>),
}

struct ProviderCache {
    claude: ProviderState,
    codex: ProviderState,
    cursor: ProviderState,
    gemini: ProviderState,
    antigravity: ProviderState,
    grok: ProviderState,
}

static PROVIDER_CACHE: Mutex<ProviderCache> = Mutex::new(ProviderCache {
    claude: ProviderState::new(),
    codex: ProviderState::new(),
    cursor: ProviderState::new(),
    gemini: ProviderState::new(),
    antigravity: ProviderState::new(),
    grok: ProviderState::new(),
});

/// Which providers are enabled (passed from frontend settings).
pub struct EnabledProviders {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
    pub gemini: bool,
    pub antigravity: bool,
    pub grok: bool,
}

/// Fetch snapshots for all providers from whatever is currently in the DB.
/// Does NOT trigger ingestion — that runs in the background.
/// Provider API refresh happens in a background thread so this never blocks
/// on network I/O.
pub fn get_all_usage_snapshots(
    db: &UsageDb,
    enabled: &EnabledProviders,
    app: Option<tauri::AppHandle>,
) -> Vec<ProviderUsageSnapshot> {
    spawn_provider_refresh(enabled, app);

    let conn = db.conn.lock().unwrap();
    vec![
        claude_snapshot(&conn),
        codex_snapshot(&conn),
        cursor_snapshot(&conn),
        gemini_snapshot(&conn),
        antigravity_snapshot(&conn),
        grok_snapshot(&conn),
        opencode_snapshot(&conn),
        pi_snapshot(&conn),
    ]
}

/// Fetch snapshot for a single provider.
pub fn get_usage_snapshot(
    db: &UsageDb,
    provider: &str,
    enabled: &EnabledProviders,
    app: Option<tauri::AppHandle>,
) -> Result<ProviderUsageSnapshot, String> {
    spawn_provider_refresh(enabled, app);

    let conn = db.conn.lock().unwrap();
    match provider {
        "codex" => Ok(codex_snapshot(&conn)),
        "cursor" => Ok(cursor_snapshot(&conn)),
        "claude" => Ok(claude_snapshot(&conn)),
        "gemini" => Ok(gemini_snapshot(&conn)),
        "antigravity" => Ok(antigravity_snapshot(&conn)),
        "grok" => Ok(grok_snapshot(&conn)),
        "opencode" => Ok(opencode_snapshot(&conn)),
        "pi" => Ok(pi_snapshot(&conn)),
        other => Err(format!("Unsupported usage provider: {other}")),
    }
}

/// Fetch local details for a provider scoped to a time window (5h, 7d, 30d).
pub fn get_windowed_details(db: &UsageDb, provider: &str, window: &str) -> Result<LocalUsageDetails, String> {
    let conn = db.conn.lock().unwrap();
    queries::windowed_details(&conn, provider, window)
        .ok_or_else(|| format!("No data for {provider}/{window}"))
}

pub fn get_usage_overview(db: &UsageDb, window: &str) -> Result<UsageOverview, String> {
    let conn = db.conn.lock().unwrap();
    queries::usage_overview(&conn, window)
        .ok_or_else(|| format!("Unsupported usage overview window: {window}"))
}

pub fn get_project_alias_review_queue(db: &UsageDb) -> Vec<UsageProjectAliasReviewItem> {
    let conn = db.conn.lock().unwrap();
    queries::project_alias_review_queue(&conn)
}

pub fn get_models_for_provider(db: &UsageDb, provider: &str) -> Vec<String> {
    let conn = db.conn.lock().unwrap();
    queries::models_for_provider(&conn, provider)
}

/// Run background ingestion in a loop until fully caught up.
/// Processes a small batch per cycle and releases the DB lock between cycles
/// so UI queries (usage snapshots, etc.) aren't starved.
pub fn run_background_ingest(db: &UsageDb) {
    loop {
        let done = {
            let conn = db.conn.lock().unwrap();
            ingest::ingest_all(&conn)
        };
        if done {
            break;
        }
        // Yield for long enough that any queued UI query can grab the lock
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Whether a provider refresh is already in flight (prevents piling up threads).
static PROVIDER_REFRESH_RUNNING: AtomicBool = AtomicBool::new(false);

/// Spawn a background thread to refresh provider API data if cooldown has
/// elapsed. Returns immediately — never blocks the calling thread on network I/O.
fn spawn_provider_refresh(enabled: &EnabledProviders, app: Option<tauri::AppHandle>) {
    let now = now_epoch_seconds();
    let (
        refresh_claude,
        refresh_codex,
        refresh_cursor,
        refresh_gemini,
        refresh_antigravity,
        refresh_grok,
    ) = {
        let cache = PROVIDER_CACHE.lock().unwrap();
        (
            enabled.claude && cache.claude.is_stale(now),
            enabled.codex && cache.codex.is_stale(now),
            enabled.cursor && cache.cursor.is_stale(now),
            enabled.gemini && cache.gemini.is_stale(now),
            enabled.antigravity && cache.antigravity.is_stale(now),
            enabled.grok && cache.grok.is_stale(now),
        )
    };

    if !refresh_claude
        && !refresh_codex
        && !refresh_cursor
        && !refresh_gemini
        && !refresh_antigravity
        && !refresh_grok
    {
        return;
    }

    // Only allow one refresh thread at a time
    if PROVIDER_REFRESH_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    let do_claude = refresh_claude;
    let do_codex = refresh_codex;
    let do_cursor = refresh_cursor;
    let do_gemini = refresh_gemini;
    let do_antigravity = refresh_antigravity;
    let do_grok = refresh_grok;
    std::thread::spawn(move || {
        refresh_provider_cache_sync(
            do_claude,
            do_codex,
            do_cursor,
            do_gemini,
            do_antigravity,
            do_grok,
            app,
        );
        PROVIDER_REFRESH_RUNNING.store(false, Ordering::SeqCst);
    });
}

fn emit_provider_refresh(app: &Option<tauri::AppHandle>) {
    if let Some(app) = app {
        let _ = app.emit("usage-provider-refresh-complete", ());
    }
}

/// Actual (blocking) provider refresh — only called from background thread.
fn refresh_provider_cache_sync(
    do_claude: bool,
    do_codex: bool,
    do_cursor: bool,
    do_gemini: bool,
    do_antigravity: bool,
    do_grok: bool,
    app: Option<tauri::AppHandle>,
) {
    let now = now_epoch_seconds();

    if do_claude {
        match providers::claude_provider_windows() {
            Ok(data) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                cache.claude.cache = Some(ProviderCacheData::Claude(data.0, data.1));
                cache.claude.record_success(now);
            }
            Err(e) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                let should_log = cache.claude.should_log_error() || cache.claude.last_error != e;
                cache.claude.record_error(now, &e);
                if should_log {
                    eprintln!("Claude provider API error (using cache): {e}");
                }
            }
        }
        emit_provider_refresh(&app);
    }

    if do_codex {
        match providers::codex_provider_windows() {
            Ok(data) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                cache.codex.cache = Some(ProviderCacheData::Codex(data));
                cache.codex.record_success(now);
            }
            Err(e) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                let should_log = cache.codex.should_log_error() || cache.codex.last_error != e;
                cache.codex.record_error(now, &e);
                if should_log {
                    eprintln!("Codex provider API error (using cache): {e}");
                }
            }
        }
        emit_provider_refresh(&app);
    }

    if do_cursor {
        match providers::cursor_provider_windows() {
            Ok(data) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                cache.cursor.cache = Some(ProviderCacheData::Cursor(data.0, data.1));
                cache.cursor.record_success(now);
            }
            Err(e) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                let should_log = cache.cursor.should_log_error() || cache.cursor.last_error != e;
                cache.cursor.record_error(now, &e);
                if should_log {
                    eprintln!("Cursor provider API error (using cache): {e}");
                }
            }
        }
        emit_provider_refresh(&app);
    }

    if do_gemini {
        match providers::gemini_provider_windows() {
            Ok(data) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                cache.gemini.cache = Some(ProviderCacheData::Gemini(data));
                cache.gemini.record_success(now);
            }
            Err(e) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                let should_log = cache.gemini.should_log_error() || cache.gemini.last_error != e;
                cache.gemini.record_error(now, &e);
                if should_log {
                    eprintln!("Gemini provider API error (using cache): {e}");
                }
            }
        }
        emit_provider_refresh(&app);
    }

    if do_grok {
        match providers::grok_provider_windows() {
            Ok(data) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                cache.grok.cache = Some(ProviderCacheData::Grok(data));
                cache.grok.record_success(now);
            }
            Err(e) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                let should_log = cache.grok.should_log_error() || cache.grok.last_error != e;
                cache.grok.record_error(now, &e);
                if should_log {
                    eprintln!("Grok provider API error (using cache): {e}");
                }
            }
        }
        emit_provider_refresh(&app);
    }

    if do_antigravity {
        match providers::antigravity_provider_windows() {
            Ok(data) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                cache.antigravity.cache = Some(ProviderCacheData::Antigravity(data.0, data.1));
                cache.antigravity.record_success(now);
            }
            Err(e) => {
                let mut cache = PROVIDER_CACHE.lock().unwrap();
                let should_log = cache.antigravity.should_log_error() || cache.antigravity.last_error != e;
                cache.antigravity.record_error(now, &e);
                if should_log {
                    eprintln!("Antigravity provider API error (using cache): {e}");
                }
            }
        }
        emit_provider_refresh(&app);
    }
}

fn codex_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let local = queries::local_details(conn, "codex");
    let cache = PROVIDER_CACHE.lock().unwrap();
    let cached_windows: Option<Vec<UsageWindowSnapshot>> = match &cache.codex.cache {
        Some(ProviderCacheData::Codex(w)) => Some(w.clone()),
        _ => None,
    };
    drop(cache);

    let mut summary_windows = Vec::new();
    let has_provider = cached_windows.is_some();

    if let Some(ref windows) = cached_windows {
        summary_windows.extend(windows.clone());
    }

    if let Some(ref details) = local {
        summary_windows.push(UsageWindowSnapshot {
            provider: "codex".to_string(),
            window_id: "codex-local-30d".to_string(),
            window: "30d".to_string(),
            label: "30d".to_string(),
            scope: "reporting".to_string(),
            limit: None,
            used: None,
            source_type: "local".to_string(),
            confidence: "observed".to_string(),
            cost_kind: "estimated".to_string(),
            used_percent: None,
            remaining_percent: None,
            reset_at: None,
            token_total: Some(details.tokens_30d),
            pace_status: None,
        });
    }

    ProviderUsageSnapshot {
        provider: "codex".to_string(),
        status: if has_provider { "ready".to_string() } else { "partial".to_string() },
        fetched_at,
        summary_windows,
        extra_windows: Vec::new(),
        local_details: local,
        error: None,
    }
}

fn cursor_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let cache = PROVIDER_CACHE.lock().unwrap();
    let cached_data = match &cache.cursor.cache {
        Some(ProviderCacheData::Cursor(summary, extra)) => Some((summary.clone(), extra.clone())),
        _ => None,
    };
    let error = if cached_data.is_none() && !cache.cursor.last_error.is_empty() {
        Some(cache.cursor.last_error.clone())
    } else {
        None
    };
    drop(cache);
    let _ = conn;

    let (summary_windows, extra_windows) = cached_data.unwrap_or_default();
    ProviderUsageSnapshot {
        provider: "cursor".to_string(),
        status: if summary_windows.is_empty() { "unavailable".to_string() } else { "ready".to_string() },
        fetched_at,
        summary_windows,
        extra_windows,
        local_details: None,
        error,
    }
}

fn claude_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let local = queries::local_details(conn, "claude");
    let cache = PROVIDER_CACHE.lock().unwrap();
    let cached_data: Option<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>)> = match &cache.claude.cache {
        Some(ProviderCacheData::Claude(p, e)) => Some((p.clone(), e.clone())),
        _ => None,
    };
    drop(cache);

    let mut summary_windows = Vec::new();
    let mut extra_windows = Vec::new();
    let has_provider = cached_data.is_some();

    if let Some((ref primary, ref extra)) = cached_data {
        summary_windows.extend(primary.clone());
        extra_windows.extend(extra.clone());
    }

    if let Some(ref details) = local {
        summary_windows.push(UsageWindowSnapshot {
            provider: "claude".to_string(),
            window_id: "claude-local-30d".to_string(),
            window: "30d".to_string(),
            label: "30d".to_string(),
            scope: "reporting".to_string(),
            limit: None,
            used: None,
            source_type: "local".to_string(),
            confidence: "observed".to_string(),
            cost_kind: "estimated".to_string(),
            used_percent: None,
            remaining_percent: None,
            reset_at: None,
            token_total: Some(details.tokens_30d),
            pace_status: None,
        });
    }

    ProviderUsageSnapshot {
        provider: "claude".to_string(),
        status: if has_provider { "ready".to_string() } else { "partial".to_string() },
        fetched_at,
        summary_windows,
        extra_windows,
        local_details: local,
        error: None,
    }
}

fn gemini_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let local = queries::local_details(conn, "gemini");
    let cache = PROVIDER_CACHE.lock().unwrap();
    let cached_windows: Option<Vec<UsageWindowSnapshot>> = match &cache.gemini.cache {
        Some(ProviderCacheData::Gemini(w)) => Some(w.clone()),
        _ => None,
    };
    drop(cache);

    let mut summary_windows = Vec::new();
    let has_provider = cached_windows.is_some();

    if let Some(ref windows) = cached_windows {
        summary_windows.extend(windows.clone());
    }

    if let Some(ref details) = local {
        for (window, tokens) in [("5h", details.tokens_5h), ("7d", details.tokens_7d), ("30d", details.tokens_30d)] {
            summary_windows.push(UsageWindowSnapshot {
                provider: "gemini".to_string(),
                window_id: format!("gemini-local-{window}"),
                window: window.to_string(),
                label: window.to_string(),
                scope: "reporting".to_string(),
                limit: None,
                used: None,
                source_type: "local".to_string(),
                confidence: "observed".to_string(),
                cost_kind: "estimated".to_string(),
                used_percent: None,
                remaining_percent: None,
                reset_at: None,
                token_total: Some(tokens),
                pace_status: None,
            });
        }
    }

    ProviderUsageSnapshot {
        provider: "gemini".to_string(),
        status: if has_provider { "ready".to_string() } else if local.is_some() { "partial".to_string() } else { "unavailable".to_string() },
        fetched_at,
        summary_windows,
        extra_windows: Vec::new(),
        local_details: local,
        error: None,
    }
}

fn antigravity_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let local = queries::local_details(conn, "antigravity");
    let cache = PROVIDER_CACHE.lock().unwrap();
    let cached_data: Option<(Vec<UsageWindowSnapshot>, Vec<UsageWindowSnapshot>)> = match &cache.antigravity.cache {
        Some(ProviderCacheData::Antigravity(summary, extra)) => Some((summary.clone(), extra.clone())),
        _ => None,
    };
    let error = if cached_data.is_none() && !cache.antigravity.last_error.is_empty() {
        Some(cache.antigravity.last_error.clone())
    } else {
        None
    };
    drop(cache);

    let (mut summary_windows, extra_windows, status) = match cached_data {
        Some((summary, extra)) => (summary, extra, "ready".to_string()),
        None if local.is_some() => (Vec::new(), Vec::new(), "partial".to_string()),
        None => (Vec::new(), Vec::new(), "unavailable".to_string()),
    };

    if let Some(ref details) = local {
        for (window, tokens) in [("5h", details.tokens_5h), ("7d", details.tokens_7d), ("30d", details.tokens_30d)] {
            summary_windows.push(UsageWindowSnapshot {
                provider: "antigravity".to_string(),
                window_id: format!("antigravity-local-{window}"),
                window: window.to_string(),
                label: window.to_string(),
                scope: "reporting".to_string(),
                limit: None,
                used: None,
                source_type: "local".to_string(),
                confidence: "estimated".to_string(),
                cost_kind: "unknown".to_string(),
                used_percent: None,
                remaining_percent: None,
                reset_at: None,
                token_total: Some(tokens),
                pace_status: None,
            });
        }
    }

    ProviderUsageSnapshot {
        provider: "antigravity".to_string(),
        status,
        fetched_at,
        summary_windows,
        extra_windows,
        local_details: local,
        error,
    }
}

fn grok_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let cache = PROVIDER_CACHE.lock().unwrap();
    let cached_windows: Option<Vec<UsageWindowSnapshot>> = match &cache.grok.cache {
        Some(ProviderCacheData::Grok(windows)) => Some(windows.clone()),
        _ => None,
    };
    let error = if cached_windows.is_none() && !cache.grok.last_error.is_empty() {
        Some(cache.grok.last_error.clone())
    } else {
        None
    };
    drop(cache);
    let _ = conn;

    ProviderUsageSnapshot {
        provider: "grok".to_string(),
        status: if cached_windows.is_some() { "ready".to_string() } else { "unavailable".to_string() },
        fetched_at,
        summary_windows: cached_windows.unwrap_or_default(),
        extra_windows: Vec::new(),
        local_details: None,
        error,
    }
}

fn opencode_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let local = queries::local_details(conn, "opencode");
    let mut summary_windows = Vec::new();

    if let Some(ref details) = local {
        for (window, tokens) in [("5h", details.tokens_5h), ("7d", details.tokens_7d), ("30d", details.tokens_30d)] {
            summary_windows.push(UsageWindowSnapshot {
                provider: "opencode".to_string(),
                window_id: format!("opencode-local-{window}"),
                window: window.to_string(),
                label: window.to_string(),
                scope: "reporting".to_string(),
                limit: None,
                used: None,
                source_type: "local".to_string(),
                confidence: "observed".to_string(),
                cost_kind: "mixed".to_string(),
                used_percent: None,
                remaining_percent: None,
                reset_at: None,
                token_total: Some(tokens),
                pace_status: None,
            });
        }
    }

    ProviderUsageSnapshot {
        provider: "opencode".to_string(),
        status: if local.is_some() { "ready".to_string() } else { "unavailable".to_string() },
        fetched_at,
        summary_windows,
        extra_windows: Vec::new(),
        local_details: local,
        error: None,
    }
}

fn pi_snapshot(conn: &rusqlite::Connection) -> ProviderUsageSnapshot {
    let fetched_at = helpers::now_iso_string();
    let local = queries::local_details(conn, "pi");
    let mut summary_windows = Vec::new();

    if let Some(ref details) = local {
        for (window, tokens) in [("5h", details.tokens_5h), ("7d", details.tokens_7d), ("30d", details.tokens_30d)] {
            summary_windows.push(UsageWindowSnapshot {
                provider: "pi".to_string(),
                window_id: format!("pi-local-{window}"),
                window: window.to_string(),
                label: window.to_string(),
                scope: "reporting".to_string(),
                limit: None,
                used: None,
                source_type: "local".to_string(),
                confidence: "observed".to_string(),
                cost_kind: "mixed".to_string(),
                used_percent: None,
                remaining_percent: None,
                reset_at: None,
                token_total: Some(tokens),
                pace_status: None,
            });
        }
    }

    ProviderUsageSnapshot {
        provider: "pi".to_string(),
        status: if local.is_some() { "ready".to_string() } else { "unavailable".to_string() },
        fetched_at,
        summary_windows,
        extra_windows: Vec::new(),
        local_details: local,
        error: None,
    }
}
