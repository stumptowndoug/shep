use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::types::{
    LocalUsageDetails, UsageBreakdownItem, UsageNamedTokens, UsageOverview,
    UsageOverviewProvider, UsageProject, UsageTask, UsageTrendBucket,
    UsageCost, UsageProjectAliasReviewItem, UsageTrendProviderValue,
};
use super::helpers::now_epoch_seconds;


/// Pricing rates per million tokens for a model.
struct ModelPricing {
    input_per_m: f64,
    output_per_m: f64,
    cache_read_per_m: f64,
    cache_write_per_m: f64,
    thoughts_per_m: f64,
}

type PricingMap = HashMap<(String, String), ModelPricing>;

/// Load all pricing patterns from the DB.
fn load_pricing(conn: &Connection) -> PricingMap {
    let mut map = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT provider, model_pattern, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, thoughts_per_m FROM model_pricing"
    ) {
        Ok(s) => s,
        Err(_) => return map,
    };

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            ModelPricing {
                input_per_m: row.get(2)?,
                output_per_m: row.get(3)?,
                cache_read_per_m: row.get(4)?,
                cache_write_per_m: row.get(5)?,
                thoughts_per_m: row.get(6)?,
            },
        ))
    });

    if let Ok(rows) = rows {
        for row in rows.flatten() {
            map.insert((row.0, row.1), row.2);
        }
    }
    map
}

/// Match a model name to a pricing pattern (prefix match).
fn find_pricing<'a>(provider: &str, model: &str, pricing: &'a PricingMap) -> Option<&'a ModelPricing> {
    let aliases = pricing_model_aliases(model);
    let mut best_match: Option<(&str, &ModelPricing)> = None;
    for alias in aliases {
        if let Some(p) = pricing.get(&(provider.to_string(), alias.clone())) {
            return Some(p);
        }
        for ((pricing_provider, pattern), p) in pricing {
            if pricing_provider == provider && alias.starts_with(pattern.as_str()) {
                match best_match {
                    Some((prev, _)) if pattern.len() > prev.len() => best_match = Some((pattern, p)),
                    None => best_match = Some((pattern, p)),
                    _ => {}
                }
            }
        }
    }
    best_match.map(|(_, p)| p)
}

fn pricing_model_aliases(model: &str) -> Vec<String> {
    let mut aliases = vec![model.to_string()];
    let lower = model.to_ascii_lowercase();

    if lower.contains("gemini 3.5 flash") {
        aliases.push("gemini-3.5-flash".to_string());
    } else if lower.contains("gemini 3.1 pro") {
        aliases.push("gemini-3.1-pro-preview".to_string());
    } else if lower.contains("gemini 3.1 flash") && lower.contains("image") {
        aliases.push("gemini-3.1-flash-image-preview".to_string());
    } else if lower.contains("gemini 3.1 flash") {
        aliases.push("gemini-3.1-flash-lite".to_string());
    } else if lower.contains("gemini 3 pro") && lower.contains("image") {
        aliases.push("gemini-3-pro-image-preview".to_string());
    } else if lower.contains("gemini 3 pro") {
        aliases.push("gemini-3-pro-preview".to_string());
    } else if lower.contains("gemini 3 flash") {
        aliases.push("gemini-3-flash-preview".to_string());
    } else if lower.contains("gemini 2.5 pro") {
        aliases.push("gemini-2.5-pro".to_string());
    } else if lower.contains("gemini 2.5 flash") && lower.contains("lite") {
        aliases.push("gemini-2.5-flash-lite".to_string());
    } else if lower.contains("gemini 2.5 flash") {
        aliases.push("gemini-2.5-flash".to_string());
    } else if lower.contains("gemini 2.0 flash") && lower.contains("lite") {
        aliases.push("gemini-2.0-flash-lite".to_string());
    } else if lower.contains("gemini 2.0 flash") {
        aliases.push("gemini-2.0-flash".to_string());
    }

    if lower.contains("claude sonnet 4.6") {
        aliases.push("claude-sonnet-4-6".to_string());
    } else if lower.contains("claude sonnet 4.5") {
        aliases.push("claude-sonnet-4-5".to_string());
    } else if lower.contains("claude sonnet 4") {
        aliases.push("claude-sonnet-4-0".to_string());
    } else if lower.contains("claude opus 4.8") {
        aliases.push("claude-opus-4-8".to_string());
    } else if lower.contains("claude opus 4.7") {
        aliases.push("claude-opus-4-7".to_string());
    } else if lower.contains("claude opus 4.6") {
        aliases.push("claude-opus-4-6".to_string());
    } else if lower.contains("claude opus 4.5") {
        aliases.push("claude-opus-4-5".to_string());
    } else if lower.contains("claude opus 4.1") {
        aliases.push("claude-opus-4-1".to_string());
    } else if lower.contains("claude opus 4") {
        aliases.push("claude-opus-4-0".to_string());
    } else if lower.contains("claude haiku 4.5") {
        aliases.push("claude-haiku-4-5".to_string());
    } else if lower.contains("claude fable 5") {
        aliases.push("claude-fable-5".to_string());
    }

    aliases
}

struct CostTokens {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    thoughts: i64,
}

/// Calculate cost in USD for a set of token counts.
fn calculate_cost(pricing: &ModelPricing, tokens: &CostTokens) -> f64 {
    (tokens.input as f64 * pricing.input_per_m
        + tokens.output as f64 * pricing.output_per_m
        + tokens.cache_read as f64 * pricing.cache_read_per_m
        + tokens.cache_write as f64 * pricing.cache_write_per_m
        + tokens.thoughts as f64 * pricing.thoughts_per_m)
        / 1_000_000.0
}

