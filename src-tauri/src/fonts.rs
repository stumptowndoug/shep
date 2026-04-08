use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFile {
    /// Raw font file bytes (TTF/OTF)
    pub data: Vec<u8>,
    /// Font style, e.g. "Regular", "Bold", "Italic", "Bold Italic"
    pub style: String,
}

/// Resolve a font family name to its on-disk font files using the macOS CoreText API.
/// Returns an empty Vec on non-macOS platforms or if the family is not found.
#[cfg(target_os = "macos")]
pub fn resolve_font_files_for_family(family_name: &str) -> Vec<FontFile> {
    let collection = match core_text::font_collection::create_for_family(family_name) {
        Some(c) => c,
        None => return Vec::new(),
    };

    let descriptors = match collection.get_descriptors() {
        Some(d) => d,
        None => return Vec::new(),
    };

    let mut result = Vec::new();
    for desc in descriptors.iter() {
        let Some(path) = desc.font_path() else {
            continue;
        };

        let Ok(data) = std::fs::read(&path) else {
            continue;
        };

        let style = desc.style_name();

        result.push(FontFile { data, style });
    }

    result
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_font_files_for_family(_family_name: &str) -> Vec<FontFile> {
    Vec::new()
}
