#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use std::result::Result as StdResult;
use tauri::Manager;
use pdfium_render::prelude::*;
use std::sync::{Mutex, OnceLock};
use std::collections::HashMap;
use std::io::Cursor;
use image::ImageFormat;
use image::imageops::FilterType;
use url::Url;
use lopdf::{Document as LopdfDocument, Bookmark as LopdfBookmark};
use std::time::{SystemTime, UNIX_EPOCH};
use base64::Engine as _;

#[derive(serde::Deserialize)]
struct PrintSettings {
    scope: String,
    #[serde(default)]
    current_page: usize,
    custom_range: String,
    include_headers: bool,
    header_left: String,
    header_center: String,
    header_right: String,
    include_footer: bool,
    footer_left: String,
    footer_center: String,
    footer_right: String,
    #[serde(default)]
    color_mode: String,
    #[serde(default)]
    paper_size: String,
    #[serde(default)]
    quality_dpi: u32,
    #[serde(default)]
    requested_page_index: Option<usize>,
}

#[derive(serde::Serialize)]
struct PreviewResult {
    image: String,
    total_pages: usize,
}

// === Printer Control ===
#[derive(serde::Serialize)]
struct PrinterInfo {
    name: String,
    is_default: bool,
}

#[tauri::command]
fn list_printers() -> Vec<PrinterInfo> {
    printers::get_printers()
        .iter()
        .map(|p| PrinterInfo {
            name: p.name.clone(),
            is_default: p.is_default,
        })
        .collect()
}

#[derive(serde::Deserialize)]
struct DirectPrintSettings {
    printer_name: String,
    copies: u32,
    color_mode: String,
    duplex: String,
    quality_dpi: u32,
    paper_size: String,
    scope: String,
    #[serde(default)]
    current_page: usize,
    custom_range: String,
    include_headers: bool,
    header_left: String,
    header_center: String,
    header_right: String,
    include_footer: bool,
    footer_left: String,
    footer_center: String,
    footer_right: String,
    #[serde(default)]
    target_path: Option<String>,
}

/// Shared helper: resolve page scope to indices
fn resolve_page_indices(scope: &str, current_page: usize, custom_range: &str, total: usize) -> Vec<usize> {
    match scope {
        "current" => vec![current_page],
        "odd" => (0..total).filter(|i| (i + 1) % 2 != 0).collect(),
        "even" => (0..total).filter(|i| (i + 1) % 2 == 0).collect(),
        "custom" => parse_page_range(custom_range, total),
        _ => (0..total).collect(),
    }
}

fn parse_page_range(range: &str, total: usize) -> Vec<usize> {
    let mut pages = Vec::new();
    for part in range.split(',') {
        let part = part.trim();
        if part.is_empty() { continue; }
        if let Some((start, end)) = part.split_once('-') {
            if let (Ok(s), Ok(e)) = (start.parse::<usize>(), end.parse::<usize>()) {
                for i in s..=e {
                    if i > 0 && i <= total { pages.push(i - 1); }
                }
            }
        } else if let Ok(p) = part.parse::<usize>() {
            if p > 0 && p <= total { pages.push(p - 1); }
        }
    }
    pages.sort();
    pages.dedup();
    pages
}

/// Shared helper: prepare a new PdfDocument with pages copied, rotated, and with headers/footers applied
fn prepare_pages_for_print(
    v_pages: &[VirtualPage],
    docs: &mut HashMap<String, PdfDocument<'static>>,
    indices: &[usize],
    include_headers: bool,
    header_left: &str,
    header_center: &str,
    header_right: &str,
    include_footer: bool,
    footer_left: &str,
    footer_center: &str,
    footer_right: &str,
) -> StdResult<PdfDocument<'static>, String> {
    let pdfium = PDFIUM_LIB.get().ok_or("Pdfium not init")?;
    let mut new_doc = pdfium.0.create_new_pdf().map_err(|e| e.to_string())?;
    let std_font_token = new_doc.fonts_mut().helvetica();

    for (print_page_num, &v_index) in indices.iter().enumerate() {
        if v_index >= v_pages.len() { continue; }
        let v_page = &v_pages[v_index];
        get_or_load_doc(&v_page.source_path, docs)?;
        let src_doc = docs.get(&v_page.source_path).ok_or("Doc load fail")?;
        let current_len = new_doc.pages().len();
        new_doc.pages_mut().copy_page_from_document(src_doc, v_page.original_index, current_len)
            .map_err(|e| format!("Copy fail: {}", e))?;

        let mut new_page = new_doc.pages_mut().last().map_err(|_| "New page missing")?;
        let current_rot = new_page.rotation().map_err(|_| "Get rot fail")?;
        let final_rot_deg = (current_rot.as_degrees() as u16 + v_page.rotation) % 360;
        let new_rot_enum = match final_rot_deg {
            90 => PdfPageRenderRotation::Degrees90,
            180 => PdfPageRenderRotation::Degrees180,
            270 => PdfPageRenderRotation::Degrees270,
            _ => PdfPageRenderRotation::None,
        };
        new_page.set_rotation(new_rot_enum);

        let width = new_page.width().value;
        let height = new_page.height().value;
        let page_var = format!("{}", print_page_num + 1);
        let replace_vars = |s: &str| s.replace("[Page]", &page_var);

        if include_headers {
            let header_y = height - 20.0;
            let size = PdfPoints::new(10.0);
            if !header_left.is_empty() {
                let _ = new_page.objects_mut().create_text_object(
                    PdfPoints::new(20.0), PdfPoints::new(header_y),
                    replace_vars(header_left), std_font_token, size,
                ).map_err(|e| e.to_string())?;
            }
            if !header_center.is_empty() {
                let _ = new_page.objects_mut().create_text_object(
                    PdfPoints::new(width / 2.0 - 10.0), PdfPoints::new(header_y),
                    replace_vars(header_center), std_font_token, size,
                ).map_err(|e| e.to_string())?;
            }
            if !header_right.is_empty() {
                let text = replace_vars(header_right);
                let est_width = (text.len() as f32) * 5.0;
                let _ = new_page.objects_mut().create_text_object(
                    PdfPoints::new(width - 20.0 - est_width), PdfPoints::new(header_y),
                    text, std_font_token, size,
                ).map_err(|e| e.to_string())?;
            }
        }
        if include_footer {
            let footer_y = 20.0;
            let size = PdfPoints::new(10.0);
            if !footer_left.is_empty() {
                let _ = new_page.objects_mut().create_text_object(
                    PdfPoints::new(20.0), PdfPoints::new(footer_y),
                    replace_vars(footer_left), std_font_token, size,
                ).map_err(|e| e.to_string())?;
            }
            if !footer_center.is_empty() {
                let _ = new_page.objects_mut().create_text_object(
                    PdfPoints::new(width / 2.0 - 10.0), PdfPoints::new(footer_y),
                    replace_vars(footer_center), std_font_token, size,
                ).map_err(|e| e.to_string())?;
            }
            if !footer_right.is_empty() {
                let text = replace_vars(footer_right);
                let est_width = (text.len() as f32) * 5.0;
                let _ = new_page.objects_mut().create_text_object(
                    PdfPoints::new(width - 20.0 - est_width), PdfPoints::new(footer_y),
                    text, std_font_token, size,
                ).map_err(|e| e.to_string())?;
            }
        }
        new_page.regenerate_content().map_err(|e| format!("Gen content: {}", e))?;
    }
    Ok(new_doc)
}

