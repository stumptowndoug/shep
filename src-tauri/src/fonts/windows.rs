//! Windows font enumeration and resolution, backed by `fontdb`.
//!
//! `fontdb` walks the system font directories (`C:\Windows\Fonts` plus the
//! per-user font store) and parses each face with `ttf-parser`, exposing the
//! family name, CSS-style weight/stretch, italic style, monospace flag, and
//! the on-disk source path — everything the shared wire contract needs.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use fontdb::{Database, Source, Stretch, Style};

use super::{is_nerd_font_name, FontFaceData, FontFamily};

/// Parsed system font database. Built once per process; an app restart is
/// required to pick up newly-installed fonts (same contract as macOS).
static FONT_DB: OnceLock<Database> = OnceLock::new();

fn font_db() -> &'static Database {
    FONT_DB.get_or_init(|| {
        let mut db = Database::new();
        db.load_system_fonts();
        db
    })
}

pub fn enumerate_monospace_families() -> Vec<FontFamily> {
    // family name -> (face_count, has_mono_face)
    let mut families: HashMap<&str, (usize, bool)> = HashMap::new();

    for face in font_db().faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        let entry = families.entry(name.as_str()).or_insert((0, false));
        entry.0 += 1;
        if face.monospaced {
            entry.1 = true;
        }
    }

    families
        .into_iter()
        .filter(|(_, (face_count, has_mono_face))| *has_mono_face && *face_count > 0)
        .map(|(family, (face_count, _))| FontFamily {
            family: family.to_string(),
            face_count,
            is_nerd_font: is_nerd_font_name(family),
        })
        .collect()
}

/// Resolve a font family name to every on-disk face. Returns an empty vec if
/// the family is not installed or cannot be read. Dedupes by canonical file
/// path (matching the macOS backend's behavior for .ttc collections).
pub fn load_font_family(family: &str) -> Vec<FontFaceData> {
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut result: Vec<FontFaceData> = Vec::new();

    for face in font_db().faces() {
        if !face.families.iter().any(|(name, _)| name == family) {
            continue;
        }

        let path = match &face.source {
            Source::File(path) | Source::SharedFile(path, _) => path,
            Source::Binary(_) => continue,
        };
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        if !seen_paths.insert(canonical.clone()) {
            continue;
        }

        let Ok(data) = fs::read(&canonical) else {
            continue;
        };

        result.push(FontFaceData {
            data,
            weight: face.weight.0.clamp(100, 900),
            italic: matches!(face.style, Style::Italic | Style::Oblique),
            stretch: stretch_index(face.stretch),
        });
    }

    result
}

/// Map a `fontdb::Stretch` to the CSS font-stretch keyword index used by the
/// wire contract (1 = ultra-condensed, 5 = normal, 9 = ultra-expanded).
fn stretch_index(stretch: Stretch) -> u16 {
    match stretch {
        Stretch::UltraCondensed => 1,
        Stretch::ExtraCondensed => 2,
        Stretch::Condensed => 3,
        Stretch::SemiCondensed => 4,
        Stretch::Normal => 5,
        Stretch::SemiExpanded => 6,
        Stretch::Expanded => 7,
        Stretch::ExtraExpanded => 8,
        Stretch::UltraExpanded => 9,
    }
}