fn cost_detail(amount: Option<f64>, kind: &str, basis: &str, confidence: &str) -> UsageCost {
    UsageCost {
        amount,
        kind: kind.to_string(),
        basis: basis.to_string(),
        confidence: confidence.to_string(),
    }
}

fn unknown_cost() -> UsageCost {
    cost_detail(None, "unknown", "none", "observed")
}

fn resolved_cost_detail(
    pricing_provider: &str,
    model: &str,
    tokens: CostTokens,
    recorded_cost: f64,
    has_recorded_cost: bool,
    pricing: &PricingMap,
) -> UsageCost {
    if has_recorded_cost {
        if recorded_cost == 0.0 {
            return cost_detail(Some(0.0), "free", "provider", "official");
        }
        return cost_detail(Some(recorded_cost), "recorded", "provider", "official");
    }

    find_pricing(pricing_provider, model, pricing)
        .map(|p| {
            cost_detail(
                Some(calculate_cost(p, &tokens)),
                "estimated",
                "local-pricing",
                "estimated",
            )
        })
        .unwrap_or_else(unknown_cost)
}

#[derive(Clone, Default)]
pub(super) struct CostAccumulator {
    amount: f64,
    has_cost: bool,
    kind: Option<String>,
    basis: Option<String>,
    confidence: Option<String>,
    mixed: bool,
}

impl CostAccumulator {
    pub(super) fn add(&mut self, cost: UsageCost) {
        let Some(amount) = cost.amount else {
            return;
        };
        self.amount += amount;
        self.has_cost = true;

        if self.kind.as_deref().is_some_and(|kind| kind != cost.kind)
            || self.basis.as_deref().is_some_and(|basis| basis != cost.basis)
            || self.confidence.as_deref().is_some_and(|confidence| confidence != cost.confidence)
        {
            self.mixed = true;
        }

        self.kind.get_or_insert(cost.kind);
        self.basis.get_or_insert(cost.basis);
        self.confidence.get_or_insert(cost.confidence);
    }

    pub(super) fn finish(self) -> UsageCost {
        if !self.has_cost {
            return unknown_cost();
        }
        if self.mixed {
            return cost_detail(Some(self.amount), "mixed", "none", "observed");
        }
        cost_detail(
            Some(self.amount),
            self.kind.as_deref().unwrap_or("unknown"),
            self.basis.as_deref().unwrap_or("none"),
            self.confidence.as_deref().unwrap_or("observed"),
        )
    }
}

fn local_month_cutoff(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT CAST(strftime('%s', 'now', 'localtime', 'start of month', 'utc') AS INTEGER)",
        [],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(0)
}

struct ProjectAliasResolution {
    canonical_id: String,
    display_name: String,
    canonical_path: Option<String>,
    repo_root: Option<String>,
    confidence: f64,
    reason: String,
}

fn path_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn find_git_root(mut path: PathBuf) -> Option<PathBuf> {
    if path.is_file() {
        path.pop();
    }
    loop {
        if path.join(".git").exists() {
            return Some(path);
        }
        if !path.pop() {
            return None;
        }
    }
}

fn resolve_path_alias(path: PathBuf) -> Option<ProjectAliasResolution> {
    let expanded = if path.starts_with("~") {
        let home = dirs::home_dir()?;
        let rest = path.strip_prefix("~").ok()?;
        home.join(rest)
    } else {
        path
    };
    let canonical_path = expanded.canonicalize().ok()?;
    let git_root = find_git_root(canonical_path.clone());
    let canonical_id_path = git_root.as_ref().unwrap_or(&canonical_path);
    Some(ProjectAliasResolution {
        canonical_id: canonical_id_path.to_string_lossy().to_string(),
        display_name: path_display_name(canonical_id_path),
        canonical_path: Some(canonical_path.to_string_lossy().to_string()),
        repo_root: git_root.map(|path| path.to_string_lossy().to_string()),
        confidence: 1.0,
        reason: "path-git-root".to_string(),
    })
}

fn encoded_home_prefixes() -> Vec<String> {
    let mut prefixes = Vec::new();
    if let Some(home) = dirs::home_dir().and_then(|home| home.to_str().map(str::to_string)) {
        let encoded_home = home.replace('/', "-");
        prefixes.push(format!("{encoded_home}-dev--shep-worktrees-"));
        prefixes.push(format!("{encoded_home}--shep-worktrees-"));
        prefixes.push(format!("{encoded_home}-dev-"));
        prefixes.push(format!("{encoded_home}-"));
    }
    prefixes
}

fn resolve_project_alias(raw_label: &str) -> ProjectAliasResolution {
    let label = raw_label.trim();
    if label.is_empty() || label == "unknown" {
        return ProjectAliasResolution {
            canonical_id: "unknown".to_string(),
            display_name: "unknown".to_string(),
            canonical_path: None,
            repo_root: None,
            confidence: 0.2,
            reason: "missing-label".to_string(),
        };
    }

    if (label.starts_with('/') || label.starts_with("~/"))
        && resolve_path_alias(PathBuf::from(label)).is_some()
    {
        return resolve_path_alias(PathBuf::from(label)).unwrap();
    }

    for prefix in encoded_home_prefixes() {
        if let Some(rest) = label.strip_prefix(&prefix) {
            let display = rest.trim_matches('-');
            if !display.is_empty() {
                let reason = if prefix.contains("shep-worktrees") {
                    "encoded-worktree-label"
                } else {
                    "encoded-path-basename"
                };
                return ProjectAliasResolution {
                    canonical_id: display.to_string(),
                    display_name: display.to_string(),
                    canonical_path: None,
                    repo_root: None,
                    confidence: if reason == "encoded-worktree-label" { 0.55 } else { 0.7 },
                    reason: reason.to_string(),
                };
            }
        }
    }

    ProjectAliasResolution {
        canonical_id: label.to_string(),
        display_name: label.to_string(),
        canonical_path: None,
        repo_root: None,
        confidence: 0.85,
        reason: "provider-basename".to_string(),
    }
}