/// Shared helper: render a PdfPage to a DynamicImage with color mode applied
fn render_page_with_color(
    page: &PdfPage,
    target_width: u32,
    color_mode: &str,
) -> StdResult<image::DynamicImage, String> {
    let (p_w, p_h) = (page.width().value, page.height().value);

    // Calculate dimensions based on original aspect ratio
    let (render_w, render_h) = if p_w > p_h {
        // Landscape: target width, calculate height
        (target_width, (target_width as f32 * (p_h / p_w)) as u32)
    } else {
        // Portrait: target height, calculate width (using target_width as the max dimension)
        ((target_width as f32 * (p_w / p_h)) as u32, target_width)
    };

    let render_config = PdfRenderConfig::new()
        .set_target_width(render_w as i32)
        .set_target_height(render_h as i32)
        .rotate(PdfPageRenderRotation::None, true); // No auto-rotate

    let bitmap = page.render_with_config(&render_config)
        .map_err(|e| format!("Render fail: {}", e))?;
    let mut img = bitmap.as_image();

    match color_mode {
        "grayscale" => {
            img = image::DynamicImage::ImageLuma8(img.to_luma8());
        },
        "bw" => {
            let mut gray = img.to_luma8();
            image::imageops::dither(&mut gray, &image::imageops::colorops::BiLevel);
            img = image::DynamicImage::ImageLuma8(gray);
        },
        _ => {}
    }

    // Always return as RGBA8 for maximum compatibility with Pdfium and potential alpha channel handling
    Ok(image::DynamicImage::ImageRgba8(img.to_rgba8()))
}

/// Rasterize pages and create a new PDF with image-based pages (for grayscale/bw printing)
fn rasterize_to_pdf(
    source_doc: &PdfDocument,
    quality_dpi: u32,
    color_mode: &str,
    paper_size_str: &str,
) -> StdResult<PdfDocument<'static>, String> {
    let pdfium = PDFIUM_LIB.get().ok_or("Pdfium not init")?;
    let mut final_doc = pdfium.0.create_new_pdf().map_err(|e| e.to_string())?;
    let target_width = match quality_dpi {
        150 => 1240_u32,
        600 => 4960,
        _ => 2480,
    };

    for page in source_doc.pages().iter() {
        let img = render_page_with_color(&page, target_width, color_mode)?;

        // Dynamic paper size based on image aspect ratio
        let img_w = img.width() as f32;
        let img_h = img.height() as f32;
        let aspect_ratio = img_w / img_h;

        let paper_size = match paper_size_str {
            "Letter" => {
                let (base_w, base_h) = (8.5 * 72.0, 11.0 * 72.0);
                if aspect_ratio > 1.0 { PdfPagePaperSize::from_points(PdfPoints::new(base_h), PdfPoints::new(base_w)) }
                else { PdfPagePaperSize::from_points(PdfPoints::new(base_w), PdfPoints::new(base_h)) }
            },
            "Legal" => {
                let (base_w, base_h) = (8.5 * 72.0, 14.0 * 72.0);
                if aspect_ratio > 1.0 { PdfPagePaperSize::from_points(PdfPoints::new(base_h), PdfPoints::new(base_w)) }
                else { PdfPagePaperSize::from_points(PdfPoints::new(base_w), PdfPoints::new(base_h)) }
            },
            _ => {
                let (base_w, base_h) = (210.0 / 25.4 * 72.0, 297.0 / 25.4 * 72.0);
                if aspect_ratio > 1.0 { PdfPagePaperSize::from_points(PdfPoints::new(base_h), PdfPoints::new(base_w)) }
                else { PdfPagePaperSize::from_points(PdfPoints::new(base_w), PdfPoints::new(base_h)) }
            }
        };

        let mut new_page = final_doc.pages_mut().create_page_at_end(paper_size).map_err(|e| e.to_string())?;
        let page_w = new_page.width();
        let page_h = new_page.height();

        // Calculate fit
        let ratio_w = page_w.value / img_w;
        let ratio_h = page_h.value / img_h;
        let scale_factor = ratio_w.min(ratio_h);

        let final_w = img_w * scale_factor;
        let final_h = img_h * scale_factor;

        let offset_x = (page_w.value - final_w) / 2.0;
        let offset_y = (page_h.value - final_h) / 2.0;

        let mut image_obj = new_page.objects_mut().create_image_object(
            PdfPoints::new(0.0), PdfPoints::new(0.0), &img, None, None,
        ).map_err(|e| e.to_string())?;

        image_obj.scale(final_w, final_h).map_err(|e| e.to_string())?;
        image_obj.translate(PdfPoints::new(offset_x), PdfPoints::new(offset_y)).map_err(|e| e.to_string())?;

        new_page.regenerate_content().map_err(|e| e.to_string())?;
    }

    Ok(final_doc)
}

