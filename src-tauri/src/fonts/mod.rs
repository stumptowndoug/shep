//! Cross-platform font enumeration and resolution.
//!
//! Two public entry points:
//!
//! - [`list_monospace_families`] enumerates every installed font family that
//!   contains at least one monospace face. Result is cached in a `OnceLock`
//!   because enumeration walks every installed font and only changes when the
//!   user installs/removes fonts (an app restart recovers).
//!
//! - [`load_font_family`] resolves a family name to all of its on-disk faces,
//!   reads the raw font file bytes, and extracts CSS-compatible weight/italic/
//!   stretch values. The frontend passes each face to the `FontFace`
//!   constructor with proper descriptors so the browser does not synthesize
//!   bold/italic variants.
//!
//! The macOS backend uses CoreText; the Windows backend uses `fontdb`
//! (which parses the installed font files directly). Both produce the same
//! wire shapes so the frontend needs no platform awareness.

use std::sync::OnceLock;

use serde::Serialize;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

#[cfg(not(any(target_os = "macos", windows)))]
mod fallback {
    use super::{FontFaceData, FontFamily};

    pub fn enumerate_monospace_families() -> Vec<FontFamily> {
        Vec::new()
    }

    pub fn load_font_family(_family: &str) -> Vec<FontFaceData> {
        Vec::new()
    }
}
#[cfg(not(any(target_os = "macos", windows)))]
use fallback as backend;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub family: String,
    pub face_count: usize,
    pub is_nerd_font: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFaceData {
    /// Raw TTF/OTF bytes read from disk.
    pub data: Vec<u8>,
    /// CSS font-weight value in the 100..=900 range.
    pub weight: u16,
    /// Whether the face is italic or oblique.
    pub italic: bool,
    /// CSS font-stretch keyword index (1 = ultra-condensed .. 9 = ultra-expanded).
    pub stretch: u16,
}

/// Cached list of installed monospace families. Populated once per process.
static MONO_FAMILIES: OnceLock<Vec<FontFamily>> = OnceLock::new();

/// Return the cached list of installed monospace families, enumerating on
/// first call. The result is stable for the lifetime of the process; an app
/// restart is required to pick up newly-installed fonts.
pub fn list_monospace_families() -> Vec<FontFamily> {
    MONO_FAMILIES
        .get_or_init(|| {
            let mut result = backend::enumerate_monospace_families();
            // Nerd Fonts first, then alphabetical within each group. Developers
            // overwhelmingly want Nerd Font variants for powerline/devicons.
            result.sort_by(|a, b| {
                b.is_nerd_font
                    .cmp(&a.is_nerd_font)
                    .then_with(|| a.family.to_lowercase().cmp(&b.family.to_lowercase()))
            });
            result
        })
        .clone()
}

/// Resolve a font family name to every on-disk face. Returns an empty vec if
/// the family is not installed or cannot be read.
pub fn load_font_family(family: &str) -> Vec<FontFaceData> {
    backend::load_font_family(family)
}

/// Nerd Fonts register under their full name ("JetBrainsMono Nerd Font") or,
/// especially on Windows, the abbreviated "NF" suffix form ("JetBrainsMono NF").
pub(crate) fn is_nerd_font_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("nerd font")
        || lower.contains("nerdfont")
        || lower.ends_with(" nf")
        || lower.contains(" nf ")
}
