use std::fs;
use std::path::{Path, PathBuf};

/// Directories never scanned for todo files — build artifacts, deps, VCS internals.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    "__pycache__",
    "vendor",
    ".shep-worktrees",
];

/// Filenames (lowercased) recognized as todo files.
const TODO_FILENAMES: &[&str] = &["todo.md", "todos.md"];

/// How deep below the repo root to look for todo files.
const MAX_SCAN_DEPTH: usize = 3;

/// Hard cap on discovered files so a pathological repo can't flood the UI.
const MAX_TODO_FILES: usize = 20;

/// Skip parsing files larger than this — a real todo list is never 1 MB.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// 0-based line index of the checkbox line; used for surgical edits.
    pub line: usize,
    /// Item text with hanging-indent continuation lines joined in.
    pub text: String,
    pub checked: bool,
    /// Leading whitespace width, for rendering nested items.
    pub indent: usize,
    /// Nearest preceding markdown heading, if any.
    pub section: Option<String>,
    /// Line index of that heading.
    pub section_line: Option<usize>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoSection {
    pub line: usize,
    pub title: String,
    /// Heading level (number of `#`s).
    pub level: usize,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoFile {
    pub path: String,
    pub relative_path: String,
    pub sections: Vec<TodoSection>,
    pub items: Vec<TodoItem>,
}

pub fn read_todos(repo_path: &str) -> Result<Vec<TodoFile>, String> {
    let root = PathBuf::from(repo_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {repo_path}"));
    }

    let mut found: Vec<PathBuf> = Vec::new();
    scan_dir(&root, 0, &mut found);

    // Root-level file first, then shallower paths, then alphabetical.
    found.sort_by_key(|p| (p.components().count(), p.clone()));
    found.truncate(MAX_TODO_FILES);

    let mut files = Vec::new();
    for path in found {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Forward slashes on every platform — this string is display/grouping
        // data for the frontend, not a filesystem path.
        let relative_path = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
        let (sections, items) = parse_content(&content);
        files.push(TodoFile {
            path: path.to_string_lossy().to_string(),
            relative_path,
            sections,
            items,
        });
    }
    Ok(files)
}

pub fn toggle_todo(
    file_path: &str,
    line: usize,
    expected_text: &str,
    checked: bool,
) -> Result<(), String> {
    let content =
        fs::read_to_string(file_path).map_err(|e| format!("Failed to read {file_path}: {e}"))?;
    let mut lines: Vec<String> = content.split('\n').map(String::from).collect();

    // Verify against the same parse the UI rendered from, so expected_text
    // matches even when the item spans wrapped continuation lines.
    let (_, items) = parse_content(&content);
    let valid = items.iter().any(|i| i.line == line && i.text == expected_text);
    if !valid {
        return Err("To-do list changed on disk — try again".to_string());
    }

    lines[line] = set_checkbox(&lines[line], checked)?;
    fs::write(file_path, lines.join("\n"))
        .map_err(|e| format!("Failed to write {file_path}: {e}"))
}

/// Move a card — the checkbox line plus its continuation lines and nested
/// children — to the end of another section. `set_checked`, when given,
/// flips the card's own checkbox so its state agrees with the new column.
pub fn move_todo(
    file_path: &str,
    line: usize,
    expected_text: &str,
    target_section_line: usize,
    set_checked: Option<bool>,
) -> Result<(), String> {
    let content =
        fs::read_to_string(file_path).map_err(|e| format!("Failed to read {file_path}: {e}"))?;
    let mut lines: Vec<String> = content.split('\n').map(String::from).collect();

    let (sections, items) = parse_content(&content);
    let item = items
        .iter()
        .find(|i| i.line == line && i.text == expected_text)
        .ok_or_else(|| "To-do list changed on disk — try again".to_string())?;
    let target = sections
        .iter()
        .find(|s| s.line == target_section_line)
        .ok_or_else(|| "To-do list changed on disk — try again".to_string())?
        .clone();

    // Card block: from the item line until the next heading, the next item at
    // the same or shallower indent, or a blank line (trailing blanks excluded).
    let block_limit = items
        .iter()
        .filter(|i| i.line > item.line && i.indent <= item.indent)
        .map(|i| i.line)
        .chain(sections.iter().filter(|s| s.line > item.line).map(|s| s.line))
        .chain(
            lines
                .iter()
                .enumerate()
                .filter(|(i, l)| *i > item.line && l.trim().is_empty())
                .map(|(i, _)| i),
        )
        .min()
        .unwrap_or(lines.len());

    let mut block: Vec<String> = lines.drain(item.line..block_limit).collect();
    if let Some(checked) = set_checked {
        block[0] = set_checkbox(&block[0], checked)?;
    }

    // Collapse the doubled blank line the removal can leave behind.
    let mut removed_extra = 0;
    if item.line > 0
        && item.line < lines.len()
        && lines[item.line - 1].trim().is_empty()
        && lines[item.line].trim().is_empty()
    {
        lines.remove(item.line);
        removed_extra = 1;
    }

    // Re-locate the target heading after the removal shifted lines up.
    let mut t = target.line;
    if t > item.line {
        t -= block.len() + removed_extra;
    }
    if parse_heading(&lines[t]).map(|(_, title)| title) != Some(target.title.clone()) {
        return Err("To-do list changed on disk — try again".to_string());
    }

    let insert_at = section_insert_position(&lines, t, target.level);
    if insert_at == t + 1 {
        // Empty section: keep a blank line between the heading and the card.
        lines.insert(insert_at, String::new());
        lines.splice(insert_at + 1..insert_at + 1, block.iter().cloned());
        let after = insert_at + 1 + block.len();
        if after < lines.len() && !lines[after].trim().is_empty() {
            lines.insert(after, String::new());
        }
    } else {
        lines.splice(insert_at..insert_at, block.iter().cloned());
    }

    fs::write(file_path, lines.join("\n"))
        .map_err(|e| format!("Failed to write {file_path}: {e}"))
}

pub fn add_todo(
    repo_path: &str,
    file_path: Option<&str>,
    text: &str,
    section_line: Option<usize>,
    kanban: bool,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("To-do text is empty".to_string());
    }

    let path = match file_path {
        Some(p) => PathBuf::from(p),
        None => {
            // Lazy creation: the file materializes with the first to-do.
            let path = Path::new(repo_path).join("TODO.md");
            if !path.exists() {
                let initial = if kanban {
                    format!(
                        "# To-dos\n\n## 📋 Backlog\n\n- [ ] {text}\n\n## 🚧 In Progress\n\n## ✅ Done\n"
                    )
                } else {
                    format!("# TODO\n\n- [ ] {text}\n")
                };
                return fs::write(&path, initial)
                    .map_err(|e| format!("Failed to create TODO.md: {e}"));
            }
            path
        }
    };

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut lines: Vec<String> = content.split('\n').map(String::from).collect();

    let insert_at = match section_line {
        Some(section_line) => {
            let (sections, _) = parse_content(&content);
            let section = sections
                .iter()
                .find(|s| s.line == section_line)
                .ok_or_else(|| "To-do list changed on disk — try again".to_string())?;
            let pos = section_insert_position(&lines, section.line, section.level);
            if pos == section.line + 1 {
                lines.insert(pos, String::new());
                pos + 1
            } else {
                pos
            }
        }
        None => {
            // Insert after the last existing checkbox so the new item joins the
            // list block instead of landing below trailing notes; fall back to EOF.
            lines
                .iter()
                .rposition(|l| parse_checkbox_line(l).is_some())
                .map(|i| i + 1)
                .unwrap_or(lines.len())
        }
    };
    lines.insert(insert_at, format!("- [ ] {text}"));

    let mut joined = lines.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    fs::write(&path, joined).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

// ── Parsing ──────────────────────────────────────────────────────────

fn scan_dir(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };

        if path.is_dir() {
            if depth + 1 > MAX_SCAN_DEPTH || name.starts_with('.') || IGNORED_DIRS.contains(&name)
            {
                continue;
            }
            scan_dir(&path, depth + 1, found);
        } else if TODO_FILENAMES.contains(&name.to_lowercase().as_str()) {
            let small = entry.metadata().map(|m| m.len() <= MAX_FILE_BYTES).unwrap_or(false);
            if small {
                found.push(path);
            }
        }
    }
}