#[tauri::command]
async fn print_to_printer(
    state: tauri::State<'_, AppState>,
    settings: DirectPrintSettings,
) -> StdResult<String, String> {
    let _duplex_mode = settings.duplex.as_str();
    let v_pages = {
        let lock = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
        lock.clone()
    };
    if v_pages.is_empty() { return Err("No pages loaded".into()); }

    let total = v_pages.len();
    let indices = resolve_page_indices(&settings.scope, settings.current_page, &settings.custom_range, total);
    if indices.is_empty() { return Err("No selected pages".into()); }

    let mut docs = state.documents.lock().map_err(|_| "Docs lock fail")?;

    let new_doc = prepare_pages_for_print(
        &v_pages, &mut docs, &indices,
        settings.include_headers, &settings.header_left, &settings.header_center, &settings.header_right,
        settings.include_footer, &settings.footer_left, &settings.footer_center, &settings.footer_right,
    )?;

    // Handle Virtual Printer UX (Direct Save)
    if let Some(target_path) = settings.target_path {
        let needs_rasterize = settings.color_mode != "color";
        if needs_rasterize {
            let final_doc = rasterize_to_pdf(&new_doc, settings.quality_dpi, &settings.color_mode, &settings.paper_size)?;
            final_doc.save_to_file(&target_path).map_err(|e| e.to_string())?;
        } else {
            new_doc.save_to_file(&target_path).map_err(|e| e.to_string())?;
        }
        return Ok(format!("Saved to {}", target_path));
    }

    // Standard Physical Printer Flow
    let needs_rasterize = settings.color_mode != "color";
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let temp_pdf = std::env::temp_dir().join(format!("lumina_print_{}.pdf", timestamp));
    let temp_pdf_str = temp_pdf.to_string_lossy().to_string();

    if needs_rasterize {
        let final_doc = rasterize_to_pdf(&new_doc, settings.quality_dpi, &settings.color_mode, &settings.paper_size)?;
        final_doc.save_to_file(&temp_pdf_str).map_err(|e| e.to_string())?;
    } else {
        new_doc.save_to_file(&temp_pdf_str).map_err(|e| e.to_string())?;
    }

    let page_count = indices.len();
    let copies = settings.copies.max(1);

    #[cfg(target_os = "windows")]
    {
        // Use PowerShell Start-Process with /printto for each copy
        let script = if copies > 1 {
            format!(
                "for ($i = 0; $i -lt {}; $i++) {{ \
                    $p = Start-Process -FilePath '{}' -ArgumentList '/printto:\"{}\"' -PassThru -WindowStyle Hidden; \
                    $p.WaitForExit(30000); \
                    if (!$p.HasExited) {{ $p.Kill() }}; \
                    Start-Sleep -Milliseconds 500 \
                }}",
                copies, temp_pdf_str, settings.printer_name
            )
        } else {
            format!(
                "$p = Start-Process -FilePath '{}' -ArgumentList '/printto:\"{}\"' -PassThru -WindowStyle Hidden; \
                 $p.WaitForExit(30000); \
                 if (!$p.HasExited) {{ $p.Kill() }}",
                temp_pdf_str, settings.printer_name
            )
        };

        let print_result = std::process::Command::new("powershell")
            .args(&["-NoProfile", "-Command", &script])
            .creation_flags(0x08000000)
            .spawn();

        match print_result {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    let _ = std::fs::remove_file(&temp_pdf);
                });
            },
            Err(e) => return Err(format!("Print failed to start: {}", e)),
        }
    }

    Ok(format!("Printed {} pages ({} copies) to {}", page_count, copies, settings.printer_name))
}

#[tauri::command]
async fn generate_print_document(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: PrintSettings,
) -> StdResult<PreviewResult, String> {
    let _paper_size = settings.paper_size.as_str();
    let v_pages = {
        let lock = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
        lock.clone()
    };
    if v_pages.is_empty() { return Err("No pages loaded".into()); }

    let total = v_pages.len();
    let indices = resolve_page_indices(&settings.scope, settings.current_page, &settings.custom_range, total);
    if indices.is_empty() { return Err("No selected pages".into()); }

    let total_pages = indices.len();
    let target_idx = settings.requested_page_index.unwrap_or(0).min(total_pages.saturating_sub(1));

    let mut docs = state.documents.lock().map_err(|_| "Docs lock fail")?;

    // Only prepare the single page we need to render
    let single_index_slice = &[indices[target_idx]];
    let new_doc = prepare_pages_for_print(
        &v_pages, &mut docs, single_index_slice,
        settings.include_headers, &settings.header_left, &settings.header_center, &settings.header_right,
        settings.include_footer, &settings.footer_left, &settings.footer_center, &settings.footer_right,
    )?;

    // Preview: reflects quality setting to show dithering/detail changes
    let preview_width: u32 = match settings.quality_dpi {
        150 => 600,
        600 => 1600,
        _ => 1000, // 300 DPI
    };

    let page = new_doc.pages().first().map_err(|_| "No rendered page")?;
    let img = render_page_with_color(&page, preview_width, &settings.color_mode)?;

    let mut buffer = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Jpeg)
        .map_err(|e| format!("Enc fail: {}", e))?;

    let base64_str = base64::engine::general_purpose::STANDARD.encode(&buffer);
    let image = format!("data:image/jpeg;base64,{}", base64_str);

    Ok(PreviewResult { image, total_pages })
}


struct PdfiumWrapper(Pdfium);
unsafe impl Sync for PdfiumWrapper {}
unsafe impl Send for PdfiumWrapper {}

static PDFIUM_LIB: OnceLock<PdfiumWrapper> = OnceLock::new();

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct VirtualPage {
    source_path: String,
    original_index: u16,
    rotation: u16,
    custom_name: Option<String>,
}

