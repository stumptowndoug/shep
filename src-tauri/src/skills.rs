use std::fs;
use std::path::Path;

/// A prebuilt agent skill Shep can install into a repo. The markdown is
/// embedded at compile time; `name` doubles as the directory name under
/// `.agents/skills/` and must match the frontmatter `name:` in the file.
struct BuiltinSkill {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    markdown: &'static str,
}

const BUILTIN_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill {
        name: "shep-todos",
        title: "Project to-dos",
        description: "Teaches agents to keep TODO.md as a kanban board: move cards when starting or finishing work, add discovered work to the backlog, and reconcile the board before ending a session.",
        markdown: include_str!("todo_skill.md"),
    },
    BuiltinSkill {
        name: "orchestrate",
        title: "Orchestrate",
        description: "Turns any agent into a planner/orchestrator that delegates implementation to a different agent CLI running headless (codex, claude, opencode), reviews each task, and finishes with a fresh-context audit.",
        markdown: include_str!("orchestrate_skill.md"),
    },
];

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub title: String,
    pub description: String,
    pub installed: bool,
}

fn find_skill(name: &str) -> Result<&'static BuiltinSkill, String> {
    BUILTIN_SKILLS
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("Unknown skill: {name}"))
}

/// Whether the repo has the named skill installed at the standard location.
pub fn has_skill(repo_path: &str, name: &str) -> bool {
    Path::new(repo_path)
        .join(".agents/skills")
        .join(name)
        .join("SKILL.md")
        .is_file()
}

/// All built-in skills with their install state for this repo.
pub fn list_skills(repo_path: &str) -> Vec<SkillInfo> {
    BUILTIN_SKILLS
        .iter()
        .map(|s| SkillInfo {
            name: s.name.to_string(),
            title: s.title.to_string(),
            description: s.description.to_string(),
            installed: has_skill(repo_path, s.name),
        })
        .collect()
}

/// Write the skill at the cross-agent standard location (`.agents/skills/`)
/// and point `.claude/skills/` at it so Claude Code, Codex, and OpenCode
/// all pick it up from a single source file.
pub fn setup_skill(repo_path: &str, name: &str) -> Result<(), String> {
    let skill = find_skill(name)?;
    let root = Path::new(repo_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {repo_path}"));
    }

    let skill_dir = root.join(".agents/skills").join(skill.name);
    fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create {}: {e}", skill_dir.display()))?;
    fs::write(skill_dir.join("SKILL.md"), skill.markdown)
        .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

    let claude_skills = root.join(".claude/skills");
    let pointer = claude_skills.join(skill.name);
    if pointer.symlink_metadata().is_ok() {
        return Ok(()); // Something already there — leave the user's setup alone.
    }
    fs::create_dir_all(&claude_skills)
        .map_err(|e| format!("Failed to create {}: {e}", claude_skills.display()))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(Path::new("../../.agents/skills").join(skill.name), &pointer)
        .map_err(|e| format!("Failed to link Claude skill: {e}"))?;
    #[cfg(not(unix))]
    {
        fs::create_dir_all(&pointer).map_err(|e| format!("Failed to create skill dir: {e}"))?;
        fs::write(pointer.join("SKILL.md"), skill.markdown)
            .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;
    }
    Ok(())
}

/// Remove an installed skill: the `.agents/skills/<name>` directory, plus
/// the `.claude/skills/<name>` pointer — but only if the pointer is ours
/// (a symlink, or on non-unix a directory holding just SKILL.md).
pub fn remove_skill(repo_path: &str, name: &str) -> Result<(), String> {
    find_skill(name)?;
    let root = Path::new(repo_path);

    let skill_dir = root.join(".agents/skills").join(name);
    if skill_dir.is_dir() {
        fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Failed to remove {}: {e}", skill_dir.display()))?;
    }

    let pointer = root.join(".claude/skills").join(name);
    if let Ok(meta) = pointer.symlink_metadata() {
        if meta.file_type().is_symlink() {
            fs::remove_file(&pointer)
                .map_err(|e| format!("Failed to remove {}: {e}", pointer.display()))?;
        } else if meta.is_dir() {
            let only_skill_md = fs::read_dir(&pointer)
                .map(|entries| {
                    entries
                        .flatten()
                        .all(|e| e.file_name().to_string_lossy() == "SKILL.md")
                })
                .unwrap_or(false);
            if only_skill_md {
                fs::remove_dir_all(&pointer)
                    .map_err(|e| format!("Failed to remove {}: {e}", pointer.display()))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shep-skills-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn registry_markdown_names_match_directories() {
        for skill in BUILTIN_SKILLS {
            assert!(
                skill.markdown.contains(&format!("name: {}", skill.name)),
                "frontmatter name mismatch for {}",
                skill.name
            );
        }
    }

    #[test]
    fn setup_writes_standard_location_and_claude_pointer() {
        let dir = temp_repo("setup");
        let repo = dir.to_string_lossy().to_string();

        assert!(!has_skill(&repo, "shep-todos"));
        setup_skill(&repo, "shep-todos").unwrap();
        assert!(has_skill(&repo, "shep-todos"));

        let real = dir.join(".agents/skills/shep-todos/SKILL.md");
        assert!(real.is_file());
        assert!(fs::read_to_string(&real)
            .unwrap()
            .contains("name: shep-todos"));

        // The Claude pointer resolves to the same skill.
        let pointer = dir.join(".claude/skills/shep-todos/SKILL.md");
        assert!(fs::read_to_string(&pointer)
            .unwrap()
            .contains("name: shep-todos"));

        // Idempotent — a second run doesn't fail on the existing pointer.
        setup_skill(&repo, "shep-todos").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_reflects_install_state() {
        let dir = temp_repo("list");
        let repo = dir.to_string_lossy().to_string();

        let before = list_skills(&repo);
        assert_eq!(before.len(), BUILTIN_SKILLS.len());
        assert!(before.iter().all(|s| !s.installed));

        setup_skill(&repo, "orchestrate").unwrap();
        let after = list_skills(&repo);
        assert!(
            after
                .iter()
                .find(|s| s.name == "orchestrate")
                .unwrap()
                .installed
        );
        assert!(
            !after
                .iter()
                .find(|s| s.name == "shep-todos")
                .unwrap()
                .installed
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_deletes_skill_and_our_pointer() {
        let dir = temp_repo("remove");
        let repo = dir.to_string_lossy().to_string();

        setup_skill(&repo, "orchestrate").unwrap();
        remove_skill(&repo, "orchestrate").unwrap();
        assert!(!has_skill(&repo, "orchestrate"));
        assert!(dir
            .join(".claude/skills/orchestrate")
            .symlink_metadata()
            .is_err());

        // Removing an absent skill is a no-op, not an error.
        remove_skill(&repo, "orchestrate").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_leaves_foreign_claude_dir_alone() {
        let dir = temp_repo("foreign");
        let repo = dir.to_string_lossy().to_string();

        // A user-authored real directory at the pointer path, with extra files.
        let foreign = dir.join(".claude/skills/orchestrate");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("SKILL.md"), "user's own\n").unwrap();
        fs::write(foreign.join("notes.md"), "keep me\n").unwrap();

        remove_skill(&repo, "orchestrate").unwrap();
        assert!(foreign.join("notes.md").is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_skill_is_an_error() {
        let dir = temp_repo("unknown");
        let repo = dir.to_string_lossy().to_string();
        assert!(setup_skill(&repo, "nope").is_err());
        assert!(remove_skill(&repo, "nope").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