fn ensure_project_aliases(conn: &Connection) {
    let mut stmt = match conn.prepare(
        "SELECT provider, COALESCE(project, 'unknown'), COUNT(DISTINCT session_id), COALESCE(SUM(tokens_total), 0)
         FROM usage_messages
         GROUP BY provider, COALESCE(project, 'unknown')",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return,
    };

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return,
    };

    for row in rows.flatten() {
        let (provider, raw_label, _sessions, _tokens) = row;
        let resolution = resolve_project_alias(&raw_label);
        let now = now_epoch_seconds() as i64;

        let _ = conn.execute(
            "INSERT OR IGNORE INTO usage_projects (
                canonical_id, display_name, canonical_path, repo_root, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                resolution.canonical_id,
                resolution.display_name,
                resolution.canonical_path,
                resolution.repo_root,
                now,
            ],
        );

        let _ = conn.execute(
            "INSERT OR IGNORE INTO project_aliases (
                raw_label, provider, canonical_id, confidence, reviewed, reason, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)",
            params![
                raw_label,
                provider,
                resolution.canonical_id,
                resolution.confidence,
                resolution.reason,
                now,
            ],
        );
    }
}

pub fn project_alias_review_queue(conn: &Connection) -> Vec<UsageProjectAliasReviewItem> {
    ensure_project_aliases(conn);

    let mut stmt = match conn.prepare(
        "SELECT
            a.raw_label,
            a.provider,
            a.canonical_id,
            COALESCE(p.display_name, a.canonical_id),
            a.confidence,
            COALESCE(a.reason, ''),
            COUNT(DISTINCT m.session_id),
            COALESCE(SUM(m.tokens_total), 0)
         FROM project_aliases a
         LEFT JOIN usage_projects p ON p.canonical_id = a.canonical_id
         LEFT JOIN usage_messages m
            ON m.provider = a.provider
           AND COALESCE(m.project, 'unknown') = a.raw_label
         WHERE a.reviewed = 0 AND a.confidence < 0.8
         GROUP BY a.raw_label, a.provider, a.canonical_id, p.display_name, a.confidence, a.reason
         ORDER BY 8 DESC, a.confidence ASC
         LIMIT 50",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map([], |row| {
        Ok(UsageProjectAliasReviewItem {
            raw_label: row.get(0)?,
            provider: row.get(1)?,
            canonical_id: row.get(2)?,
            display_name: row.get(3)?,
            confidence: row.get(4)?,
            reason: row.get(5)?,
            sessions: row.get::<_, i64>(6)? as u64,
            tokens: row.get::<_, i64>(7)? as u64,
        })
    }) {
        Ok(rows) => rows.filter_map(|row| row.ok()).collect(),
        Err(_) => Vec::new(),
    };
    rows
}

/// Calculate cost for a windowed query (total tokens by type for a given provider/cutoff).
fn windowed_cost(conn: &Connection, provider: &str, cutoff: i64, pricing: &PricingMap) -> Option<f64> {
    windowed_cost_detail(conn, provider, cutoff, pricing).amount
}

fn windowed_cost_detail(conn: &Connection, provider: &str, cutoff: i64, pricing: &PricingMap) -> UsageCost {
    let stmt = conn.prepare(
        "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
         FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
         GROUP BY COALESCE(pricing_provider, provider), model"
    ).ok();

    let Some(mut stmt) = stmt else {
        return unknown_cost();
    };

    let mut costs = CostAccumulator::default();

    let rows = stmt.query_map(params![provider, cutoff], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    });

    let Ok(rows) = rows else {
        return unknown_cost();
    };

    for row in rows.flatten() {
        let (pricing_provider, model, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        costs.add(resolved_cost_detail(
            &pricing_provider,
            &model,
            CostTokens { input, output, cache_read, cache_write, thoughts },
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
    }

    costs.finish()
}

/// Query the DB for local usage details for a given provider.
pub fn local_details(conn: &Connection, provider: &str) -> Option<LocalUsageDetails> {
    let now = now_epoch_seconds() as i64;
    let t5h = now - 18_000;
    let t7d = now - 604_800;
    let t30d = now - 2_592_000;

    let pricing = load_pricing(conn);
    let month_cutoff = local_month_cutoff(conn);

    // Time-windowed totals
    let (tokens_5h, tokens_7d, tokens_30d, tokens_total) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN timestamp >= ?2 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?3 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?4 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(tokens_total), 0)
             FROM usage_messages WHERE provider = ?1",
            params![provider, t5h, t7d, t30d],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
        )
        .ok()?;

    // Token type totals
    let (input, output, cache_write, cache_read, thoughts) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(tokens_input), 0),
                COALESCE(SUM(tokens_output), 0),
                COALESCE(SUM(tokens_cache_write), 0),
                COALESCE(SUM(tokens_cache_read), 0),
                COALESCE(SUM(tokens_thoughts), 0)
             FROM usage_messages WHERE provider = ?1",
            params![provider],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            )),
        )
        .unwrap_or((0, 0, 0, 0, 0));

    let has_type_breakdown = input > 0 || output > 0;

    // Costs per window
    let cost_5h = windowed_cost(conn, provider, t5h, &pricing);
    let cost_7d = windowed_cost(conn, provider, t7d, &pricing);
    let cost_30d = windowed_cost(conn, provider, t30d, &pricing);
    let cost_total = windowed_cost(conn, provider, 0, &pricing);
    let cost_month = windowed_cost(conn, provider, month_cutoff, &pricing);
    let cost_5h_detail = windowed_cost_detail(conn, provider, t5h, &pricing);
    let cost_7d_detail = windowed_cost_detail(conn, provider, t7d, &pricing);
    let cost_30d_detail = windowed_cost_detail(conn, provider, t30d, &pricing);
    let cost_total_detail = windowed_cost_detail(conn, provider, 0, &pricing);
    let cost_month_detail = windowed_cost_detail(conn, provider, month_cutoff, &pricing);

    let top_models = query_top_models(conn, provider, &pricing);
    let top_tasks = query_top_tasks(conn, provider, &pricing);
    let top_projects = query_top_projects(conn, provider, &pricing);

    Some(LocalUsageDetails {
        source_type: "local".to_string(),
        confidence: "observed".to_string(),
        tokens_total: tokens_total as u64,
        tokens_input: if has_type_breakdown { Some(input as u64) } else { None },
        tokens_output: if has_type_breakdown { Some(output as u64) } else { None },
        tokens_cached: if has_type_breakdown { Some((cache_write + cache_read) as u64) } else { None },
        tokens_thoughts: if thoughts > 0 { Some(thoughts as u64) } else { None },
        tokens_5h: tokens_5h as u64,
        tokens_7d: tokens_7d as u64,
        tokens_30d: tokens_30d as u64,
        cost_total,
        cost_total_detail,
        cost_month,
        cost_month_detail,
        cost_5h,
        cost_5h_detail,
        cost_7d,
        cost_7d_detail,
        cost_30d,
        cost_30d_detail,
        top_models,
        top_tasks,
        top_projects,
    })
}

