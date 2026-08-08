use rusqlite::Connection;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct UsageDb {
    pub conn: Arc<Mutex<Connection>>,
}

impl UsageDb {
    /// Fallback: in-memory DB so the app still opens even if the disk DB fails.
    /// Usage data won't persist across restarts but nothing blocks.
    pub fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory()
            .expect("Failed to open in-memory SQLite — this should never fail");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .ok();
        let _ = migrate(&conn);
        let _ = seed_pricing(&conn);
        Self {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    pub fn open() -> Result<Self, String> {
        let db_path = db_path()?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create usage DB directory: {e}"))?;
        }
        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to open usage DB: {e}"))?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| format!("Failed to set DB pragmas: {e}"))?;

        migrate(&conn)?;
        seed_pricing(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

fn db_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".shep").join("usage.sqlite3"))
        .ok_or_else(|| "Unable to locate home directory".to_string())
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);")
        .map_err(|e| format!("Failed to create schema_version table: {e}"))?;

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                session_id TEXT NOT NULL,
                project TEXT,
                model TEXT,
                timestamp INTEGER NOT NULL,
                tokens_input INTEGER NOT NULL DEFAULT 0,
                tokens_output INTEGER NOT NULL DEFAULT 0,
                tokens_cache_write INTEGER NOT NULL DEFAULT 0,
                tokens_cache_read INTEGER NOT NULL DEFAULT 0,
                tokens_thoughts INTEGER NOT NULL DEFAULT 0,
                tokens_total INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_msg_provider_ts ON usage_messages(provider, timestamp);
            CREATE INDEX IF NOT EXISTS idx_msg_session ON usage_messages(provider, session_id);

            CREATE TABLE IF NOT EXISTS usage_daily (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                date TEXT NOT NULL,
                model TEXT,
                project TEXT,
                tokens_input INTEGER NOT NULL DEFAULT 0,
                tokens_output INTEGER NOT NULL DEFAULT 0,
                tokens_cache_write INTEGER NOT NULL DEFAULT 0,
                tokens_cache_read INTEGER NOT NULL DEFAULT 0,
                tokens_thoughts INTEGER NOT NULL DEFAULT 0,
                tokens_total INTEGER NOT NULL DEFAULT 0,
                message_count INTEGER NOT NULL DEFAULT 0,
                UNIQUE(provider, date, model, project)
            );

            CREATE TABLE IF NOT EXISTS ingest_cursors (
                file_path TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                byte_offset INTEGER NOT NULL,
                last_modified INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            INSERT INTO schema_version (version) VALUES (1);",
        )
        .map_err(|e| format!("Failed to run migration v1: {e}"))?;
    }

    if version < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS model_pricing (
                model_pattern TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                input_per_m REAL NOT NULL DEFAULT 0,
                output_per_m REAL NOT NULL DEFAULT 0,
                cache_read_per_m REAL NOT NULL DEFAULT 0,
                cache_write_per_m REAL NOT NULL DEFAULT 0,
                thoughts_per_m REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .map_err(|e| format!("Failed to create model_pricing table: {e}"))?;

        // Clear old codex data so it re-ingests from JSONL with full token breakdown
        conn.execute_batch(
            "DELETE FROM usage_messages WHERE provider = 'codex';
             DELETE FROM ingest_cursors WHERE provider = 'codex';
             INSERT INTO schema_version (version) VALUES (2);",
        )
        .map_err(|e| format!("Failed to run migration v2: {e}"))?;
    }

    let needs_v3 = version < 3
        || !column_exists(conn, "usage_messages", "pricing_provider")
        || !column_exists(conn, "usage_messages", "recorded_cost")
        || !column_exists(conn, "usage_daily", "pricing_provider")
        || !column_exists(conn, "usage_daily", "recorded_cost");

    if needs_v3 {
        ensure_column(conn, "usage_messages", "pricing_provider", "TEXT")?;
        ensure_column(conn, "usage_messages", "recorded_cost", "REAL")?;
        ensure_column(conn, "usage_daily", "pricing_provider", "TEXT")?;
        ensure_column(conn, "usage_daily", "recorded_cost", "REAL")?;

        conn.execute_batch(
            "UPDATE usage_messages
             SET pricing_provider = provider
             WHERE pricing_provider IS NULL OR pricing_provider = '';
             UPDATE usage_daily
             SET pricing_provider = provider
             WHERE pricing_provider IS NULL OR pricing_provider = '';
             INSERT INTO schema_version (version)
             SELECT 3
             WHERE COALESCE((SELECT MAX(version) FROM schema_version), 0) < 3;",
        )
        .map_err(|e| format!("Failed to run migration v3 data backfill: {e}"))?;
    }

    if version < 4 {
        conn.execute_batch(
            "DELETE FROM usage_messages WHERE provider = 'pi';
             DELETE FROM usage_daily WHERE provider = 'pi';
             DELETE FROM ingest_cursors WHERE provider = 'pi';
             INSERT INTO schema_version (version) VALUES (4);",
        )
        .map_err(|e| format!("Failed to run migration v4: {e}"))?;
    }

    if version < 5 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_projects (
                canonical_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                canonical_path TEXT,
                repo_root TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_aliases (
                raw_label TEXT NOT NULL,
                provider TEXT NOT NULL,
                canonical_id TEXT NOT NULL,
                confidence REAL NOT NULL,
                reviewed INTEGER NOT NULL DEFAULT 0,
                reason TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (raw_label, provider)
            );

            CREATE INDEX IF NOT EXISTS idx_project_aliases_canonical
                ON project_aliases(canonical_id);

            INSERT INTO schema_version (version) VALUES (5);",
        )
        .map_err(|e| format!("Failed to run migration v5: {e}"))?;
    }

    if version < 6 {
        conn.execute_batch(
            "UPDATE usage_messages SET pricing_provider = 'anthropic' WHERE pricing_provider = 'claude';
             UPDATE usage_messages SET pricing_provider = 'openai'    WHERE pricing_provider = 'codex';
             UPDATE usage_messages SET pricing_provider = 'google'    WHERE pricing_provider = 'gemini';
             UPDATE usage_daily   SET pricing_provider = 'anthropic' WHERE pricing_provider = 'claude';
             UPDATE usage_daily   SET pricing_provider = 'openai'    WHERE pricing_provider = 'codex';
             UPDATE usage_daily   SET pricing_provider = 'google'    WHERE pricing_provider = 'gemini';
             INSERT INTO schema_version (version) VALUES (6);"
        ).map_err(|e| format!("Failed to run migration v6: {e}"))?;
    }

    if version < 7 {
        conn.execute_batch(
            "DROP TABLE IF EXISTS model_pricing;
             CREATE TABLE model_pricing (
                provider TEXT NOT NULL,
                model_pattern TEXT NOT NULL,
                input_per_m REAL NOT NULL DEFAULT 0,
                output_per_m REAL NOT NULL DEFAULT 0,
                cache_read_per_m REAL NOT NULL DEFAULT 0,
                cache_write_per_m REAL NOT NULL DEFAULT 0,
                thoughts_per_m REAL NOT NULL DEFAULT 0,
                release_date TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (provider, model_pattern)
             );
             INSERT INTO schema_version (version) VALUES (7);",
        )
        .map_err(|e| format!("Failed to run migration v7: {e}"))?;
    }

    if version < 8 {
        conn.execute_batch(
            "UPDATE usage_messages SET pricing_provider = 'anthropic' WHERE pricing_provider = 'claude';
             UPDATE usage_messages SET pricing_provider = 'openai'    WHERE pricing_provider = 'codex';
             UPDATE usage_messages SET pricing_provider = 'google'    WHERE pricing_provider = 'gemini';
             UPDATE usage_daily   SET pricing_provider = 'anthropic' WHERE pricing_provider = 'claude';
             UPDATE usage_daily   SET pricing_provider = 'openai'    WHERE pricing_provider = 'codex';
             UPDATE usage_daily   SET pricing_provider = 'google'    WHERE pricing_provider = 'gemini';
             INSERT INTO schema_version (version) VALUES (8);"
        ).map_err(|e| format!("Failed to run migration v8: {e}"))?;
    }

    if version < 9 {
        conn.execute_batch(
            "DELETE FROM usage_messages WHERE provider = 'codex';
             DELETE FROM usage_daily WHERE provider = 'codex';
             DELETE FROM ingest_cursors WHERE provider = 'codex';
             INSERT INTO schema_version (version) VALUES (9);",
        )
        .map_err(|e| format!("Failed to run migration v9: {e}"))?;
    }

    if version < 10 {
        conn.execute_batch(
            "DELETE FROM usage_messages WHERE provider = 'antigravity';
             DELETE FROM usage_daily WHERE provider = 'antigravity';
             DELETE FROM ingest_cursors WHERE provider = 'antigravity';
             INSERT INTO schema_version (version) VALUES (10);",
        )
        .map_err(|e| format!("Failed to run migration v10: {e}"))?;
    }

    if version < 11 {
        if column_exists(conn, "usage_messages", "pricing_provider")
            && column_exists(conn, "usage_messages", "model")
        {
            conn.execute_batch(
                "UPDATE usage_messages
                 SET pricing_provider = 'google'
                 WHERE provider = 'antigravity' AND lower(COALESCE(model, '')) LIKE '%gemini%';
                 UPDATE usage_messages
                 SET pricing_provider = 'anthropic'
                 WHERE provider = 'antigravity' AND lower(COALESCE(model, '')) LIKE '%claude%';",
            )
            .map_err(|e| format!("Failed to run migration v11 usage_messages update: {e}"))?;
        }
        if column_exists(conn, "usage_daily", "pricing_provider")
            && column_exists(conn, "usage_daily", "model")
        {
            conn.execute_batch(
                "UPDATE usage_daily
                 SET pricing_provider = 'google'
                 WHERE provider = 'antigravity' AND lower(COALESCE(model, '')) LIKE '%gemini%';
                 UPDATE usage_daily
                 SET pricing_provider = 'anthropic'
                 WHERE provider = 'antigravity' AND lower(COALESCE(model, '')) LIKE '%claude%';",
            )
            .map_err(|e| format!("Failed to run migration v11 usage_daily update: {e}"))?;
        }
        conn.execute("INSERT INTO schema_version (version) VALUES (11)", [])
            .map_err(|e| format!("Failed to run migration v11: {e}"))?;
    }

    if version < 12 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_history (
                provider TEXT NOT NULL,
                session_id TEXT NOT NULL,
                project_path TEXT NOT NULL,
                title TEXT,
                model TEXT,
                started_at INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL,
                ended_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (provider, session_id)
             );
             CREATE INDEX IF NOT EXISTS idx_session_history_project_activity
                ON session_history(project_path, last_activity_at DESC);
             CREATE INDEX IF NOT EXISTS idx_session_history_activity
                ON session_history(last_activity_at DESC);
             INSERT INTO schema_version (version) VALUES (12);",
        )
        .map_err(|e| format!("Failed to run migration v12: {e}"))?;
    }

    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let pragma = format!("PRAGMA table_info({table})");
    let mut stmt = match conn.prepare(&pragma) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };

    let rows = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows,
        Err(_) => return false,
    };

    let exists = rows.filter_map(|row| row.ok()).any(|name| name == column);
    exists
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if column_exists(conn, table, column) {
        return Ok(());
    }

    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    conn.execute(&sql, [])
        .map_err(|e| format!("Failed adding column {table}.{column}: {e}"))?;
    Ok(())
}