struct AppState {
    documents: Mutex<HashMap<String, PdfDocument<'static>>>,
    virtual_pages: Mutex<Vec<VirtualPage>>,
    history: Mutex<Vec<Vec<VirtualPage>>>,
    render_cache: Mutex<HashMap<(u16, String), Vec<u8>>>,
    initial_file: Mutex<Option<String>>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

fn push_history(state: &AppState) -> StdResult<(), String> {
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let mut history = state.history.lock().map_err(|_| "Lock fail")?;
    history.push(v_pages.clone());
    if history.len() > 20 { history.remove(0); }
    Ok(())
}

#[derive(serde::Serialize)]
struct BookmarkNode {
    title: String,
    page_index: Option<u16>,
    children: Vec<BookmarkNode>,
}

#[derive(serde::Serialize)]
struct PageMetadata {
    width: f32,
    height: f32,
    rotation: u16,
    name: String,
    has_bookmark: bool,
}

#[derive(serde::Serialize)]
struct AnnotationData {
    page_index: u16,
    subtype: String,
    content: String,
    rect: [f32; 4],
    page_height: f32,
    uri: Option<String>,
    dest_page_index: Option<u16>,
}

#[derive(serde::Serialize)]
struct TextSpan {
    text: String,
    rect: [f32; 4],
}

#[derive(serde::Serialize)]
struct SearchResult {
    page_index: u16,
    text: String,
    rects: Vec<[f32; 4]>,
}

#[derive(serde::Serialize)]
struct ReorderResponse {
    metadata: Vec<PageMetadata>,
    final_index: usize,
}

fn map_bookmarks_to_names(item: PdfBookmark, map: &mut HashMap<u16, String>) {
    if let Some(idx) = item.destination().and_then(|d| d.page_index().ok()) {
        map.entry(idx).or_insert(item.title().unwrap_or_default());
    }
    let mut current_child = item.first_child();
    while let Some(child) = current_child {
        let next = child.next_sibling();
        map_bookmarks_to_names(child, map);
        current_child = next;
    }
}

#[tauri::command]
async fn pick_file() -> Option<String> {
    rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_file().map(|p| p.display().to_string())
}

#[tauri::command]
async fn get_startup_file(state: tauri::State<'_, AppState>) -> StdResult<Option<String>, String> {
    let file = state.initial_file.lock().map_err(|_| "Lock fail")?;
    Ok(file.clone())
}

#[tauri::command]
async fn pick_files() -> Vec<String> {
    rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_files().unwrap_or_default().into_iter().map(|p| p.display().to_string()).collect()
}

fn get_or_load_doc(path: &str, docs: &mut HashMap<String, PdfDocument<'static>>) -> StdResult<(), String> {
    if docs.contains_key(path) { return Ok(()); }
    let pdfium = &PDFIUM_LIB.get().ok_or("Pdfium not initialized")?.0;
    let doc = pdfium.load_pdf_from_file(path, None).map_err(|e| {
        let err_str = e.to_string();
        if err_str.contains("password") || err_str.contains("Password") {
            "PASSWORD_REQUIRED".to_string()
        } else {
            err_str
        }
    })?;
    docs.insert(path.to_string(), doc);
    Ok(())
}

fn get_metadata_internal(v_pages: &Vec<VirtualPage>, docs: &HashMap<String, PdfDocument<'static>>) -> StdResult<Vec<PageMetadata>, String> {
    let mut metadata = Vec::new();
    for (i, v_page) in v_pages.iter().enumerate() {
        let doc = docs.get(&v_page.source_path).ok_or("Source doc not loaded")?;
        let p = doc.pages().get(v_page.original_index).map_err(|_| "Page missing")?;
        let mut w = p.width().value;
        let mut h = p.height().value;
        if v_page.rotation == 90 || v_page.rotation == 270 { std::mem::swap(&mut w, &mut h); }
        let has_bookmark = v_page.custom_name.is_some();
        let display_name = v_page.custom_name.clone().unwrap_or_else(|| format!("Page {}", i + 1));
        metadata.push(PageMetadata { width: w, height: h, rotation: v_page.rotation, name: display_name, has_bookmark });
    }
    Ok(metadata)
}

#[tauri::command]
async fn load_document(state: tauri::State<'_, AppState>, path: String, password: Option<String>) -> StdResult<Vec<PageMetadata>, String> {
    // Lock Order: VirtualPages -> Documents -> RenderCache (Consistency Fix)
    let mut virtual_pages_guard = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let mut docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let mut cache = state.render_cache.lock().map_err(|e| e.to_string())?;

    docs.clear();

    // Load document with optional password
    let pdfium = &PDFIUM_LIB.get().ok_or("Pdfium not initialized")?.0;

    // We need to leak the password to 'static because PdfDocument lifetime is tied to it
    // and we store PdfDocument<'static> in the AppState.
    let password_static: Option<&'static str> = password.as_ref().map(|p| {
        Box::leak(p.clone().into_boxed_str()) as &'static str
    });

    let doc = pdfium.load_pdf_from_file(&path, password_static).map_err(|e| {
        let err_str = e.to_string();
        if err_str.contains("password") || err_str.contains("Password") {
            if password.is_none() {
                "PASSWORD_REQUIRED".to_string()
            } else {
                "PASSWORD_INCORRECT".to_string()
            }
        } else {
            err_str
        }
    })?;
    docs.insert(path.clone(), doc);

    let doc = docs.get(&path).ok_or("Doc missing")?;

    let mut name_map = HashMap::new();
    for item in doc.bookmarks().iter() { map_bookmarks_to_names(item, &mut name_map); }

    let mut v_pages = Vec::new();
    for (i, _) in doc.pages().iter().enumerate() {
        v_pages.push(VirtualPage { source_path: path.clone(), original_index: i as u16, rotation: 0, custom_name: name_map.get(&(i as u16)).cloned() });
    }

    cache.clear();
    *virtual_pages_guard = v_pages;
    get_metadata_internal(&virtual_pages_guard, &docs)
}

#[tauri::command]
async fn import_pages(state: tauri::State<'_, AppState>, paths: Vec<String>, insert_at: usize, delete_indices: Vec<usize>) -> StdResult<Vec<PageMetadata>, String> {
    push_history(&state)?;

    // Lock Order: VirtualPages -> Documents -> RenderCache
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let mut docs = state.documents.lock().map_err(|_| "Lock fail")?;

    let mut new_v_pages = Vec::new();
    for path in paths {
        get_or_load_doc(&path, &mut docs)?;
        let doc = docs.get(&path).ok_or("Doc missing")?;
        let mut name_map = HashMap::new();
        for item in doc.bookmarks().iter() { map_bookmarks_to_names(item, &mut name_map); }
        for i in 0..doc.pages().len() {
            new_v_pages.push(VirtualPage { source_path: path.clone(), original_index: i as u16, rotation: 0, custom_name: name_map.get(&(i as u16)).cloned() });
        }
    }

    // 1. Perform deletions first
    // Sort indices descending to avoid shifting problems
    let mut sorted_deletes = delete_indices.clone();
    sorted_deletes.sort_unstable_by(|a, b| b.cmp(a));

    // Track how many pages BEFORE 'insert_at' are deleted to adjust insertion point
    let mut insertion_adjustment = 0;
    for &idx in &sorted_deletes {
        if idx < v_pages.len() {
            v_pages.remove(idx);
            if idx < insert_at {
                insertion_adjustment += 1;
            }
        }
    }

    // 2. Insert new pages
    // Adjust insert_at based on deletions that happened before it
    let final_insert_pos = (insert_at.saturating_sub(insertion_adjustment)).min(v_pages.len());

    for (i, page) in new_v_pages.into_iter().enumerate() {
        v_pages.insert(final_insert_pos + i, page);
    }

    let mut cache = state.render_cache.lock().map_err(|e| e.to_string())?;
    cache.clear();

    get_metadata_internal(&v_pages, &docs)
}

