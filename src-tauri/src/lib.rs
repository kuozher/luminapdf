use tauri::Manager;
use pdfium_render::prelude::*;
use std::sync::{Mutex, OnceLock};
use std::collections::HashMap;
use std::io::Cursor;
use image::ImageFormat;
use image::imageops::FilterType;
use url::Url;
use lopdf::{Document as LopdfDocument, Bookmark as LopdfBookmark};

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

fn push_history(state: &AppState) -> Result<(), String> {
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
async fn get_startup_file(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let file = state.initial_file.lock().map_err(|_| "Lock fail")?;
    Ok(file.clone())
}

#[tauri::command]
async fn pick_files() -> Vec<String> {
    rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_files().unwrap_or_default().into_iter().map(|p| p.display().to_string()).collect()
}

fn get_or_load_doc(path: &str, docs: &mut HashMap<String, PdfDocument<'static>>) -> Result<(), String> {
    if docs.contains_key(path) { return Ok(()); }
    let pdfium = &PDFIUM_LIB.get().ok_or("Pdfium not initialized")?.0;
    let doc = pdfium.load_pdf_from_file(path, None).map_err(|e| e.to_string())?;
    docs.insert(path.to_string(), doc);
    Ok(())
}

fn get_metadata_internal(v_pages: &Vec<VirtualPage>, docs: &HashMap<String, PdfDocument<'static>>) -> Result<Vec<PageMetadata>, String> {
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
async fn load_document(state: tauri::State<'_, AppState>, path: String) -> Result<Vec<PageMetadata>, String> {
    // Lock Order: VirtualPages -> Documents -> RenderCache (Consistency Fix)
    let mut virtual_pages_guard = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    let mut docs = state.documents.lock().map_err(|_| "Lock fail")?;
    let mut cache = state.render_cache.lock().map_err(|e| e.to_string())?;

    docs.clear();
    get_or_load_doc(&path, &mut docs)?;
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
async fn import_pages(state: tauri::State<'_, AppState>, paths: Vec<String>, insert_at: usize, delete_indices: Vec<usize>) -> Result<Vec<PageMetadata>, String> {
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

fn fast_render_to_bmp(page: &PdfPage, scale: f32, rotation: u16) -> Result<Vec<u8>, String> {
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
async fn rotate_pages(state: tauri::State<'_, AppState>, indices: Vec<usize>) -> Result<Vec<PageMetadata>, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    for &index in &indices { if let Some(page) = v_pages.get_mut(index) { page.rotation = (page.rotation + 90) % 360; } }
    let mut cache = state.render_cache.lock().map_err(|_| "Cache lock fail")?;
    for &index in &indices { cache.retain(|(idx, _), _| *idx != index as u16); }
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn delete_pages(state: tauri::State<'_, AppState>, mut indices: Vec<usize>) -> Result<Vec<PageMetadata>, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    indices.sort_unstable_by(|a, b| b.cmp(a));
    for index in indices { if index < v_pages.len() { v_pages.remove(index); } }
    let mut cache = state.render_cache.lock().map_err(|_| "Cache lock fail")?; cache.clear();
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn reorder_pages(state: tauri::State<'_, AppState>, indices: Vec<usize>, from: usize, to: usize) -> Result<ReorderResponse, String> {
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
async fn undo(state: tauri::State<'_, AppState>) -> Result<Vec<PageMetadata>, String> {
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
async fn rename_page(state: tauri::State<'_, AppState>, index: usize, name: String) -> Result<Vec<PageMetadata>, String> {
    push_history(&state)?;
    let mut v_pages = state.virtual_pages.lock().map_err(|_| "Lock fail")?;
    if let Some(page) = v_pages.get_mut(index) { page.custom_name = Some(name); }
    let docs = state.documents.lock().map_err(|_| "Lock fail")?;
    get_metadata_internal(&v_pages, &docs)
}

#[tauri::command]
async fn pick_save_path() -> Option<String> { rfd::FileDialog::new().add_filter("PDF", &["pdf"]).save_file().map(|p| p.display().to_string()) }

fn perform_save(v_pages: &Vec<VirtualPage>, docs: &HashMap<String, PdfDocument<'static>>, path: String) -> Result<(), String> {
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
) -> Result<(), String> {
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
async fn save_document(state: tauri::State<'_, AppState>, path: String, indices: Option<Vec<usize>>) -> Result<(), String> {
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
async fn export_individual_pages(state: tauri::State<'_, AppState>, base_path: String, indices: Vec<usize>) -> Result<(), String> {
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
async fn get_bookmarks(state: tauri::State<'_, AppState>) -> Result<Vec<BookmarkNode>, String> {
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
async fn get_all_annotations(state: tauri::State<'_, AppState>) -> Result<Vec<AnnotationData>, String> {
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
async fn search_document(state: tauri::State<'_, AppState>, query: String) -> Result<Vec<serde_json::Value>, String> {
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
async fn get_page_text(state: tauri::State<'_, AppState>, index: usize) -> Result<Vec<serde_json::Value>, String> {
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
            let res: Result<tauri::http::Response<Vec<u8>>, Box<dyn std::error::Error>> = (|| {
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
        .invoke_handler(tauri::generate_handler![ pick_file, pick_files, load_document, import_pages, log_error, rotate_pages, delete_pages, reorder_pages, undo, pick_save_path, save_document, get_page_text, search_document, rename_page, export_individual_pages, get_bookmarks, get_all_annotations, get_startup_file ])
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