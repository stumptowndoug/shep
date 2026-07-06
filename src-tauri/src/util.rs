use std::ffi::OsStr;
use std::process::Command;

/// Build a `Command` that never flashes a console window on Windows.
///
/// Shep is a GUI-subsystem app; on Windows every console child (git, taskkill,
/// netstat, curl, ...) gets a fresh visible console unless CREATE_NO_WINDOW is
/// set. On other platforms this is identical to `Command::new`.
pub fn quiet_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}
