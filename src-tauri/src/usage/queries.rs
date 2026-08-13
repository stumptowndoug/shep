use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::types::{
    LocalUsageDetails, UsageBreakdownItem, UsageNamedTokens, UsageOverview,
    UsageOverviewProvider, UsageProject, UsageTask, UsageTrendBucket,
    UsageCost, UsageProjectAliasReviewItem, UsageTrendProviderValue,
};
use super::helpers::now_epoch_seconds;

const OVERVIEW_BREAKDOWN_LIMIT: i64 = 25;

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

/// Calculate cost in USD for a set of token counts.
fn calculate_cost(pricing: &ModelPricing, input: i64, output: i64, cache_read: i64, cache_write: i64, thoughts: i64) -> f64 {
    (input as f64 * pricing.input_per_m
        + output as f64 * pricing.output_per_m
        + cache_read as f64 * pricing.cache_read_per_m
        + cache_write as f64 * pricing.cache_write_per_m
        + thoughts as f64 * pricing.thoughts_per_m)
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
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    thoughts: i64,
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
                Some(calculate_cost(p, input, output, cache_read, cache_write, thoughts)),
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
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
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
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
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
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
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
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
    }

    costs.finish()
}

pub fn usage_overview(conn: &Connection, window: &str) -> Option<UsageOverview> {
    let now = now_epoch_seconds() as i64;
    let (cutoff, bucket_count, mode) = match window {
        "24h" => (now - 86_400, 24_i64, BucketMode::Hourly),
        "7d" => (now - 604_800, 7_i64, BucketMode::Daily),
        "30d" => (now - 2_592_000, 30_i64, BucketMode::Daily),
        "365d" => (now - 31_536_000, 365_i64, BucketMode::Daily),
        _ => return None,
    };

    let pricing = load_pricing(conn);
    let trend = query_trend(conn, cutoff, bucket_count, mode, &pricing);
    let providers = query_provider_summaries(conn, cutoff, &pricing, &trend);
    let total_tokens: u64 = providers.iter().map(|p| p.tokens).sum();
    let total_cost_value: f64 = providers.iter().filter_map(|p| p.cost).sum();
    let total_cost = providers.iter().any(|p| p.cost.is_some()).then_some(total_cost_value);
    let mut total_costs = CostAccumulator::default();
    for provider in &providers {
        total_costs.add(provider.cost_detail.clone());
    }
    let total_cost_detail = total_costs.finish();
    let top_models = query_top_models_all(conn, cutoff, &pricing, bucket_count, mode);
    let top_projects = query_top_projects_all(conn, cutoff, &pricing, bucket_count, mode);
    let active_projects = count_distinct(conn, cutoff, "COALESCE(project, '')", true, mode);
    let active_sessions = count_sessions(conn, cutoff, mode);

    Some(UsageOverview {
        window: window.to_string(),
        total_tokens,
        total_cost,
        total_cost_detail,
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
    since: i64,
    pricing: &PricingMap,
    trend: &[UsageTrendBucket],
) -> Vec<UsageOverviewProvider> {
    let mut stmt = match conn
        .prepare(
            "SELECT provider, SUM(tokens_total), SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts)
             FROM usage_messages
             WHERE timestamp >= ?1
             GROUP BY provider
             ORDER BY 2 DESC",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let raw: Vec<(String, u64, u64, u64, u64, u64, u64, UsageCost)> = match stmt
        .query_map(params![since], |row| {
            let provider: String = row.get(0)?;
            let tokens = row.get::<_, i64>(1)? as u64;
            let input = row.get::<_, i64>(2)? as u64;
            let output = row.get::<_, i64>(3)? as u64;
            let cache_read = row.get::<_, i64>(4)? as u64;
            let cache_write = row.get::<_, i64>(5)? as u64;
            let thoughts = row.get::<_, i64>(6)? as u64;
            let cost_detail = windowed_cost_for_provider_detail(conn, &provider, since, pricing);
            Ok((provider, tokens, input, output, cache_read, cache_write, thoughts, cost_detail))
        }) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return Vec::new(),
    };

    let total_tokens: u64 = raw.iter().map(|(_, tokens, _, _, _, _, _, _)| *tokens).sum();

    raw.into_iter()
        .map(|(provider, tokens, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, cost)| UsageOverviewProvider {
            trend: trend
                .iter()
                .map(|bucket| {
                    bucket
                        .providers
                        .iter()
                        .find(|entry| entry.provider == provider)
                        .map(|entry| entry.tokens)
                        .unwrap_or(0)
                })
                .collect(),
            provider,
            tokens,
            tokens_input,
            tokens_output,
            tokens_cache_read,
            tokens_cache_write,
            tokens_thoughts,
            cost: cost.amount,
            cost_detail: cost,
            share_percent: if total_tokens > 0 {
                tokens as f64 / total_tokens as f64 * 100.0
            } else {
                0.0
            },
        })
        .collect()
}

fn query_trend(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    mode: BucketMode,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    match mode {
        BucketMode::Hourly => query_trend_hourly(conn, since, bucket_count, pricing),
        BucketMode::Daily => query_trend_daily(conn, since, bucket_count, pricing),
    }
}

fn query_top_models_all(
    conn: &Connection,
    since: i64,
    pricing: &PricingMap,
    bucket_count: i64,
    mode: BucketMode,
) -> Vec<UsageBreakdownItem> {
    let mut stmt = match conn
        .prepare(
            "SELECT provider, COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'), SUM(tokens_total),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages
             WHERE timestamp >= ?1
             GROUP BY provider, COALESCE(pricing_provider, provider), model
             ORDER BY 4 DESC
             LIMIT ?2",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![since, OVERVIEW_BREAKDOWN_LIMIT], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, f64>(9)?,
            row.get::<_, i64>(10)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(provider, pricing_provider, label, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost)| {
        let cost_detail = resolved_cost_detail(
            &pricing_provider,
            &label,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        );
        let trend = query_named_trend(conn, since, bucket_count, mode, "model", &provider, &label);
        UsageBreakdownItem {
            provider,
            label,
            tokens: tokens as u64,
            tokens_input: input as u64,
            tokens_output: output as u64,
            tokens_cache_read: cache_read as u64,
            tokens_cache_write: cache_write as u64,
            tokens_thoughts: thoughts as u64,
            cost: cost_detail.amount,
            cost_detail,
            sessions: None,
            trend,
        }
    })
    .collect()
}

fn query_top_projects_all(
    conn: &Connection,
    since: i64,
    pricing: &PricingMap,
    bucket_count: i64,
    mode: BucketMode,
) -> Vec<UsageBreakdownItem> {
    let mut stmt = match conn
        .prepare(
            "SELECT provider, COALESCE(project, 'unknown'), SUM(tokens_total), COUNT(DISTINCT session_id),
                    SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts)
             FROM usage_messages
             WHERE timestamp >= ?1
             GROUP BY provider, project
             ORDER BY 3 DESC
             LIMIT ?2",
        ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map(params![since, OVERVIEW_BREAKDOWN_LIMIT], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(|r| r.ok())
    .map(|(provider, label, tokens, sessions, input, output, cache_read, cache_write, thoughts)| {
        let cost_detail = windowed_cost_for_project_detail(conn, &provider, since, &label, pricing);
        let trend = query_named_trend(conn, since, bucket_count, mode, "project", &provider, &label);
        UsageBreakdownItem {
            cost: cost_detail.amount,
            cost_detail,
            provider,
            label,
            tokens: tokens as u64,
            tokens_input: input as u64,
            tokens_output: output as u64,
            tokens_cache_read: cache_read as u64,
            tokens_cache_write: cache_write as u64,
            tokens_thoughts: thoughts as u64,
            sessions: Some(sessions as u64),
            trend,
        }
    })
    .collect()
}

fn query_named_trend(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    mode: BucketMode,
    dimension: &str,
    provider: &str,
    label: &str,
) -> Vec<u64> {
    match mode {
        BucketMode::Hourly => query_named_trend_hourly(conn, since, bucket_count, dimension, provider, label),
        BucketMode::Daily => query_named_trend_daily(conn, since, bucket_count, dimension, provider, label),
    }
}

fn windowed_cost_for_provider_detail(conn: &Connection, provider: &str, since: i64, pricing: &PricingMap) -> UsageCost {
    let stmt = conn.prepare(
        "SELECT COALESCE(pricing_provider, provider), COALESCE(model, 'unknown'),
                SUM(tokens_input), SUM(tokens_output), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(tokens_thoughts),
                COALESCE(SUM(recorded_cost), 0), MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
         FROM usage_messages
         WHERE provider = ?1 AND timestamp >= ?2
         GROUP BY COALESCE(pricing_provider, provider), model"
    ).ok();

    let Some(mut stmt) = stmt else {
        return unknown_cost();
    };

    let mut costs = CostAccumulator::default();

    let rows = stmt.query_map(params![provider, since], |row| {
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
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
    }

    costs.finish()
}

fn count_distinct(conn: &Connection, since: i64, field: &str, skip_empty: bool, mode: BucketMode) -> u64 {
    match mode {
        BucketMode::Hourly => {
            let query = if skip_empty {
                format!(
                    "SELECT COUNT(DISTINCT {field}) FROM usage_messages WHERE timestamp >= ?1 AND {field} != ''"
                )
            } else {
                format!("SELECT COUNT(DISTINCT {field}) FROM usage_messages WHERE timestamp >= ?1")
            };
            conn.query_row(query.as_str(), params![since], |row| row.get::<_, i64>(0))
                .unwrap_or(0) as u64
        }
        BucketMode::Daily => {
            let cutoff_date = cutoff_local_date(conn, since);
            let query = if skip_empty {
                format!(
                    "SELECT COUNT(DISTINCT {field}) FROM (
                        SELECT {field} AS value FROM usage_messages WHERE timestamp >= ?1 AND {field} != ''
                        UNION
                        SELECT {field} AS value FROM usage_daily WHERE date >= ?2 AND {field} != ''
                    )"
                )
            } else {
                format!(
                    "SELECT COUNT(DISTINCT {field}) FROM (
                        SELECT {field} AS value FROM usage_messages WHERE timestamp >= ?1
                        UNION
                        SELECT {field} AS value FROM usage_daily WHERE date >= ?2
                    )"
                )
            };
            conn.query_row(query.as_str(), params![since, cutoff_date], |row| row.get::<_, i64>(0))
                .unwrap_or(0) as u64
        }
    }
}

fn count_sessions(conn: &Connection, since: i64, mode: BucketMode) -> u64 {
    match mode {
        BucketMode::Hourly => conn
            .query_row(
                "SELECT COUNT(DISTINCT session_id) FROM usage_messages WHERE timestamp >= ?1",
                params![since],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) as u64,
        BucketMode::Daily => {
            let cutoff_date = cutoff_local_date(conn, since);
            let detailed: u64 = conn
                .query_row(
                    "SELECT COUNT(DISTINCT session_id) FROM usage_messages WHERE timestamp >= ?1",
                    params![since],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as u64;
            let rolled: u64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(message_count), 0) FROM usage_daily WHERE date >= ?1",
                    params![cutoff_date],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as u64;
            detailed.max(rolled)
        }
    }
}

#[derive(Clone, Copy)]
enum BucketMode {
    Hourly,
    Daily,
}

fn query_trend_hourly(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    let hour_start = align_to_local_hour(conn, since);
    let mut bucket_map: BTreeMap<i64, BTreeMap<String, (u64, CostAccumulator)>> = BTreeMap::new();
    let mut stmt = match conn
        .prepare(
            "SELECT provider,
                    CAST((strftime('%s', strftime('%Y-%m-%d %H:00:00', timestamp, 'unixepoch', 'localtime')) - ?1) / 3600 AS INTEGER) as bucket_idx,
                    COALESCE(pricing_provider, provider),
                    COALESCE(model, 'unknown'),
                    SUM(tokens_total),
                    SUM(tokens_input),
                    SUM(tokens_output),
                    SUM(tokens_cache_read),
                    SUM(tokens_cache_write),
                    SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0),
                    MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM usage_messages
             WHERE timestamp >= ?2
             GROUP BY provider, bucket_idx, COALESCE(pricing_provider, provider), model",
        ) {
        Ok(s) => s,
        Err(_) => return build_trend_buckets(bucket_count, hour_start, 3600, bucket_map),
    };

    let rows = match stmt.query_map(params![hour_start, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, f64>(10)?,
            row.get::<_, i64>(11)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return build_trend_buckets(bucket_count, hour_start, 3600, bucket_map),
    };

    for row in rows.flatten() {
        let (provider, bucket_idx, pricing_provider, model, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if bucket_idx < 0 || bucket_idx >= bucket_count {
            continue;
        }
        let provider_map = bucket_map.entry(bucket_idx).or_default();
        let entry = provider_map.entry(provider).or_default();
        entry.0 += tokens as u64;
        entry.1.add(resolved_cost_detail(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
    }

    build_trend_buckets(bucket_count, hour_start, 3600, bucket_map)
}

fn query_trend_daily(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    pricing: &PricingMap,
) -> Vec<UsageTrendBucket> {
    let day_start = cutoff_local_date(conn, since);
    let cutoff_date = day_start.clone();
    let mut bucket_map: BTreeMap<i64, BTreeMap<String, (u64, CostAccumulator)>> = BTreeMap::new();
    let mut stmt = match conn
        .prepare(
            "SELECT provider,
                    CAST(julianday(bucket_day) - julianday(?1) AS INTEGER) as bucket_idx,
                    pricing_provider,
                    COALESCE(model, 'unknown'),
                    SUM(tokens_total),
                    SUM(tokens_input),
                    SUM(tokens_output),
                    SUM(tokens_cache_read),
                    SUM(tokens_cache_write),
                    SUM(tokens_thoughts),
                    COALESCE(SUM(recorded_cost), 0),
                    MAX(CASE WHEN recorded_cost IS NOT NULL THEN 1 ELSE 0 END)
             FROM (
                SELECT provider, date(timestamp, 'unixepoch', 'localtime') as bucket_day, COALESCE(pricing_provider, provider) as pricing_provider, model,
                       tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
                FROM usage_messages
                WHERE timestamp >= ?2
                UNION ALL
                SELECT provider, date as bucket_day, COALESCE(pricing_provider, provider) as pricing_provider, model,
                       tokens_total, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_thoughts, recorded_cost
                FROM usage_daily
                WHERE date >= ?1
             )
             GROUP BY provider, bucket_idx, pricing_provider, model",
        ) {
        Ok(s) => s,
        Err(_) => {
            let start_epoch = day_start_epoch(conn, &day_start);
            return build_trend_buckets(bucket_count, start_epoch, 86_400, bucket_map);
        }
    };

    let rows = match stmt.query_map(params![cutoff_date, since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, f64>(10)?,
            row.get::<_, i64>(11)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => {
            let start_epoch = day_start_epoch(conn, &day_start);
            return build_trend_buckets(bucket_count, start_epoch, 86_400, bucket_map);
        }
    };

    for row in rows.flatten() {
        let (provider, bucket_idx, pricing_provider, model, tokens, input, output, cache_read, cache_write, thoughts, recorded_cost, has_recorded_cost) = row;
        if bucket_idx < 0 || bucket_idx >= bucket_count {
            continue;
        }
        let provider_map = bucket_map.entry(bucket_idx).or_default();
        let entry = provider_map.entry(provider).or_default();
        entry.0 += tokens as u64;
        entry.1.add(resolved_cost_detail(
            &pricing_provider,
            &model,
            input,
            output,
            cache_read,
            cache_write,
            thoughts,
            recorded_cost,
            has_recorded_cost != 0,
            pricing,
        ));
    }

    let start_epoch = day_start_epoch(conn, &day_start);
    build_trend_buckets(bucket_count, start_epoch, 86_400, bucket_map)
}

fn build_trend_buckets(
    bucket_count: i64,
    start_epoch: i64,
    bucket_span_secs: i64,
    bucket_map: BTreeMap<i64, BTreeMap<String, (u64, CostAccumulator)>>,
) -> Vec<UsageTrendBucket> {
    (0..bucket_count)
        .map(|bucket_idx| {
            let start = start_epoch + bucket_idx * bucket_span_secs;
            let end = start + bucket_span_secs;
            let providers = bucket_map
                .get(&bucket_idx)
                .map(|items| items.iter().map(|(provider, (tokens, cost_accumulator))| {
                    let cost_detail = CostAccumulator {
                        amount: cost_accumulator.amount,
                        has_cost: cost_accumulator.has_cost,
                        kind: cost_accumulator.kind.clone(),
                        basis: cost_accumulator.basis.clone(),
                        confidence: cost_accumulator.confidence.clone(),
                        mixed: cost_accumulator.mixed,
                    }.finish();
                    UsageTrendProviderValue {
                    provider: provider.clone(),
                    tokens: *tokens,
                    cost: cost_detail.amount,
                    cost_detail,
                }}).collect::<Vec<_>>())
                .unwrap_or_default();
            let tokens = providers.iter().map(|p| p.tokens).sum();
            let mut costs = CostAccumulator::default();
            for provider in &providers {
                costs.add(provider.cost_detail.clone());
            }
            let cost_detail = costs.finish();
            UsageTrendBucket {
                start,
                end,
                label: String::new(),
                tokens,
                cost: cost_detail.amount,
                cost_detail,
                providers,
            }
        })
        .collect()
}

fn query_named_trend_hourly(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    dimension: &str,
    provider: &str,
    label: &str,
) -> Vec<u64> {
    let hour_start = align_to_local_hour(conn, since);
    let column = match dimension {
        "model" => "COALESCE(model, 'unknown')",
        "project" => "COALESCE(project, 'unknown')",
        _ => return vec![0; bucket_count as usize],
    };
    let query = format!(
        "SELECT CAST((strftime('%s', strftime('%Y-%m-%d %H:00:00', timestamp, 'unixepoch', 'localtime')) - ?1) / 3600 AS INTEGER) as bucket_idx,
                SUM(tokens_total)
         FROM usage_messages
         WHERE timestamp >= ?2 AND provider = ?3 AND {column} = ?4
         GROUP BY bucket_idx
         ORDER BY bucket_idx"
    );
    fill_named_trend(conn, query.as_str(), params![hour_start, since, provider, label], bucket_count)
}

fn query_named_trend_daily(
    conn: &Connection,
    since: i64,
    bucket_count: i64,
    dimension: &str,
    provider: &str,
    label: &str,
) -> Vec<u64> {
    let cutoff_date = cutoff_local_date(conn, since);
    let column = match dimension {
        "model" => "COALESCE(model, 'unknown')",
        "project" => "COALESCE(project, 'unknown')",
        _ => return vec![0; bucket_count as usize],
    };
    let query = format!(
        "SELECT CAST(julianday(bucket_day) - julianday(?1) AS INTEGER) as bucket_idx, SUM(tokens_total)
         FROM (
            SELECT date(timestamp, 'unixepoch', 'localtime') as bucket_day, provider, model, project, tokens_total
            FROM usage_messages
            WHERE timestamp >= ?2
            UNION ALL
            SELECT date as bucket_day, provider, model, project, tokens_total
            FROM usage_daily
            WHERE date >= ?1
         )
         WHERE provider = ?3 AND {column} = ?4
         GROUP BY bucket_idx
         ORDER BY bucket_idx"
    );
    fill_named_trend(conn, query.as_str(), params![cutoff_date, since, provider, label], bucket_count)
}

fn fill_named_trend<P: rusqlite::Params>(
    conn: &Connection,
    query: &str,
    params: P,
    bucket_count: i64,
) -> Vec<u64> {
    let mut values = vec![0; bucket_count as usize];
    let mut stmt = match conn.prepare(query) {
        Ok(stmt) => stmt,
        Err(_) => return values,
    };
    let rows = match stmt.query_map(params, |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    }) {
        Ok(rows) => rows,
        Err(_) => return values,
    };
    for row in rows.flatten() {
        let (bucket_idx, tokens) = row;
        if bucket_idx >= 0 && bucket_idx < bucket_count {
            values[bucket_idx as usize] = tokens as u64;
        }
    }
    values
}

fn cutoff_local_date(conn: &Connection, since: i64) -> String {
    conn.query_row(
        "SELECT date(?1, 'unixepoch', 'localtime')",
        params![since],
        |row| row.get::<_, String>(0),
    ).unwrap_or_else(|_| "1970-01-01".to_string())
}

fn day_start_epoch(conn: &Connection, date: &str) -> i64 {
    conn.query_row(
        "SELECT CAST(strftime('%s', ?1 || ' 00:00:00') AS INTEGER)",
        params![date],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(0)
}

fn align_to_local_hour(conn: &Connection, since: i64) -> i64 {
    conn.query_row(
        "SELECT CAST(strftime('%s', strftime('%Y-%m-%d %H:00:00', ?1, 'unixepoch', 'localtime')) AS INTEGER)",
        params![since],
        |row| row.get::<_, i64>(0),
    ).unwrap_or(since)
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