fn seed_pricing(conn: &Connection) -> Result<(), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PricingSeedRow {
        provider: String,
        model_pattern: String,
        input_per_m: f64,
        output_per_m: f64,
        cache_read_per_m: f64,
        cache_write_per_m: f64,
        thoughts_per_m: f64,
        release_date: Option<String>,
    }

    let rows: Vec<PricingSeedRow> =
        serde_json::from_str(include_str!("model_pricing_snapshot.json"))
            .map_err(|e| format!("Failed to parse bundled pricing snapshot: {e}"))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start pricing seed transaction: {e}"))?;

    tx.execute("DELETE FROM model_pricing", [])
        .map_err(|e| format!("Failed to clear pricing snapshot: {e}"))?;

    for row in rows {
        tx.execute(
            "INSERT OR REPLACE INTO model_pricing (provider, model_pattern, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, thoughts_per_m, release_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                row.provider,
                row.model_pattern,
                row.input_per_m,
                row.output_per_m,
                row.cache_read_per_m,
                row.cache_write_per_m,
                row.thoughts_per_m,
                row.release_date,
            ],
        ).map_err(|e| format!("Failed to seed pricing: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit pricing seed: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_migrates_and_seeds_pricing() {
        let conn = Connection::open_in_memory().unwrap();

        migrate(&conn).unwrap();
        seed_pricing(&conn).unwrap();

        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let pricing_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM model_pricing", [], |row| row.get(0))
            .unwrap();

        let history_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'session_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(version, 12);
        assert_eq!(history_table, 1);
        assert!(pricing_rows > 0);
    }

    #[test]
    fn v8_normalizes_stale_pricing_provider_keys() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (7);
             CREATE TABLE usage_messages (provider TEXT, pricing_provider TEXT, recorded_cost REAL);
             CREATE TABLE usage_daily (provider TEXT, pricing_provider TEXT, recorded_cost REAL);
             CREATE TABLE ingest_cursors (provider TEXT);
             INSERT INTO usage_messages (provider, pricing_provider) VALUES ('claude', 'claude'), ('codex', 'codex'), ('gemini', 'gemini'), ('claude', 'anthropic');
             INSERT INTO usage_daily (provider, pricing_provider) VALUES ('claude', 'claude'), ('codex', 'codex'), ('gemini', 'gemini'), ('gemini', 'google');"
        ).unwrap();

        migrate(&conn).unwrap();

        let stale_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT pricing_provider FROM usage_messages
                    UNION ALL
                    SELECT pricing_provider FROM usage_daily
                 ) WHERE pricing_provider IN ('claude', 'codex', 'gemini')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(stale_count, 0);
        assert_eq!(version, 12);
    }

    #[test]
    fn v9_clears_codex_usage_for_timestamp_reingest() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (8);
             CREATE TABLE usage_messages (provider TEXT);
             CREATE TABLE usage_daily (provider TEXT);
             CREATE TABLE ingest_cursors (provider TEXT);
             INSERT INTO usage_messages (provider) VALUES ('codex'), ('claude');
             INSERT INTO usage_daily (provider) VALUES ('codex'), ('claude');
             INSERT INTO ingest_cursors (provider) VALUES ('codex'), ('claude');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let codex_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT provider FROM usage_messages
                    UNION ALL
                    SELECT provider FROM usage_daily
                    UNION ALL
                    SELECT provider FROM ingest_cursors
                 ) WHERE provider = 'codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let claude_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT provider FROM usage_messages
                    UNION ALL
                    SELECT provider FROM usage_daily
                    UNION ALL
                    SELECT provider FROM ingest_cursors
                 ) WHERE provider = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(codex_rows, 0);
        assert_eq!(claude_rows, 3);
        assert_eq!(version, 12);
    }

    #[test]
    fn v10_clears_antigravity_usage_for_model_reingest() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (9);
             CREATE TABLE usage_messages (provider TEXT);
             CREATE TABLE usage_daily (provider TEXT);
             CREATE TABLE ingest_cursors (provider TEXT);
             INSERT INTO usage_messages (provider) VALUES ('antigravity'), ('claude');
             INSERT INTO usage_daily (provider) VALUES ('antigravity'), ('claude');
             INSERT INTO ingest_cursors (provider) VALUES ('antigravity'), ('claude');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let antigravity_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT provider FROM usage_messages
                    UNION ALL
                    SELECT provider FROM usage_daily
                    UNION ALL
                    SELECT provider FROM ingest_cursors
                 ) WHERE provider = 'antigravity'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let claude_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT provider FROM usage_messages
                    UNION ALL
                    SELECT provider FROM usage_daily
                    UNION ALL
                    SELECT provider FROM ingest_cursors
                 ) WHERE provider = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(antigravity_rows, 0);
        assert_eq!(claude_rows, 3);
        assert_eq!(version, 12);
    }

    #[test]
    fn v11_maps_antigravity_pricing_to_underlying_provider() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (10);
             CREATE TABLE usage_messages (provider TEXT, model TEXT, pricing_provider TEXT);
             CREATE TABLE usage_daily (provider TEXT, model TEXT, pricing_provider TEXT);
             INSERT INTO usage_messages (provider, model, pricing_provider) VALUES
                ('antigravity', 'Gemini 3.5 Flash (Medium)', 'antigravity'),
                ('antigravity', 'Claude Sonnet 4.6 (Thinking)', 'antigravity'),
                ('antigravity', 'GPT-OSS 120B', 'antigravity');
             INSERT INTO usage_daily (provider, model, pricing_provider) VALUES
                ('antigravity', 'Gemini 3.5 Flash (Medium)', 'antigravity'),
                ('antigravity', 'Claude Sonnet 4.6 (Thinking)', 'antigravity');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let google_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT pricing_provider FROM usage_messages
                    UNION ALL
                    SELECT pricing_provider FROM usage_daily
                 ) WHERE pricing_provider = 'google'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let anthropic_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT pricing_provider FROM usage_messages
                    UNION ALL
                    SELECT pricing_provider FROM usage_daily
                 ) WHERE pricing_provider = 'anthropic'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let unknown_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage_messages
                 WHERE model = 'GPT-OSS 120B' AND pricing_provider = 'antigravity'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(google_rows, 2);
        assert_eq!(anthropic_rows, 2);
        assert_eq!(unknown_rows, 1);
        assert_eq!(version, 12);
    }
}