fn fast_render_to_bmp(page: &PdfPage, scale: f32, rotation: u16) -> StdResult<Vec<u8>, String> {
    let mut width_pts = page.width().value;
    let mut height_pts = page.height().value;
    if rotation == 90 || rotation == 270 { std::mem::swap(&mut width_pts, &mut height_pts); }
    let target_width = (width_pts * scale) as u32;
    let target_height = (height_pts * scale) as u32;
    let is_rotated = rotation == 90 || rotation == 270;
    let supersample_factor = if is_rotated { 2.0 } else { 1.0 };
    let render_width = (target_width as f32 * supersample_factor) as i32;
    let render_height = (target_height as f32 * supersample_factor) as i32;
    let render_rotation = match rotation { 90 => PdfPageRenderRotation::Degrees90, 180 => PdfPageRenderRotation::Degrees180, 270 => PdfPageRenderRotation::Degrees270, _ => PdfPageRenderRotation::None };
    let config = PdfRenderConfig::new().set_target_width(render_width).set_target_height(render_height).rotate(render_rotation, true).render_form_data(true).render_annotations(true).use_lcd_text_rendering(!is_rotated);
    let bitmap = page.render_with_config(&config).map_err(|_| "Render failed")?;
    let src_width = bitmap.width() as u32;
    let src_height = bitmap.height() as u32;
    let raw_bytes = bitmap.as_raw_bytes();
    let mut rgb_pixels = Vec::with_capacity((src_width * src_height * 3) as usize);
    for chunk in raw_bytes.chunks_exact(4) { rgb_pixels.push(chunk[0]); rgb_pixels.push(chunk[1]); rgb_pixels.push(chunk[2]); }
    let img_buffer = image::ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(src_width, src_height, rgb_pixels).ok_or("Failed to create image buffer")?;
    let mut jpeg_buffer = Cursor::new(Vec::new());
    if is_rotated { image::imageops::resize(&img_buffer, target_width, target_height, FilterType::Lanczos3).write_to(&mut jpeg_buffer, ImageFormat::Jpeg).map_err(|e| e.to_string())?; }
    else { img_buffer.write_to(&mut jpeg_buffer, ImageFormat::Jpeg).map_err(|e| e.to_string())?; }
    Ok(jpeg_buffer.into_inner())
}