/// Query local details scoped to a specific time window.
pub fn windowed_details(conn: &Connection, provider: &str, window: &str) -> Option<LocalUsageDetails> {
    let now = now_epoch_seconds() as i64;
    let cutoff = match window {
        "5h" => now - 18_000,
        "7d" => now - 604_800,
        "30d" => now - 2_592_000,
        _ => return None,
    };

    let pricing = load_pricing(conn);
    let month_cutoff = local_month_cutoff(conn);

    let tokens_total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(tokens_total), 0) FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2",
            params![provider, cutoff],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let (input, output, cache_write, cache_read, thoughts) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(tokens_input), 0),
                COALESCE(SUM(tokens_output), 0),
                COALESCE(SUM(tokens_cache_write), 0),
                COALESCE(SUM(tokens_cache_read), 0),
                COALESCE(SUM(tokens_thoughts), 0)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2",
            params![provider, cutoff],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            )),
        )
        .unwrap_or((0, 0, 0, 0, 0));

    let has_type_breakdown = input > 0 || output > 0;

    let cost_window = windowed_cost(conn, provider, cutoff, &pricing);

    let t5h = now - 18_000;
    let t7d = now - 604_800;
    let t30d = now - 2_592_000;
    let (tokens_5h, tokens_7d, tokens_30d) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN timestamp >= ?2 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?3 THEN tokens_total ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN timestamp >= ?4 THEN tokens_total ELSE 0 END), 0)
             FROM usage_messages WHERE provider = ?1",
            params![provider, t5h, t7d, t30d],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        )
        .unwrap_or((0, 0, 0));

    let cost_5h = windowed_cost(conn, provider, t5h, &pricing);
    let cost_7d = windowed_cost(conn, provider, t7d, &pricing);
    let cost_30d = windowed_cost(conn, provider, t30d, &pricing);
    let cost_month = windowed_cost(conn, provider, month_cutoff, &pricing);
    let cost_window_detail = windowed_cost_detail(conn, provider, cutoff, &pricing);
    let cost_5h_detail = windowed_cost_detail(conn, provider, t5h, &pricing);
    let cost_7d_detail = windowed_cost_detail(conn, provider, t7d, &pricing);
    let cost_30d_detail = windowed_cost_detail(conn, provider, t30d, &pricing);
    let cost_month_detail = windowed_cost_detail(conn, provider, month_cutoff, &pricing);

    let top_models = query_top_models_since(conn, provider, cutoff, &pricing);
    let top_tasks = query_top_tasks_since(conn, provider, cutoff, &pricing);
    let top_projects = query_top_projects_since(conn, provider, cutoff, &pricing);

    Some(LocalUsageDetails {
        source_type: "local".to_string(),
        confidence: "observed".to_string(),
        tokens_total: tokens_total as u64,
        tokens_input: if has_type_breakdown { Some(input as u64) } else { None },
        tokens_output: if has_type_breakdown { Some(output as u64) } else { None },
        tokens_cached: if has_type_breakdown { Some((cache_write + cache_read) as u64) } else { None },
        tokens_thoughts: if thoughts > 0 { Some(thoughts as u64) } else { None },
        tokens_5h: tokens_5h as u64,
        tokens_7d: tokens_7d as u64,
        tokens_30d: tokens_30d as u64,
        cost_total: cost_window,
        cost_total_detail: cost_window_detail,
        cost_month,
        cost_month_detail,
        cost_5h,
        cost_5h_detail,
        cost_7d,
        cost_7d_detail,
        cost_30d,
        cost_30d_detail,
        top_models,
        top_tasks,
        top_projects,
    })
}

fn query_top_models(conn: &Connection, provider: &str, pricing: &PricingMap) -> Vec<UsageNamedTokens> {
    query_top_models_since(conn, provider, 0, pricing)
}

