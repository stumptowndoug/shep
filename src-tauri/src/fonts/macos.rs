//! macOS CoreText-based font enumeration and resolution.
//!
//! - [`enumerate_monospace_families`] enumerates every installed font family
//!   that advertises the `kCTFontMonoSpaceTrait` symbolic trait.
//!
//! - [`load_font_family`] resolves a family name to all of its on-disk faces
//!   via `CTFontCollectionCreateForFamily`, reads the raw font file bytes, and
//!   extracts CSS-compatible weight/italic/stretch values from the descriptor's
//!   traits attribute dictionary.

use std::fs;
use std::path::PathBuf;

use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFType, CFTypeRef, TCFType},
    dictionary::{CFDictionary, CFDictionaryGetValueIfPresent, CFDictionaryRef},
    number::{CFNumber, CFNumberRef},
    string::{CFString, CFStringRef},
    url::{CFURL, CFURLRef},
};
use core_text::{
    font_collection,
    font_descriptor::{kCTFontTraitsAttribute, kCTFontURLAttribute, CTFontDescriptor},
};

use super::{is_nerd_font_name, FontFaceData, FontFamily};

// Raw CTFontDescriptor pointer, for the FFI signatures below. Equivalent to
// `CTFontDescriptorRef` in the CoreText C headers.
type CTFontDescriptorRefRaw = *const std::ffi::c_void;

// Symbolic + axis trait keys that live on the `kCTFontTraitsAttribute`
// dictionary but aren't re-exported by the core-text crate at the time of
// writing. Also link to `CTFontDescriptorCopyAttribute`, which — unlike the
// crate's `attributes()` helper — returns a *computed* attribute value for an
// arbitrary attribute key rather than only the creation-time attributes.
//
// This distinction matters: descriptors returned from a family-name lookup
// only have `{kCTFontFamilyNameAttribute}` set, so `attributes()` never
// contains the traits dict or file URL. `CopyAttribute` queries the actual
// font for these values.
#[link(name = "CoreText", kind = "framework")]
extern "C" {
    static kCTFontSymbolicTrait: CFStringRef;
    static kCTFontWeightTrait: CFStringRef;
    static kCTFontSlantTrait: CFStringRef;
    static kCTFontWidthTrait: CFStringRef;
    fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    fn CTFontDescriptorCopyAttribute(
        descriptor: CTFontDescriptorRefRaw,
        attribute: CFStringRef,
    ) -> CFTypeRef;
}

/// Bit set in `kCTFontSymbolicTrait` when the font is monospace.
const MONO_SPACE_TRAIT: u32 = 1 << 10;

pub fn enumerate_monospace_families() -> Vec<FontFamily> {
    let family_names = all_family_names();
    let mut result: Vec<FontFamily> = Vec::with_capacity(family_names.len());

    for name in family_names {
        let Some(collection) = font_collection::create_for_family(&name) else {
            continue;
        };
        let Some(descriptors) = collection.get_descriptors() else {
            continue;
        };

        let mut face_count = 0usize;
        let mut has_mono_face = false;

        for desc in descriptors.iter() {
            face_count += 1;
            if !has_mono_face {
                let (_, _, _, symbolic) = read_traits(&desc);
                if (symbolic & MONO_SPACE_TRAIT) != 0 {
                    has_mono_face = true;
                }
            }
        }

        if !has_mono_face || face_count == 0 {
            continue;
        }

        result.push(FontFamily {
            family: name.clone(),
            face_count,
            is_nerd_font: is_nerd_font_name(&name),
        });
    }

    result
}

fn all_family_names() -> Vec<String> {
    unsafe {
        let array_ref = CTFontManagerCopyAvailableFontFamilyNames();
        if array_ref.is_null() {
            return Vec::new();
        }
        let array: CFArray<CFString> = CFArray::wrap_under_create_rule(array_ref);
        array.iter().map(|s| s.to_string()).collect()
    }
}

/// Resolve a font family name to every on-disk face. Returns an empty vec if
/// the family is not installed or cannot be read.
pub fn load_font_family(family: &str) -> Vec<FontFaceData> {
    let Some(collection) = font_collection::create_for_family(family) else {
        return Vec::new();
    };
    let Some(descriptors) = collection.get_descriptors() else {
        return Vec::new();
    };

    use std::collections::HashSet;
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut result: Vec<FontFaceData> = Vec::new();

    for desc in descriptors.iter() {
        let Some(path) = read_font_path(&desc) else {
            continue;
        };
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        if !seen_paths.insert(canonical.clone()) {
            continue;
        }

        let Ok(data) = fs::read(&canonical) else {
            continue;
        };

        let (weight_raw, slant_raw, width_raw, _symbolic) = read_traits(&desc);

        result.push(FontFaceData {
            data,
            weight: css_weight_from_trait(weight_raw),
            italic: slant_raw.abs() > 1e-3,
            stretch: css_stretch_from_trait(width_raw),
        });
    }

    result
}