#[tauri::command]
async fn rotate_pages(state: tauri::State<'_, AppState>, indices: Vec<usize>) -> StdResult<Vec<PageMetadata>, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    for &index in &indices { if let Some(page) = v_pages.get_mut(index) { page.rotation = (page.rotation + 90) % 360; } }
    let mut cache = state.render_cache.lock().map_err(|_| "Cache lock fail")?;
    for &index in &indices { cache.retain(|(idx, _), _| *idx != index as u16); }
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn delete_pages(state: tauri::State<'_, AppState>, mut indices: Vec<usize>) -> StdResult<Vec<PageMetadata>, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    indices.sort_unstable_by(|a, b| b.cmp(a));
    for index in indices { if index < v_pages.len() { v_pages.remove(index); } }
    let mut cache = state.render_cache.lock().map_err(|_| "Cache lock fail")?; cache.clear();
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn reorder_pages(state: tauri::State<'_, AppState>, indices: Vec<usize>, from: usize, to: usize) -> StdResult<ReorderResponse, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    if indices.is_empty() { let meta = get_metadata_internal(&v_pages, &docs)?; return Ok(ReorderResponse { metadata: meta, final_index: to }); }
    let safe_to = to.min(v_pages.len() - 1);
    let target_id = (v_pages[safe_to].source_path.clone(), v_pages[safe_to].original_index);
    let mut moving_items = Vec::new();
    let mut sorted_indices = indices.clone(); sorted_indices.sort_unstable();
    for &idx in &sorted_indices { if let Some(item) = v_pages.get(idx) { moving_items.push(item.clone()); } }
    let mut remove_indices = sorted_indices; remove_indices.reverse();
    for idx in remove_indices { if idx < v_pages.len() { v_pages.remove(idx); } }
    let mut insertion_point = v_pages.iter().position(|p| p.source_path == target_id.0 && p.original_index == target_id.1).unwrap_or(v_pages.len());
    if to > from { insertion_point += 1; }
    for (i, item) in moving_items.into_iter().enumerate() { v_pages.insert(insertion_point + i, item); }
    let mut cache = state.render_cache.lock().map_err(|_| "Cache lock fail")?; cache.clear();
    let meta = get_metadata_internal(&v_pages, &docs)?;
    Ok(ReorderResponse { metadata: meta, final_index: insertion_point })
}

#[tauri::command]
async fn undo(state: tauri::State<'_, AppState>) -> StdResult<Vec<PageMetadata>, String> {
    let mut history = state.history.lock().map_err(|_| "Lock fail")?;
    if let Some(prev_state) = history.pop() {
        let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?; *v_pages = prev_state;
        let mut cache = state.render_cache.lock().map_err(|_| "Cache lock fail")?; cache.clear();
        let docs = state.documents.lock().map_err(|_| "Lock fail")?;
        return get_metadata_internal(&v_pages, &docs);
    }
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn rename_page(state: tauri::State<'_, AppState>, index: usize, name: String) -> StdResult<Vec<PageMetadata>, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    if let Some(page) = v_pages.get_mut(index) { page.custom_name = Some(name); }
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn pick_save_path() -> Option<String> { rfd::FileDialog::new().add_filter("PDF", &["pdf"]).save_file().map(|p| p.display().to_string()) }

fn perform_save(v_pages: &Vec<VirtualPage>, docs: &HashMap<String, PdfDocument<'static>>, path: String) -> StdResult<(), String> {
    let pdfium = &PDFIUM_LIB.get().ok_or("Pdfium not initialized")?.0;
    let mut new_doc = pdfium.create_new_pdf().map_err(|e| e.to_string())?;

    for v_page in v_pages.iter() {
        let source_doc = docs.get(&v_page.source_path).ok_or("Source doc missing")?;
        let dest_idx = new_doc.pages().len();
        new_doc.pages_mut().copy_page_from_document(source_doc, v_page.original_index, dest_idx).map_err(|e| e.to_string())?;
        let last_idx = new_doc.pages().len() - 1;
        let mut new_page = new_doc.pages_mut().get(last_idx).map_err(|_| "New page missing")?;
        let current_rot = new_page.rotation().map_err(|_| "Get rot fail")?;
        let final_rot_deg = (current_rot.as_degrees() as u16 + v_page.rotation) % 360;
        let new_rot_enum = match final_rot_deg { 90 => PdfPageRenderRotation::Degrees90, 180 => PdfPageRenderRotation::Degrees180, 270 => PdfPageRenderRotation::Degrees270, _ => PdfPageRenderRotation::None };
        new_page.set_rotation(new_rot_enum);
    }

    // Collect bookmarks from custom_name (only pages with actual bookmarks)
    let bookmarks_to_save: Vec<(String, usize)> = v_pages.iter().enumerate()
        .filter_map(|(new_idx, v_page)| {
            v_page.custom_name.as_ref().map(|name| (name.clone(), new_idx))
        })
        .collect();

    // Save with pdfium first
    new_doc.save_to_file(&path).map_err(|e| e.to_string())?;

    // If there are bookmarks, add them using lopdf
    if !bookmarks_to_save.is_empty() {
        let _ = add_bookmarks_with_lopdf_simple(&path, &bookmarks_to_save);
    }

    Ok(())
}

// Simplified version that takes flat list of (title, page_index)
fn add_bookmarks_with_lopdf_simple(
    path: &str,
    bookmarks: &[(String, usize)]
) -> StdResult<(), String> {
    let mut doc = LopdfDocument::load(path).map_err(|e| format!("lopdf load: {}", e))?;
    let page_ids: Vec<_> = doc.page_iter().collect();

    if page_ids.is_empty() || bookmarks.is_empty() {
        return Ok(());
    }

    for (title, page_idx) in bookmarks {
        if let Some(&page_id) = page_ids.get(*page_idx) {
            let bookmark = LopdfBookmark::new(title.clone(), [0.0, 0.0, 0.0], 0, page_id);
            doc.add_bookmark(bookmark, None);
        }
    }

    if let Some(outline_id) = doc.build_outline() {
        if let Ok(catalog) = doc.catalog_mut() {
            catalog.set("Outlines", lopdf::Object::Reference(outline_id));
        }
    }

    doc.save(path).map_err(|e| format!("lopdf save: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn save_document(state: tauri::State<'_, AppState>, path: String, indices: Option<Vec<usize>>) -> StdResult<(), String> {
    let v_pages_full = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let target_v_pages: Vec<VirtualPage> = if let Some(idx_list) = indices {
        idx_list.iter().filter_map(|&i| v_pages_full.get(i).cloned()).collect()
    } else {
        v_pages_full.clone()
    };
    perform_save(&target_v_pages, &docs, path)
}

#[tauri::command]
async fn export_individual_pages(state: tauri::State<'_, AppState>, base_path: String, indices: Vec<usize>) -> StdResult<(), String> {
    let v_pages_full = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    for &index in &indices {
        let v_page = v_pages_full.get(index).ok_or("Index out of bounds")?;
        let page_path = if indices.len() > 1 { format!("{}_page_{}.pdf", base_path.trim_end_matches(".pdf"), index + 1) } else { base_path.clone() };
        perform_save(&vec![v_page.clone()], &docs, page_path)?;
    }
    Ok(())
}

fn traverse_bookmarks(item: PdfBookmark, source_path: &str, mapping: &HashMap<(String, u16), u16>) -> BookmarkNode {
    let title = item.title().unwrap_or_default();
    let original_index = item.destination().and_then(|d| d.page_index().ok());
    let page_index = original_index.and_then(|idx| mapping.get(&(source_path.to_string(), idx)).copied());
    let mut children = Vec::new();
    let mut current_child = item.first_child();
    while let Some(child) = current_child {
        let next = child.next_sibling();
        children.push(traverse_bookmarks(child, source_path, mapping));
        current_child = next;
    }
    BookmarkNode { title, page_index, children }
}

#[tauri::command]
async fn get_bookmarks(state: tauri::State<'_, AppState>) -> StdResult<Vec<BookmarkNode>, String> {
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let mut mapping = HashMap::new();
    for (i, v) in v_pages.iter().enumerate() { mapping.insert((v.source_path.clone(), v.original_index), i as u16); }
    let mut all_roots = Vec::new();
    for (path, doc) in docs.iter() {
        for item in doc.bookmarks().iter() { all_roots.push(traverse_bookmarks(item, path, &mapping)); }
    }
    Ok(all_roots)
}

#[tauri::command]
async fn get_all_annotations(state: tauri::State<'_, AppState>) -> StdResult<Vec<AnnotationData>, String> {
    use pdfium_render::prelude::*;

    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let mut list = Vec::new();

    for (v_idx, v_page) in v_pages.iter().enumerate() {
        if let Some(doc) = docs.get(&v_page.source_path) {
            if let Ok(page) = doc.pages().get(v_page.original_index) {
                let p_height = page.height().value;
                let p_width = page.width().value;

                // First, collect all Link annotations with their bounds
                let mut link_annotations = Vec::new();
                for annot in page.annotations().iter() {
                    let subtype = format!("{:?}", annot.annotation_type());

                    if annot.annotation_type() == PdfPageAnnotationType::Link {
                        let bounds = annot.bounds().unwrap_or(PdfRect::new(PdfPoints::new(0.0), PdfPoints::new(0.0), PdfPoints::new(0.0), PdfPoints::new(0.0)));
                        // Normalize to percentages
                        let rect = [
                            bounds.left().value / p_width,
                            (p_height - bounds.top().value) / p_height,
                            bounds.width().value / p_width,
                            bounds.height().value / p_height
                        ];
                        link_annotations.push(rect);
                    } else {
                        // Process non-link annotations normally
                        let content = annot.contents().unwrap_or_default();
                        let bounds = annot.bounds().unwrap_or(PdfRect::new(PdfPoints::new(0.0), PdfPoints::new(0.0), PdfPoints::new(0.0), PdfPoints::new(0.0)));
                        let rect = [bounds.left().value, bounds.bottom().value, bounds.right().value, bounds.top().value];

                        if !content.is_empty() || subtype.contains("Text") || subtype.contains("Highlight") {
                            list.push(AnnotationData {
                                page_index: v_idx as u16,
                                subtype,
                                content,
                                rect,
                                page_height: p_height,
                                uri: None,
                                dest_page_index: None
                            });
                        }
                    }
                }

                // Now process links and match by index
                for (link_idx, link) in page.links().iter().enumerate() {
                    let mut uri: Option<String> = None;
                    let mut dest_page_index: Option<u16> = None;

                    // Extract link action (URI or local destination)
                    if let Some(action) = link.action() {
                        // Check for URI action (external link)
                        if let Some(uri_action) = action.as_uri_action() {
                            uri = uri_action.uri().ok();
                        }
                        // Check for local destination action (internal link)
                        else if let Some(local_dest) = action.as_local_destination_action() {
                            if let Ok(destination) = local_dest.destination() {
                                if let Ok(original_page_idx) = destination.page_index() {
                                    // Map original page index to virtual page index
                                    if let Some(virtual_idx) = v_pages.iter().position(|vp|
                                        vp.source_path == v_page.source_path && vp.original_index == original_page_idx
                                    ) {
                                        dest_page_index = Some(virtual_idx as u16);
                                    }
                                }
                            }
                        }
                    }

                    // Get rect from matching annotation (assume same index)
                    let rect = link_annotations.get(link_idx).copied().unwrap_or([0.0, 0.0, 0.0, 0.0]);

                    // Add link as annotation data
                    list.push(AnnotationData {
                        page_index: v_idx as u16,
                        subtype: "Link".to_string(),
                        content: String::new(),
                        rect,
                        page_height: p_height,
                        uri,
                        dest_page_index
                    });
                }
            }
        }
    }
    list.sort_by_key(|a| a.page_index);
    Ok(list)
}

#[tauri::command]
async fn search_document(state: tauri::State<'_, AppState>, query: String) -> StdResult<Vec<serde_json::Value>, String> {
    if query.trim().is_empty() { return Ok(Vec::new()); }
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let mut all_results = Vec::new();
    for (v_idx, v_page) in v_pages.iter().enumerate() {
        if let Some(doc) = docs.get(&v_page.source_path) {
            if let Ok(page) = doc.pages().get(v_page.original_index) {
                if let Ok(page_text) = page.text() {
                    let options = PdfSearchOptions::default();
                    if let Ok(search) = page_text.search(&query, &options) {
                        for occurrence in search.iter(PdfSearchDirection::SearchForward) {
                            let mut rects = Vec::new();
                            let mut text = String::new();
                            for segment in occurrence.iter() {
                                let bounds = segment.bounds();
                                rects.push([bounds.left().value, bounds.bottom().value, bounds.right().value, bounds.top().value]);
                                text.push_str(&segment.text());
                            }
                            all_results.push(serde_json::json!({ "page_index": v_idx as u16, "text": text, "rects": rects }));
                        }
                    }
                }
            }
        }
    }
    Ok(all_results)
}

#[tauri::command]
async fn get_page_text(state: tauri::State<'_, AppState>, index: usize) -> StdResult<Vec<serde_json::Value>, String> {
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let v_page = v_pages.get(index).ok_or("Invalid index")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let doc = docs.get(&v_page.source_path).ok_or("Doc not loaded")?;
    let page = doc.pages().get(v_page.original_index).map_err(|_| "Page missing")?;
    let mut spans = Vec::new();
    if let Ok(page_text) = page.text() {
        for segment in page_text.segments().iter() {
            let bounds = segment.bounds();
            spans.push(serde_json::json!({ "text": segment.text(), "rect": [bounds.left().value, bounds.bottom().value, bounds.right().value, bounds.top().value] }));
        }
    }
    Ok(spans)
}

#[tauri::command]
fn log_error(msg: String) { println!("Frontend Error: {}", msg); }

#[derive(serde::Deserialize)]
struct ExportSettings {
    scope: String,
    custom_range: String,
    format: String,
    path: String,
    current_page_index: usize,
}

#[tauri::command]
async fn pick_save_path_image(format: String) -> StdResult<Option<String>, String> {
    let ext = match format.as_str() {
        "jpg" => "jpg",
        "webp" => "webp",
        _ => "png"
    };

    let result = rfd::FileDialog::new()
        .add_filter("Image", &[ext])
        .set_file_name(&format!("page.{}", ext))
        .save_file();

    match result {
        Some(path) => {
            let path_str = path.display().to_string();
            // Use PathBuf to check extension properly
            let p = std::path::PathBuf::from(&path_str);
            if p.extension().is_none() {
                Ok(Some(format!("{}.{}", path_str, ext)))
            } else {
                Ok(Some(path_str))
            }
        }
        None => Ok(None)
    }
}

fn parse_range_string(range_str: &str, total_pages: usize) -> Vec<usize> {
    let mut indices = Vec::new();
    for part in range_str.split(',') {
        let part = part.trim();
        if part.contains('-') {
            let bounds: Vec<&str> = part.split('-').collect();
            if bounds.len() == 2 {
                if let (Ok(start), Ok(end)) = (bounds[0].trim().parse::<usize>(), bounds[1].trim().parse::<usize>()) {
                    for i in start..=end {
                        if i > 0 && i <= total_pages { indices.push(i - 1); }
                    }
                }
            }
        } else {
            if let Ok(idx) = part.parse::<usize>() {
                if idx > 0 && idx <= total_pages { indices.push(idx - 1); }
            }
        }
    }
    indices
}

#[tauri::command]
async fn export_images(state: tauri::State<'_, AppState>, settings: ExportSettings) -> StdResult<(), String> {
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;

    let target_indices = match settings.scope.as_str() {
        "current" => vec![settings.current_page_index],
        "all" => (0..v_pages.len()).collect(),
        "custom" => parse_range_string(&settings.custom_range, v_pages.len()),
        _ => vec![settings.current_page_index],
    };

    if target_indices.is_empty() {
        return Err("No pages selected".to_string());
    }

    let base_path = std::path::Path::new(&settings.path);
    let file_stem = base_path.file_stem().and_then(|s| s.to_str()).unwrap_or("page");
    let parent_dir = base_path.parent().unwrap_or(std::path::Path::new("."));
    let ext = settings.format.as_str();

    // Determine saving format
    let img_format = match ext {
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        _ => image::ImageFormat::Png,
    };

    for &idx in &target_indices {
        if idx >= v_pages.len() { continue; }
        let v_page = &v_pages[idx];

        // Render
        let doc = docs.get(&v_page.source_path).ok_or("Doc not loaded")?;
        let page = doc.pages().get(v_page.original_index).map_err(|_| "Page missing")?;
        let buffer = fast_render_to_bmp(&page, 3.0, v_page.rotation)?; // High quality
        let img = image::load_from_memory(&buffer).map_err(|e| e.to_string())?;

        // Construct filename:
        // If single page -> use exact path
        // If multiple -> append _page_X
        let save_path = if target_indices.len() == 1 {
            std::path::PathBuf::from(&settings.path)
        } else {
            parent_dir.join(format!("{}_{}.{}", file_stem, idx + 1, ext))
        };

        match ext {
            "jpg" | "jpeg" => {
                let rgb_img = img.to_rgb8();
                rgb_img.save_with_format(&save_path, img_format).map_err(|e| e.to_string())?;
            }
            _ => {
                img.save_with_format(&save_path, img_format).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn save_page_as_image(state: tauri::State<'_, AppState>, page_index: usize, path: String) -> StdResult<(), String> {
    let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let v_page = v_pages.get(page_index).ok_or("Invalid index")?;

    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let doc = docs.get(&v_page.source_path).ok_or("Doc not loaded")?;
    let page = doc.pages().get(v_page.original_index).map_err(|_| "Page missing")?;

    // Render at high quality (scale 3.0)
    let buffer = fast_render_to_bmp(&page, 3.0, v_page.rotation)?;

    // Convert jpeg buffer back to image object to save as requested format
    let img = image::load_from_memory(&buffer).map_err(|e| e.to_string())?;

    // Determine format from extension
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" => {
            let rgb_img = img.to_rgb8();
            rgb_img.save_with_format(&path, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        }
        "webp" => {
            img.save_with_format(&path, image::ImageFormat::WebP).map_err(|e| e.to_string())?;
        }
        _ => {
            img.save_with_format(&path, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn read_pdf_file(path: String) -> StdResult<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}



#[tauri::command]
async fn print_document(state: tauri::State<'_, AppState>) -> StdResult<(), String> {
    // 1. Generate unique temp file path to avoid collisions
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let filename = format!("lumina_print_{}.pdf", timestamp);
    let temp_path = std::env::temp_dir().join(filename);
    let temp_path_str = temp_path.to_string_lossy().to_string();

    // 2. Save the current document state to this temp PDF
    {
        let v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
        let docs = state.documents.lock().map_err(|_| "Lock fail")?;
        perform_save(&v_pages, &docs, temp_path_str.clone())?;
    }

    #[cfg(target_os = "windows")]
    {
        // Log for debugging
        println!("Print: Saved temp PDF to: {}", temp_path_str);

        // Simplest and most reliable approach: just open the PDF
        // User can then use Ctrl+P in their PDF viewer to print
        // This avoids all the Print verb association issues
        let open_result = std::process::Command::new("cmd")
            .args(&["/C", "start", "", &temp_path_str])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn();

        if let Err(e) = open_result {
            return Err(format!("Failed to open PDF for printing: {}", e));
        }

        println!("Print: Successfully opened PDF in default viewer");
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("Printing is only supported on Windows currently".to_string());
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState { documents: Mutex::new(HashMap::new()), virtual_pages: Mutex::new(Vec::new()), history: Mutex::new(Vec::new()), render_cache: Mutex::new(HashMap::new()), initial_file: Mutex::new(None) })
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            if args.len() > 1 {
                let path_arg = args[1].clone();
                if std::path::Path::new(&path_arg).exists() {
                    let state = app.state::<AppState>();
                    *state.initial_file.lock().unwrap() = Some(path_arg);
                }
            }

            let resource_path = app.path().resource_dir().unwrap_or_default().join("pdfium.dll");
            let pdfium = match Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./")) {
                Ok(lib) => Pdfium::new(lib),
                Err(_) => match Pdfium::bind_to_library(resource_path.to_str().unwrap_or("")) {
                    Ok(lib) => Pdfium::new(lib),
                    Err(_) => Pdfium::new(Pdfium::bind_to_system_library().expect("pdfium.dll missing"))
                }
            };
            let _ = PDFIUM_LIB.set(PdfiumWrapper(pdfium));
            Ok(())
        })
        .register_uri_scheme_protocol("pdf-page", |ctx, request| {
            let res: StdResult<tauri::http::Response<Vec<u8>>, Box<dyn std::error::Error>> = (|| {
                let url = Url::parse(&request.uri().to_string())?;
                let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
                let virtual_index: usize = pairs.get("page").and_then(|v| v.parse().ok()).unwrap_or(0);
                let scale: f32 = pairs.get("scale").and_then(|v| v.parse().ok()).unwrap_or(1.0);
                let dpr: f32 = pairs.get("dpr").and_then(|v| v.parse().ok()).unwrap_or(1.0);
                let effective_scale = scale * dpr;
                let state = ctx.app_handle().state::<AppState>();
                let (source_path, original_index, rotation) = {
                    let v_pages = state.virtual_pages.lock().map_err(|_| "VPage lock fail")?;
                    let info = v_pages.get(virtual_index).ok_or("Out of bounds")?;
                    (info.source_path.clone(), info.original_index, info.rotation)
                };
                {
                    let cache = state.render_cache.lock().map_err(|_| "Cache fail")?;
                    if let Some(data) = cache.get(&(virtual_index as u16, format!("{:.4}", effective_scale))) {
                        return Ok(tauri::http::Response::builder().header("Content-Type", "image/jpeg").header("Cache-Control", "public, max-age=3600").body(data.clone())?);
                    }
                }
                let buffer = {
                    let mut docs = state.documents.lock().map_err(|_| "Docs lock fail")?;
                    get_or_load_doc(&source_path, &mut docs)?;
                    let doc = docs.get(&source_path).ok_or("Doc missing")?;
                    let page = doc.pages().get(original_index).map_err(|_| "Page missing")?;
                    fast_render_to_bmp(&page, effective_scale, rotation)?
                };
                { let mut cache = state.render_cache.lock().map_err(|_| "Cache fail")?; cache.insert((virtual_index as u16, format!("{:.4}", effective_scale)), buffer.clone()); }
                Ok(tauri::http::Response::builder().header("Content-Type", "image/jpeg").header("Cache-Control", "public, max-age=3600").body(buffer)?)
            })();
            match res { Ok(response) => response, Err(e) => tauri::http::Response::builder().status(500).body(e.to_string().into_bytes()).unwrap_or_else(|_| tauri::http::Response::new(Vec::new())) }
        })
        .invoke_handler(tauri::generate_handler![ pick_file, pick_files, load_document, import_pages, log_error, rotate_pages, delete_pages, reorder_pages, undo, pick_save_path, save_document, get_page_text, search_document, rename_page, export_individual_pages, get_bookmarks, get_all_annotations, get_startup_file, save_page_as_image, export_images, print_document, pick_save_path_image, read_pdf_file, generate_print_document, list_printers, print_to_printer ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn init_pdfium() -> Pdfium {
        // Try local directory first, then build dir, then system
        let local_path = "pdfium.dll";
        if std::path::Path::new(local_path).exists() {
             return Pdfium::new(Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./")).unwrap());
        }

        // Fallback for test environment where working dir might vary
        let pdfium = Pdfium::new(
            Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
            .or_else(|_| Pdfium::bind_to_library("pdfium.dll"))
            .expect("Could not bind to pdfium.dll for tests. Make sure it is in the src-tauri folder.")
        );
        pdfium
    }

    #[test]
    fn test_multi_doc_copy_logic() {
        let pdfium = init_pdfium();

        // 1. Create Source Doc A
        let mut doc_a = pdfium.create_new_pdf().unwrap();
        let _ = doc_a.pages_mut().create_page_at_end(PdfPagePaperSize::a4()).unwrap();

        // 2. Create Source Doc B
        let mut doc_b = pdfium.create_new_pdf().unwrap();
        let _ = doc_b.pages_mut().create_page_at_end(PdfPagePaperSize::a4()).unwrap();

        // 3. Create Dest Doc
        let mut doc_dest = pdfium.create_new_pdf().unwrap();

        // 4. Copy Page 0 from A to Dest
        // Note: Pdfium's copy_page_from_document takes the Source Document
        doc_dest.pages_mut().copy_page_from_document(&doc_a, 0, 0).expect("Failed to copy from Doc A");

        // 5. Copy Page 0 from B to Dest
        doc_dest.pages_mut().copy_page_from_document(&doc_b, 0, 1).expect("Failed to copy from Doc B");

        assert_eq!(doc_dest.pages().len(), 2);
    }
}