fn query_top_models_since(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Vec<UsageNamedTokens> {
    let mut stmt = match conn
        .prepare(
            "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'), SUM(tokens_total),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
             GROUP BY COALESCE(pricing_provider, provider), model ORDER BY 3 DESC LIMIT 5",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![provider, since], |row| {
        let pricing_provider: String = row.get(0)?;
        let name: String = row.get(1)?;
        let tokens = row.get::<_, i64>(2)? as u64;
        let input: i64 = row.get(3)?;
        let output: i64 = row.get(4)?;
        let cache_read: i64 = row.get(5)?;
        let cache_write: i64 = row.get(6)?;
        let thoughts: i64 = row.get(7)?;
        let recorded_cost: f64 = row.get(8)?;
        let has_recorded_cost: i64 = row.get(9)?;
        Ok((pricing_provider, name, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(pricing_provider, name, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost)| {
        let cost_detail = resolved_cost_detail(
            &pricing_provider,
            &name,
            CostTokens { input, output, cache_read, cache_write, thoughts },
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        );
        UsageNamedTokens { name, tokens, cost: cost_detail.amount, cost_detail }
    })
    .collect()
}

fn query_top_tasks(conn: &Connection, provider: &str, pricing: &PricingMap) -> Vec<UsageTask> {
    query_top_tasks_since(conn, provider, 0, pricing)
}

fn query_top_tasks_since(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Vec<UsageTask> {
    let mut stmt = match conn
        .prepare(
            "SELECT session_id, COALESCE(project, ''), SUM(tokens_total), MAX(model), MAX(timestamp),
                    COALESCE(MAX(pricing_provider), provider),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
             GROUP BY session_id ORDER BY 3 DESC LIMIT 5",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![provider, since], |row| {
        let session_id: String = row.get(0)?;
        let project: String = row.get(1)?;
        let tokens: i64 = row.get(2)?;
        let model: Option<String> = row.get(3)?;
        let updated_at: Option<i64> = row.get(4)?;
        let pricing_provider: String = row.get(5)?;
        let input: i64 = row.get(6)?;
        let output: i64 = row.get(7)?;
        let cache_read: i64 = row.get(8)?;
        let cache_write: i64 = row.get(9)?;
        let thoughts: i64 = row.get(10)?;
        let recorded_cost: f64 = row.get(11)?;
        let has_recorded_cost: i64 = row.get(12)?;
        Ok((session_id, project, tokens, model, updated_at, pricing_provider, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(session_id, project, tokens, model, updated_at, pricing_provider, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost)| {
        let cost_detail = model.as_deref().map(|name| resolved_cost_detail(
            &pricing_provider,
            name,
            CostTokens { input, output, cache_read, cache_write, thoughts },
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        )).unwrap_or_else(unknown_cost);
        UsageTask {
            id: session_id.clone(),
            label: session_id,
            tokens: tokens as u64,
            cost: cost_detail.amount,
            cost_detail,
            model,
            project: if project.is_empty() { None } else { Some(project) },
            updated_at: updated_at.map(|t| t.to_string()),
        }
    })
    .collect()
}

fn query_top_projects(conn: &Connection, provider: &str, pricing: &PricingMap) -> Vec<UsageProject> {
    query_top_projects_since(conn, provider, 0, pricing)
}

fn query_top_projects_since(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> Vec<UsageProject> {
    let mut stmt = match conn
        .prepare(
            "SELECT COALESCE(project, 'unknown'), SUM(tokens_total), COUNT(DISTINCT session_id),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts)
             FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2
             GROUP BY project ORDER BY 2 DESC LIMIT 5",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![provider, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(name, tokens, sessions, _input, _output, _cache_read, _cache_write, _thoughts)| {
        let cost_detail = windowed_cost_for_project_detail(conn, provider, since, &name, pricing);
        UsageProject {
            name,
            tokens: tokens as u64,
            cost: cost_detail.amount,
            cost_detail,
            sessions: Some(sessions as u64),
        }
    })
    .collect()
}

fn windowed_cost_for_project_detail(conn: &Connection, provider: &str, since: i64, project: &str, pricing: &PricingMap) -> UsageCost {
    let stmt = conn.prepare(
        "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
         FROM usage_messages WHERE provider = ?1 AND timestamp >= ?2 AND COALESCE(project, 'unknown') = ?3
         GROUP BY COALESCE(pricing_provider, provider), model"
    ).ok();

    let Some(mut stmt) = stmt else {
        return unknown_cost();
    };

    let mut costs = CostAccumulator::default();

    let rows = stmt.query_map(params![provider, since, project], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    });

    let Ok(rows) = rows else {
        return unknown_cost();
    };

    for row in rows.flatten() {
        let (pricing_provider, model, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        costs.add(resolved_cost_detail(
            &pricing_provider,
            &model,
            CostTokens { input, output, cache_read, cache_write, thoughts },
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
    }

    costs.finish()
}

// All overview sections use the same window and the same raw/archived rows.
// Legacy archives lack session IDs; new archives preserve them for exact counts.
const OVERVIEW_SOURCE: &str = "WITH window_usage AS (
    SELECT provider, session_id, model, project, pricing_provider, timestamp, NULL AS archive_date,
           tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
    FROM usage_messages WHERE timestamp >= ?1 AND timestamp <= ?2
    UNION ALL
    SELECT provider, session_id, model, project, pricing_provider, NULL, date,
           tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
    FROM usage_archive WHERE date >= date(?1, 'unixepoch', 'localtime') AND date <= date(?2, 'unixepoch', 'localtime')
    UNION ALL
    SELECT provider, NULL, model, project, pricing_provider, NULL, date,
           tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
    FROM usage_daily WHERE date >= date(?1, 'unixepoch', 'localtime') AND date <= date(?2, 'unixepoch', 'localtime')
)";

struct OverviewWindow {
    since: i64,
    until: i64,
    count: i64,
    hourly: bool,
}

impl OverviewWindow {
    fn new(conn: &Connection, key: &str, now: i64) -> Option<Self> {
        let (count, hourly) = match key {
            "24h" => (24, true),
            "7d" => (7, false),
            "30d" => (30, false),
            "365d" => (365, false),
            _ => return None,
        };
        // Include the current hour/day. The previous range dropped today's final
        // bucket while showing its tokens in the headline.
        let since = if hourly {
            now - now.rem_euclid(3600) - (count - 1) * 3600
        } else {
            conn.query_row(
                "SELECT CAST(strftime('%s', ?1, 'unixepoch', 'localtime', 'start of day', ?2, 'utc') AS INTEGER)",
                params![now, format!("-{} days", count - 1)], |row| row.get(0),
            ).ok()?
        };
        Some(Self {
            since,
            until: now,
            count,
            hourly,
        })
    }
}

pub fn usage_overview(conn: &Connection, window: &str) -> Option<UsageOverview> {
    usage_overview_at(conn, window, now_epoch_seconds() as i64)
}

fn usage_overview_at(conn: &Connection, window: &str, now: i64) -> Option<UsageOverview> {
    let range = OverviewWindow::new(conn, window, now)?;
    let pricing = load_pricing(conn);
    let trend = query_overview_trend(conn, &range, &pricing);
    let providers = query_provider_summaries(conn, &range, &pricing, &trend);
    let total_tokens = providers.iter().map(|p| p.tokens).sum();
    let total_cost_value = providers.iter().filter_map(|p| p.cost).sum();
    let total_cost = providers
        .iter()
        .any(|p| p.cost.is_some())
        .then_some(total_cost_value);
    let mut total_costs = CostAccumulator::default();
    for provider in &providers {
        total_costs.add(provider.cost_detail.clone());
    }
    let top_models = query_breakdown_all(conn, &range, "model");
    let top_projects = query_breakdown_all(conn, &range, "project");
    let active_projects = conn.query_row(
        &format!("{OVERVIEW_SOURCE} SELECT COUNT(DISTINCT NULLIF(NULLIF(project, 'unknown'), '')) FROM window_usage"),
        params![range.since, range.until], |row| row.get::<_, i64>(0),
    ).unwrap_or(0) as u64;
    let active_sessions = conn.query_row(
        &format!("{OVERVIEW_SOURCE} SELECT CASE WHEN EXISTS(SELECT 1 FROM window_usage WHERE session_id IS NULL) THEN NULL
                 ELSE (SELECT COUNT(*) FROM (SELECT DISTINCT provider, session_id FROM window_usage)) END"),
        params![range.since, range.until], |row| row.get::<_, Option<i64>>(0),
    ).ok().flatten().map(|count| count as u64);

    Some(UsageOverview {
        window: window.to_string(),
        total_tokens,
        total_cost,
        total_cost_detail: total_costs.finish(),
        active_projects,
        active_sessions,
        providers,
        trend,
        top_models,
        top_projects,
    })
}

fn query_provider_summaries(
    conn: &Connection,
    range: &OverviewWindow,
    pricing: &PricingMap,
    trend: &[UsageTrendBucket],
) -> Vec<UsageOverviewProvider> {
    let query = format!("{OVERVIEW_SOURCE}
        SELECT provider, SUM(tokens_total), SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts)
        FROM window_usage GROUP BY provider ORDER BY 2 DESC");
    let Ok(mut stmt) = conn.prepare(&query) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![range.since, range.until], |row| {
        let provider: String = row.get(0)?;
        let cost = windowed_cost_for_provider_detail(conn, &provider, range, pricing);
        Ok(UsageOverviewProvider {
            trend: trend
                .iter()
                .map(|bucket| {
                    bucket
                        .providers
                        .iter()
                        .find(|entry| entry.provider == provider)
                        .map_or(0, |entry| entry.tokens)
                })
                .collect(),
            provider,
            tokens: row.get::<_, i64>(1)? as u64,
            tokens_input: row.get::<_, i64>(2)? as u64,
            tokens_output: row.get::<_, i64>(3)? as u64,
            tokens_cache_read: row.get::<_, i64>(4)? as u64,
            tokens_cache_write: row.get::<_, i64>(5)? as u64,
            tokens_thoughts: row.get::<_, i64>(6)? as u64,
            cost: cost.amount,
            cost_detail: cost,
            share_percent: 0.0,
        })
    }) else {
        return Vec::new();
    };
    let mut providers: Vec<_> = rows.filter_map(Result::ok).collect();
    let total: u64 = providers.iter().map(|row| row.tokens).sum();
    for provider in &mut providers {
        if total > 0 {
            provider.share_percent = provider.tokens as f64 / total as f64 * 100.0;
        }
    }
    providers
}

fn query_breakdown_all(
    conn: &Connection,
    range: &OverviewWindow,
    dimension: &str,
) -> Vec<UsageBreakdownItem> {
    let column = match dimension {
        "model" => "model",
        "project" => "project",
        _ => return Vec::new(),
    };
    let query = format!("{OVERVIEW_SOURCE}
        SELECT provider, COALESCE({column}, 'unknown'), SUM(tokens_total), SUM(tokens_input), SUM(tokens_output),
               SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
               CASE WHEN SUM(session_id IS NULL) > 0 THEN NULL ELSE COUNT(DISTINCT session_id) END
        FROM window_usage GROUP BY provider, COALESCE({column}, 'unknown') ORDER BY 3 DESC");
    let Ok(mut stmt) = conn.prepare(&query) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![range.since, range.until], |row| {
        Ok(UsageBreakdownItem {
            provider: row.get(0)?,
            label: row.get(1)?,
            tokens: row.get::<_, i64>(2)? as u64,
            tokens_input: row.get::<_, i64>(3)? as u64,
            tokens_output: row.get::<_, i64>(4)? as u64,
            tokens_cache_read: row.get::<_, i64>(5)? as u64,
            tokens_cache_write: row.get::<_, i64>(6)? as u64,
            tokens_thoughts: row.get::<_, i64>(7)? as u64,
            sessions: if dimension == "project" {
                row.get::<_, Option<i64>>(8)?.map(|count| count as u64)
            } else {
                None
            },
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn windowed_cost_for_provider_detail(
    conn: &Connection,
    provider: &str,
    range: &OverviewWindow,
    pricing: &PricingMap,
) -> UsageCost {
    let query = format!("{OVERVIEW_SOURCE}
        SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
               SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
               COALESCE(SUM(recorded_cost), 0), MAX(recorded_cost IS NOT NULL)
        FROM window_usage WHERE provider = ?3 GROUP BY COALESCE(pricing_provider, provider), model");
    let Ok(mut stmt) = conn.prepare(&query) else {
        return unknown_cost();
    };
    let Ok(rows) = stmt.query_map(params![range.since, range.until, provider], |row| {
        Ok(resolved_cost_detail(
            &row.get::<_, String>(0)?,
            &row.get::<_, String>(1)?,
            CostTokens {
                input: row.get(2)?,
                output: row.get(3)?,
                cache_read: row.get(4)?,
                cache_write: row.get(5)?,
                thoughts: row.get(6)?,
            },
            row.get(7)?,
            row.get::<_, i64>(8)? != 0,
            pricing,
        ))
    }) else {
        return unknown_cost();
    };
    let mut costs = CostAccumulator::default();
    for cost in rows.flatten() {
        costs.add(cost);
    }
    costs.finish()
}

fn query_overview_trend(
    conn: &Connection,
    range: &OverviewWindow,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    let index = if range.hourly {
        "CAST((timestamp - ?1) / 3600 AS INTEGER)"
    } else {
        "CAST(julianday(COALESCE(archive_date, date(timestamp, 'unixepoch', 'localtime'))) - julianday(date(?1, 'unixepoch', 'localtime')) AS INTEGER)"
    };
    let query = format!("{OVERVIEW_SOURCE}
        SELECT provider, {index} AS bucket_idx, COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
               SUM(tokens_total), SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
               COALESCE(SUM(recorded_cost), 0), MAX(recorded_cost IS NOT NULL)
        FROM window_usage GROUP BY provider, bucket_idx, COALESCE(pricing_provider, provider), model");
    let mut bucket_map: BTreeMap<i64, BTreeMap<String, (u64, CostAccumulator)>> = BTreeMap::new();
    if let Ok(mut stmt) = conn.prepare(&query) {
        if let Ok(rows) = stmt.query_map(params![range.since, range.until], |row| {
            let cost = resolved_cost_detail(
                &row.get::<_, String>(2)?,
                &row.get::<_, String>(3)?,
                CostTokens {
                    input: row.get(5)?,
                    output: row.get(6)?,
                    cache_read: row.get(7)?,
                    cache_write: row.get(8)?,
                    thoughts: row.get(9)?,
                },
                row.get(10)?,
                row.get::<_, i64>(11)? != 0,
                pricing,
            );
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(4)? as u64,
                cost,
            ))
        }) {
            for (provider, index, tokens, cost) in rows.flatten() {
                if index < 0 || index >= range.count {
                    continue;
                }
                let entry = bucket_map
                    .entry(index)
                    .or_default()
                    .entry(provider)
                    .or_default();
                entry.0 += tokens;
                entry.1.add(cost);
            }
        }
    }
    // Local midnight boundaries are not always 24 hours apart (DST). Resolve
    // those boundaries independently from the hourly elapsed-time buckets.
    let boundary = |index: i64| -> i64 {
        if range.hourly {
            return range.since + index * 3600;
        }
        conn.query_row(
            "SELECT CAST(strftime('%s', ?1, 'unixepoch', 'localtime', ?2, 'utc') AS INTEGER)",
            params![range.since, format!("+{index} days")],
            |row| row.get(0),
        )
        .unwrap_or(range.since + index * 86_400)
    };
    (0..range.count)
        .map(|index| {
            let providers: Vec<_> = bucket_map
                .remove(&index)
                .unwrap_or_default()
                .into_iter()
                .map(|(provider, (tokens, costs))| {
                    let cost_detail = costs.finish();
                    UsageTrendProviderValue {
                        provider,
                        tokens,
                        cost: cost_detail.amount,
                        cost_detail,
                    }
                })
                .collect();
            let tokens = providers.iter().map(|provider| provider.tokens).sum();
            let mut costs = CostAccumulator::default();
            for provider in &providers {
                costs.add(provider.cost_detail.clone());
            }
            let cost_detail = costs.finish();
            UsageTrendBucket {
                start: boundary(index),
                end: boundary(index + 1),
                label: String::new(),
                tokens,
                cost: cost_detail.amount,
                cost_detail,
                providers,
            }
        })
        .collect()
}

pub fn models_for_provider(conn: &Connection, provider: &str) -> Vec<String> {
    let pricing_provider = match provider {
        "claude" => "anthropic",
        "codex" => "openai",
        "gemini" => "google",
        other => other,
    };

    let mut stmt = match conn.prepare(
        "SELECT model_pattern
         FROM model_pricing
         WHERE provider = ?1 AND release_date >= date('now', '-2 years')
         ORDER BY release_date DESC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![pricing_provider], |row| row.get::<_, String>(0)) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    rows.filter_map(|r| r.ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annual_overview_includes_both_archives_and_todays_activity() {
        let db = crate::usage::db::UsageDb::open_in_memory();
        let conn = db.conn.lock().unwrap();
        let now = 1_791_748_800_i64; // 2026-10-11 noon UTC
        conn.execute_batch("INSERT INTO usage_daily (provider, date, project, model, tokens_total, message_count)
            VALUES ('claude', '2026-01-01', 'old', 'legacy-model', 100, 500),
                   ('claude', '2020-01-01', 'outside', 'old-model', 9000, 1);
            INSERT INTO usage_archive (provider, session_id, date, project, model, pricing_provider, tokens_total)
            VALUES ('codex', 'archived', '2026-02-01', 'archived', 'model', 'openai', 200);").unwrap();
        conn.execute("INSERT INTO usage_messages (provider, session_id, timestamp, project, model, tokens_total)
            VALUES ('codex', 'current', ?1, 'current', 'model', 30)", params![now]).unwrap();
        let overview = usage_overview_at(&conn, "365d", now).unwrap();
        assert_eq!(overview.total_tokens, 330);
        assert_eq!(overview.trend.iter().map(|bucket| bucket.tokens).sum::<u64>(), 330);
        assert_eq!(overview.trend.last().unwrap().tokens, 30);
        assert_eq!(overview.top_models.iter().map(|row| row.tokens).sum::<u64>(), 330);
        assert_eq!(overview.top_projects.iter().map(|row| row.tokens).sum::<u64>(), 330);
        assert_eq!(overview.active_projects, 3);
        assert_eq!(overview.active_sessions, None, "message counts are not session counts");
        assert_eq!(overview.trend.len(), 365);
        for pair in overview.trend.windows(2) { assert_eq!(pair[0].end, pair[1].start); }
        for window in ["24h", "7d", "30d"] {
            let recent = usage_overview_at(&conn, window, now).unwrap();
            assert_eq!(recent.total_tokens, 30);
            assert_eq!(recent.active_sessions, Some(1));
            assert_eq!(recent.trend.last().unwrap().tokens, 30);
        }
    }

    #[test]
    fn new_archives_count_sessions_once_across_days_and_providers() {
        let db = crate::usage::db::UsageDb::open_in_memory();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("INSERT INTO usage_archive (provider, session_id, date, project, model, pricing_provider, tokens_total)
            VALUES ('codex', 'shared-id', '2026-01-01', 'a', 'model', 'openai', 10),
                   ('codex', 'shared-id', '2026-01-02', 'a', 'model', 'openai', 20),
                   ('claude', 'shared-id', '2026-01-01', 'b', 'model', 'anthropic', 30);").unwrap();
        let overview = usage_overview_at(&conn, "365d", 1_791_748_800).unwrap();
        assert_eq!(overview.total_tokens, 60);
        assert_eq!(overview.active_sessions, Some(2));
        assert_eq!(overview.active_projects, 2);
    }

    #[test]
    fn overview_keeps_every_project_and_model_in_the_totals() {
        let db = crate::usage::db::UsageDb::open_in_memory();
        let conn = db.conn.lock().unwrap();
        let now = now_epoch_seconds() as i64;
        for i in 0..30 {
            conn.execute(
                "INSERT INTO usage_messages (provider, session_id, project, model, timestamp, tokens_total, tokens_input)
                 VALUES ('codex', ?1, ?2, ?3, ?4, 100, 100)",
                params![format!("session-{i}"), format!("project-{i}"), format!("model-{i}"), now],
            ).unwrap();
        }
        let overview = usage_overview(&conn, "7d").unwrap();
        assert_eq!(overview.total_tokens, 3000);
        assert_eq!(overview.top_projects.len(), 30);
        assert_eq!(overview.top_models.len(), 30);
        assert_eq!(overview.top_projects.iter().map(|row| row.tokens).sum::<u64>(), overview.total_tokens);
        assert_eq!(overview.top_models.iter().map(|row| row.tokens).sum::<u64>(), overview.total_tokens);
    }

    fn model_pricing(input_per_m: f64, output_per_m: f64) -> ModelPricing {
        ModelPricing {
            input_per_m,
            output_per_m,
            cache_read_per_m: 0.0,
            cache_write_per_m: 0.0,
            thoughts_per_m: 0.0,
        }
    }

    #[test]
    fn find_pricing_maps_antigravity_gemini_labels() {
        let mut pricing = PricingMap::new();
        pricing.insert(
            ("google".to_string(), "gemini-3.5-flash".to_string()),
            model_pricing(1.5, 9.0),
        );

        let found = find_pricing("google", "Gemini 3.5 Flash (Medium)", &pricing)
            .expect("pricing");

        assert_eq!(found.input_per_m, 1.5);
        assert_eq!(found.output_per_m, 9.0);
    }

    #[test]
    fn find_pricing_maps_antigravity_claude_labels() {
        let mut pricing = PricingMap::new();
        pricing.insert(
            ("anthropic".to_string(), "claude-sonnet-4-6".to_string()),
            model_pricing(3.0, 15.0),
        );

        let found = find_pricing("anthropic", "Claude Sonnet 4.6 (Thinking)", &pricing)
            .expect("pricing");

        assert_eq!(found.input_per_m, 3.0);
        assert_eq!(found.output_per_m, 15.0);
    }
}