struct ParsedCheckbox<'a> {
    text: &'a str,
    checked: bool,
    indent: usize,
}

/// Strip a list marker — `- `, `* `, `+ `, or an ordered `1. ` / `1) `.
fn strip_list_marker(trimmed: &str) -> Option<&str> {
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        return Some(rest);
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits <= 9 {
        let after = &trimmed[digits..];
        return after
            .strip_prefix(". ")
            .or_else(|| after.strip_prefix(") "));
    }
    None
}

/// Parse a GFM task-list line: `- [ ] text`, `1. [x] text`, etc.
fn parse_checkbox_line(line: &str) -> Option<ParsedCheckbox<'_>> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();

    let rest = strip_list_marker(trimmed)?;
    let rest = rest.trim_start();

    let mut chars = rest.chars();
    if chars.next() != Some('[') {
        return None;
    }
    let mark = chars.next()?;
    if chars.next() != Some(']') {
        return None;
    }
    let checked = match mark {
        ' ' => false,
        'x' | 'X' => true,
        _ => return None,
    };

    let after = chars.as_str();
    if !after.is_empty() && !after.starts_with(' ') {
        return None;
    }
    Some(ParsedCheckbox {
        text: after.trim(),
        checked,
        indent,
    })
}

/// Parse an ATX heading; returns (level, title).
fn parse_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    let title = &trimmed[level..];
    if !title.is_empty() && !title.starts_with(' ') {
        return None;
    }
    Some((level, title.trim().to_string()))
}

