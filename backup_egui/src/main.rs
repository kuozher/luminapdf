use eframe::egui;
use crossbeam_channel::{unbounded, Receiver, Sender};
use pdfium_render::prelude::*;
use std::thread;

// --- Messages ---
#[derive(Debug)]
enum RenderCommand {
    LoadDocument(String),
    RenderPage { page_index: u16, _width: u16, _height: u16, scale: f32 },
}

#[derive(Debug)]
enum RenderResult {
    DocumentLoaded { page_count: u16 },
    PageRendered { page_index: u16, image_data: Vec<u8>, width: u32, height: u32 },
    Error(String),
}

// --- App State ---
struct EasyPdfApp {
    tx: Sender<RenderCommand>,
    rx: Receiver<RenderResult>,
    
    // State
    current_file: Option<String>,
    current_page: u16,
    total_pages: u16,
    scale: f32,
    
    // View
    page_texture: Option<egui::TextureHandle>,
    is_loading: bool,
    error_msg: Option<String>,
}

impl EasyPdfApp {
    fn new(_cc: &eframe::CreationContext) -> Self {
        let (tx_cmd, rx_cmd) = unbounded();
        let (tx_res, rx_res) = unbounded();

        // Background Render Thread
        thread::spawn(move || {
            // Bind to local DLL or system library
            let pdfium = match Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./")) {
                Ok(lib) => Pdfium::new(lib),
                Err(_) => Pdfium::new(Pdfium::bind_to_system_library().unwrap_or_else(|_| {
                     // In a real app, send a fatal error back if DLL missing
                     panic!("Failed to load PDFium DLL"); 
                })),
            };

            let mut document: Option<PdfDocument> = None;

            while let Ok(cmd) = rx_cmd.recv() {
                match cmd {
                    RenderCommand::LoadDocument(path) => {
                        match pdfium.load_pdf_from_file(&path, None) {
                            Ok(doc) => {
                                let count = doc.pages().len();
                                document = Some(doc);
                                let _ = tx_res.send(RenderResult::DocumentLoaded { page_count: count });
                            }
                            Err(e) => { let _ = tx_res.send(RenderResult::Error(e.to_string())); }
                        }
                    }
                    RenderCommand::RenderPage { page_index, _width: _, _height: _, scale } => {
                        if let Some(doc) = &document {
                            if let Ok(page) = doc.pages().get(page_index) {
                                // Calculate pixel dimensions based on points * scale
                                let width_pts = page.width().value;
                                let height_pts = page.height().value;
                                let render_width = (width_pts * scale) as i32;
                                let render_height = (height_pts * scale) as i32;

                                let config = PdfRenderConfig::new()
                                    .set_target_width(render_width)
                                    .set_target_height(render_height)
                                    .rotate_if_landscape(PdfPageRenderRotation::None, true);

                                match page.render_with_config(&config) {
                                    Ok(bitmap) => {
                                         let data = bitmap.as_raw_bytes().to_vec();
                                         let _ = tx_res.send(RenderResult::PageRendered { 
                                             page_index, 
                                             image_data: data, 
                                             width: bitmap.width() as u32, 
                                             height: bitmap.height() as u32 
                                         });
                                    }
                                    Err(e) => { let _ = tx_res.send(RenderResult::Error(e.to_string())); }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Load fonts for UI if needed, otherwise default
        Self {
            tx: tx_cmd,
            rx: rx_res,
            current_file: None,
            current_page: 0,
            total_pages: 0,
            scale: 1.5, // Default zoom
            page_texture: None,
            is_loading: false,
            error_msg: None,
        }
    }

    fn request_render(&mut self) {
        if self.current_file.is_some() && self.total_pages > 0 {
            self.is_loading = true;
            // Width/Height ignored here as we calculate from scale in worker
            self.tx.send(RenderCommand::RenderPage { 
                page_index: self.current_page, 
                _width: 0, 
                _height: 0, 
                scale: self.scale 
            }).unwrap();
        }
    }
}

impl eframe::App for EasyPdfApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // 1. Process Background Messages
        while let Ok(res) = self.rx.try_recv() {
            match res {
                RenderResult::DocumentLoaded { page_count } => {
                    self.total_pages = page_count;
                    self.current_page = 0;
                    self.error_msg = None;
                    self.request_render();
                }
                RenderResult::PageRendered { image_data, width, height, page_index } => {
                    if page_index == self.current_page {
                        let image = egui::ColorImage::from_rgba_unmultiplied(
                            [width as usize, height as usize],
                            &image_data,
                        );
                        self.page_texture = Some(ctx.load_texture("page", image, Default::default()));
                        self.is_loading = false;
                    }
                }
                RenderResult::Error(e) => {
                    self.error_msg = Some(e);
                    self.is_loading = false;
                }
            }
        }

        // 2. Input Handling (Keyboard)
        if !self.is_loading {
            if ctx.input(|i| i.key_pressed(egui::Key::ArrowRight)) {
                if self.current_page + 1 < self.total_pages {
                    self.current_page += 1;
                    self.request_render();
                }
            }
            if ctx.input(|i| i.key_pressed(egui::Key::ArrowLeft)) {
                if self.current_page > 0 {
                    self.current_page -= 1;
                    self.request_render();
                }
            }
            
            // Ctrl + Scroll for Zoom
            let scroll_delta = ctx.input(|i| i.raw_scroll_delta.y);
            if ctx.input(|i| i.modifiers.ctrl) && scroll_delta != 0.0 {
                let old_scale = self.scale;
                if scroll_delta > 0.0 {
                    self.scale *= 1.1;
                } else {
                    self.scale *= 0.9;
                }
                self.scale = self.scale.clamp(0.1, 5.0);
                if (self.scale - old_scale).abs() > 0.01 {
                    self.request_render();
                }
            }
        }

        // 3. UI Layout
        egui::TopBottomPanel::top("top_panel").show(ctx, |ui| {
            ui.horizontal(|ui| {
                if ui.button("Open PDF").clicked() {
                    if let Some(path) = rfd::FileDialog::new().pick_file() {
                        let p = path.display().to_string();
                        self.current_file = Some(p.clone());
                        self.tx.send(RenderCommand::LoadDocument(p)).unwrap();
                    }
                }

                if self.total_pages > 0 {
                    if ui.button("Prev").clicked() && self.current_page > 0 {
                        self.current_page -= 1;
                        self.request_render();
                    }
                    ui.label(format!("Page {} / {}", self.current_page + 1, self.total_pages));
                    if ui.button("Next").clicked() && self.current_page + 1 < self.total_pages {
                        self.current_page += 1;
                        self.request_render();
                    }
                    
                    ui.separator();
                    if ui.button("-").clicked() { self.scale *= 0.9; self.request_render(); }
                    ui.label(format!("{:.0}%", self.scale * 100.0));
                    if ui.button("+").clicked() { self.scale *= 1.1; self.request_render(); }
                }
                
                if self.is_loading {
                    ui.spinner();
                }
            });
        });

        if let Some(err) = &self.error_msg {
            egui::TopBottomPanel::bottom("error_panel").show(ctx, |ui| {
                ui.colored_label(egui::Color32::RED, err);
            });
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(texture) = &self.page_texture {
                egui::ScrollArea::both().show(ui, |ui| {
                    ui.image(texture);
                });
            } else {
                ui.centered_and_justified(|ui| {
                    ui.heading("Open a PDF file to start");
                });
            }
        });
    }
}

fn main() -> eframe::Result<()> {
    eframe::run_native(
        "Easy PDF Reader",
        eframe::NativeOptions::default(),
        Box::new(|cc| Ok(Box::new(EasyPdfApp::new(cc)))),
    )
}