mod commands;
mod fonts;
mod git;
mod menu;
mod pi_config;
mod pty;
mod session_history;
mod session_titles;
mod skills;
mod todos;
mod usage;
mod watcher;
mod workspace;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use pty::manager::PtyManager;
use usage::UsageDb;
use watcher::GitWatcher;
use workspace::manager::WorkspaceManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fix_path_env::fix();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::new())
        .manage(WorkspaceManager::new())
        .manage(UsageDb::open().unwrap_or_else(|e| {
            eprintln!("Usage database failed to open ({e}), using in-memory fallback");
            UsageDb::open_in_memory()
        }))
        .setup(|app| {
            // Run migration from old project-based config
            let workspace = app.state::<WorkspaceManager>();
            if let Err(e) = workspace.migrate() {
                eprintln!("Migration warning: {e}");
            }
            if let Err(e) = workspace.backfill_global_config_defaults() {
                eprintln!("Config backfill warning: {e}");
            }

            // Start file system watcher for git status updates
            app.manage(GitWatcher::new(app.handle().clone()));

            // Kick off background usage ingestion so it doesn't block startup
            let db = app.state::<UsageDb>().inner().clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                usage::run_background_ingest(&db);
                let _ = handle.emit("usage-ingest-complete", ());
            });

            menu::setup(app.handle())?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let pty = window.state::<PtyManager>();
                if pty.is_shutting_down() {
                    return;
                }
                let count = pty.session_count();
                if count > 0 {
                    api.prevent_close();
                    let _ = window.emit("quit-requested", count);
                } else {
                    pty.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_repos,
            commands::register_repo,
            commands::unregister_repo,
            commands::load_workspace,
            commands::save_workspace,
            commands::list_groups,
            commands::create_group,
            commands::rename_group,
            commands::delete_group,
            commands::move_repo_to_group,
            commands::get_editor_settings,
            commands::get_project_settings,
            commands::save_editor_settings,
            commands::save_project_settings,
            commands::get_keybinding_settings,
            commands::save_keybinding_settings,
            commands::get_terminal_settings,
            commands::save_terminal_settings,
            commands::list_monospace_families,
            commands::load_font_family,
            commands::open_in_editor,
            commands::reveal_in_finder,
            commands::spawn_pty,
            commands::write_pty,
            commands::acknowledge_pty_output,
            commands::update_pty_color_theme,
            commands::resize_pty,
            commands::kill_pty,
            commands::resolve_session_title,
            commands::upsert_session_history,
            commands::record_session_history_activity,
            commands::list_session_history,
            commands::get_pty_session_count,
            commands::shutdown_and_quit,
            commands::get_username,
            commands::get_home_directory,
            commands::get_default_shell,
            commands::get_computer_name,
            commands::is_git_repo,
            commands::git_init,
            commands::git_current_branch,
            commands::git_list_branches,
            commands::git_push_branch,
            commands::git_list_worktrees,
            commands::git_create_worktree,
            commands::git_status,
            commands::git_changed_files,
            commands::git_file_diff,
            commands::git_file_contents,
            commands::git_list_files,
            commands::git_stage_file,
            commands::git_stage_all,
            commands::git_commit,
            commands::git_unstage_file,
            commands::git_unstage_all,
            commands::git_switch_branch,
            commands::git_create_branch,
            commands::git_diff_stats,
            commands::read_todos,
            commands::toggle_todo,
            commands::add_todo,
            commands::move_todo,
            commands::list_skills,
            commands::setup_skill,
            commands::remove_skill,
            commands::check_command_exists,
            commands::get_usage_settings,
            commands::save_usage_settings,
            commands::get_all_usage_snapshots,
            commands::get_usage_snapshot,
            commands::get_usage_details,
            commands::get_usage_overview,
            commands::get_project_alias_review_queue,
            commands::get_models_for_provider,
            commands::refresh_usage_data,
            commands::get_memory_stats,
            commands::watch_repo,
            commands::unwatch_repo,
            commands::list_listening_ports,
            commands::kill_port,
            commands::open_url,
            commands::get_pi_config,
            commands::save_pi_settings,
            commands::save_pi_api_key,
            commands::delete_pi_api_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = &event {
            let pty = app_handle.state::<PtyManager>();
            if pty.is_shutting_down() {
                return;
            }
            let count = pty.session_count();
            if count > 0 {
                api.prevent_exit();
                let _ = app_handle.emit("quit-requested", count);
            } else {
                app_handle.state::<GitWatcher>().shutdown();
                pty.kill_all();
            }
        }
    });
}