/// A wrapped continuation of an item's text: deeper-indented prose that is
/// neither a heading nor a new list entry of its own.
fn is_continuation(line: &str, item_indent: usize) -> bool {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return false;
    }
    let indent = line.len() - trimmed.len();
    indent > item_indent && strip_list_marker(trimmed).is_none()
}

fn parse_content(content: &str) -> (Vec<TodoSection>, Vec<TodoItem>) {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut sections: Vec<TodoSection> = Vec::new();
    let mut items: Vec<TodoItem> = Vec::new();
    let mut current: Option<(String, usize)> = None;

    let mut i = 0;
    while i < lines.len() {
        if let Some((level, title)) = parse_heading(lines[i]) {
            if !title.is_empty() {
                sections.push(TodoSection {
                    line: i,
                    title: title.clone(),
                    level,
                });
                current = Some((title, i));
            } else {
                current = None;
            }
            i += 1;
            continue;
        }
        if let Some(parsed) = parse_checkbox_line(lines[i]) {
            if parsed.text.is_empty() {
                i += 1;
                continue;
            }
            let mut text = parsed.text.to_string();
            let mut span = 1;
            while i + span < lines.len() && is_continuation(lines[i + span], parsed.indent) {
                text.push(' ');
                text.push_str(lines[i + span].trim());
                span += 1;
            }
            items.push(TodoItem {
                line: i,
                text,
                checked: parsed.checked,
                indent: parsed.indent,
                section: current.as_ref().map(|(t, _)| t.clone()),
                section_line: current.as_ref().map(|(_, l)| *l),
            });
            i += span;
            continue;
        }
        i += 1;
    }
    (sections, items)
}

/// Flip the checkbox marker on a line, leaving everything else untouched.
fn set_checkbox(line: &str, checked: bool) -> Result<String, String> {
    // The first '[' on a checkbox line is the marker; flip only that byte.
    let bracket = line.find('[').ok_or("Malformed to-do line")?;
    let mut updated = line.to_string();
    updated.replace_range(bracket + 1..bracket + 2, if checked { "x" } else { " " });
    Ok(updated)
}