/// Read `kCTFontTraitsAttribute` and extract (weight, slant, width, symbolic).
/// Missing values fall back to 0.0 / 0.
fn read_traits(desc: &CTFontDescriptor) -> (f64, f64, f64, u32) {
    let raw_desc = desc.as_concrete_TypeRef() as CTFontDescriptorRefRaw;
    let traits_raw = unsafe { CTFontDescriptorCopyAttribute(raw_desc, kCTFontTraitsAttribute) };
    if traits_raw.is_null() {
        return (0.0, 0.0, 0.0, 0);
    }

    // Take ownership of the +1 retain from Copy*; the wrapper releases on drop.
    let traits_dict: CFDictionary<CFString, CFType> = unsafe {
        CFDictionary::wrap_under_create_rule(traits_raw as CFDictionaryRef)
    };
    let dict_ref = traits_dict.as_concrete_TypeRef();

    unsafe {
        let weight = dict_get_number(dict_ref, kCTFontWeightTrait).unwrap_or(0.0);
        let slant = dict_get_number(dict_ref, kCTFontSlantTrait).unwrap_or(0.0);
        let width = dict_get_number(dict_ref, kCTFontWidthTrait).unwrap_or(0.0);
        let symbolic = dict_get_number(dict_ref, kCTFontSymbolicTrait).unwrap_or(0.0) as u32;
        (weight, slant, width, symbolic)
    }
}

unsafe fn dict_get_number(dict: CFDictionaryRef, key: CFStringRef) -> Option<f64> {
    let mut value: *const std::os::raw::c_void = std::ptr::null();
    let found = CFDictionaryGetValueIfPresent(
        dict,
        key as *const std::os::raw::c_void,
        &mut value,
    );
    if found == 0 || value.is_null() {
        return None;
    }
    let num = CFNumber::wrap_under_get_rule(value as CFNumberRef);
    num.to_f64()
}

fn read_font_path(desc: &CTFontDescriptor) -> Option<PathBuf> {
    let raw_desc = desc.as_concrete_TypeRef() as CTFontDescriptorRefRaw;
    let url_raw = unsafe { CTFontDescriptorCopyAttribute(raw_desc, kCTFontURLAttribute) };
    if url_raw.is_null() {
        return None;
    }
    // Take ownership of the +1 retain; CFURL releases on drop.
    let url: CFURL = unsafe { CFURL::wrap_under_create_rule(url_raw as CFURLRef) };
    url.to_path()
}

/// Map a CoreText `kCTFontWeightTrait` value (nominally -1.0..=1.0) to CSS
/// font-weight (100..=900). Based on Apple's own reference values:
///
/// | Name        | Trait value | CSS weight |
/// |-------------|-------------|------------|
/// | Ultralight  | -0.80       | 100        |
/// | Thin        | -0.60       | 200        |
/// | Light       | -0.40       | 300        |
/// | Regular     |  0.00       | 400        |
/// | Medium      |  0.23       | 500        |
/// | Semibold    |  0.30       | 600        |
/// | Bold        |  0.40       | 700        |
/// | Heavy       |  0.56       | 800        |
/// | Black       |  0.62       | 900        |
///
/// Uses nearest-neighbor lookup because Apple's reference values are not
/// linearly spaced.
fn css_weight_from_trait(raw: f64) -> u16 {
    const TABLE: [(f64, u16); 9] = [
        (-0.80, 100),
        (-0.60, 200),
        (-0.40, 300),
        (0.00, 400),
        (0.23, 500),
        (0.30, 600),
        (0.40, 700),
        (0.56, 800),
        (0.62, 900),
    ];

    let mut best = TABLE[0];
    let mut best_dist = (raw - best.0).abs();
    for entry in &TABLE[1..] {
        let dist = (raw - entry.0).abs();
        if dist < best_dist {
            best = *entry;
            best_dist = dist;
        }
    }
    best.1
}

/// Map a CoreText `kCTFontWidthTrait` value (-1.0..=1.0) to a CSS font-stretch
/// keyword index (1 = ultra-condensed, 5 = normal, 9 = ultra-expanded).
fn css_stretch_from_trait(raw: f64) -> u16 {
    if raw <= -0.75 {
        1
    } else if raw <= -0.5 {
        2
    } else if raw <= -0.25 {
        3
    } else if raw <= -0.08 {
        4
    } else if raw <= 0.08 {
        5
    } else if raw <= 0.25 {
        6
    } else if raw <= 0.5 {
        7
    } else if raw <= 0.75 {
        8
    } else {
        9
    }
}