/// Where a new card lands in a section: after its last non-blank line, before
/// the next heading at the same or shallower level. Returns `heading_line + 1`
/// for an empty section.
fn section_insert_position(lines: &[String], heading_line: usize, level: usize) -> usize {
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate().skip(heading_line + 1) {
        if let Some((l, _)) = parse_heading(line) {
            if l <= level {
                end = i;
                break;
            }
        }
    }
    while end > heading_line + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_items(content: &str) -> Vec<TodoItem> {
        parse_content(content).1
    }

    #[test]
    fn parses_checkboxes_with_sections() {
        let content = "# TODO\n\n## Now\n- [ ] first\n  - [x] nested done\n* [ ] star bullet\n\n## Later\n- [-] declined ignored\n- [ ]\n- [ ] last\n";
        let items = parse_items(content);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].text, "first");
        assert_eq!(items[0].section.as_deref(), Some("Now"));
        assert_eq!(items[0].section_line, Some(2));
        assert!(!items[0].checked);
        assert!(items[1].checked);
        assert_eq!(items[1].indent, 2);
        assert_eq!(items[3].text, "last");
        assert_eq!(items[3].section.as_deref(), Some("Later"));
    }

    #[test]
    fn parses_ordered_list_checkboxes() {
        let content = "## Now\n1. [ ] first ordered\n2. [x] second done\n10) [ ] paren style\n3. not a checkbox\n";
        let items = parse_items(content);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "first ordered");
        assert!(items[1].checked);
        assert_eq!(items[2].text, "paren style");
    }

    #[test]
    fn joins_wrapped_continuation_lines() {
        let content = "- [ ] a long item that wraps\n      onto the next line\n      and one more\n- [ ] second\n  - [ ] child stays separate\n";
        let items = parse_items(content);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "a long item that wraps onto the next line and one more");
        assert_eq!(items[1].text, "second");
        assert_eq!(items[2].text, "child stays separate");
    }

    #[test]
    fn collects_sections_with_levels() {
        let content = "# Title\n\n## Backlog\n- [ ] a\n\n## Done\n- [x] b\n";
        let (sections, _) = parse_content(content);
        let titles: Vec<(usize, &str)> =
            sections.iter().map(|s| (s.level, s.title.as_str())).collect();
        assert_eq!(titles, vec![(1, "Title"), (2, "Backlog"), (2, "Done")]);
    }

    #[test]
    fn ignores_non_checkbox_lines() {
        let items = parse_items("plain text\n- regular bullet\n-[ ] no space\n[ ] no bullet\n");
        assert!(items.is_empty());
    }

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shep-todos-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn toggle_flips_only_the_marker() {
        let dir = temp_repo("toggle");
        let path = dir.join("TODO.md");
        fs::write(&path, "# TODO\n\n- [ ] keep [brackets] intact\n- [x] other\n").unwrap();
        let p = path.to_string_lossy().to_string();

        toggle_todo(&p, 2, "keep [brackets] intact", true).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# TODO\n\n- [x] keep [brackets] intact\n- [x] other\n"
        );

        // Stale expected text → error, file untouched
        assert!(toggle_todo(&p, 3, "something else", false).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn toggle_matches_joined_continuation_text() {
        let dir = temp_repo("toggle-wrap");
        let path = dir.join("TODO.md");
        fs::write(&path, "1. [ ] wrapped item\n   second half\n").unwrap();
        let p = path.to_string_lossy().to_string();

        toggle_todo(&p, 0, "wrapped item second half", true).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "1. [x] wrapped item\n   second half\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_carries_children_and_syncs_checkbox() {
        let dir = temp_repo("move");
        let path = dir.join("TODO.md");
        fs::write(
            &path,
            "## Backlog\n\n- [ ] ship it\n  - [x] subtask\n- [ ] stays\n\n## Done\n\n- [x] old\n",
        )
        .unwrap();
        let p = path.to_string_lossy().to_string();

        // "## Done" is line 6.
        move_todo(&p, 2, "ship it", 6, Some(true)).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "## Backlog\n\n- [ ] stays\n\n## Done\n\n- [x] old\n- [x] ship it\n  - [x] subtask\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_into_empty_section_keeps_blank_separation() {
        let dir = temp_repo("move-empty");
        let path = dir.join("TODO.md");
        fs::write(&path, "## Backlog\n\n- [x] task\n\n## In Progress\n\n## Done\n").unwrap();
        let p = path.to_string_lossy().to_string();

        move_todo(&p, 2, "task", 4, Some(false)).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "## Backlog\n\n## In Progress\n\n- [ ] task\n\n## Done\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_creates_file_lazily_and_inserts_after_last_item() {
        let dir = temp_repo("add");
        let repo = dir.to_string_lossy().to_string();

        add_todo(&repo, None, "first task", None, false).unwrap();
        let path = dir.join("TODO.md");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# TODO\n\n- [ ] first task\n"
        );

        fs::write(&path, "# TODO\n\n- [ ] a\n\ntrailing notes\n").unwrap();
        add_todo(&repo, Some(&path.to_string_lossy()), "b", None, false).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# TODO\n\n- [ ] a\n- [ ] b\n\ntrailing notes\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_creates_kanban_skeleton_and_targets_sections() {
        let dir = temp_repo("add-kanban");
        let repo = dir.to_string_lossy().to_string();

        add_todo(&repo, None, "first task", None, true).unwrap();
        let path = dir.join("TODO.md");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# To-dos\n\n## 📋 Backlog\n\n- [ ] first task\n\n## 🚧 In Progress\n\n## ✅ Done\n"
        );

        // "## 🚧 In Progress" is line 6: add into the empty column.
        add_todo(&repo, Some(&path.to_string_lossy()), "started", Some(6), false).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# To-dos\n\n## 📋 Backlog\n\n- [ ] first task\n\n## 🚧 In Progress\n\n- [ ] started\n\n## ✅ Done\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovers_files_case_insensitively_and_skips_ignored_dirs() {
        let dir = temp_repo("scan");
        fs::write(dir.join("todo.md"), "- [ ] root\n").unwrap();
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::write(dir.join("docs/TODOS.md"), "- [ ] nested\n").unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("node_modules/pkg/TODO.md"), "- [ ] ignored\n").unwrap();

        let files = read_todos(&dir.to_string_lossy()).unwrap();
        let rels: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();
        assert_eq!(rels, vec!["todo.md", "docs/TODOS.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

}

