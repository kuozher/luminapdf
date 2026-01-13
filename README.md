    
# Lumina PDF

<p align="left">
  <!-- 技術堆疊 -->
  <img src="https://img.shields.io/badge/Rust-backend-orange?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/Tauri-v2-blue?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/React-frontend-61DAFB?style=flat-square&logo=react" />
</p>
<p align="left">
  <!-- AI 夥伴 (這裡放 Gemini) -->
  <img src="https://img.shields.io/badge/Co--coded%20with-Gemini_Pro-8E75B2?style=flat-square&logo=googlegemini&logoColor=white" />
  <img src="https://img.shields.io/badge/Claude-3.5_Sonnet-D97757?style=flat-square&logo=anthropic&logoColor=white" />

</p>

**Lumina PDF** is a high-performance, lightweight desktop PDF tool built with **Rust**, **Tauri v2**, and **Pdfium**.

Unlike traditional wrappers around web-based PDF.js, Lumina PDF bridges a high-performance Rust backend directly with the Google Pdfium engine to handle rendering, ensuring blazing fast speeds and low memory usage even for large files.

## 🚀 Key Features

- **High Performance**: Native rendering via `pdfium-render` (Rust) ensures 60fps scrolling and instant page loads.
- **Virtual Document Architecture**: Supports non-destructive editing. You can rotate, reorder, delete, and merge pages using an in-memory virtual structure. Changes are only written to disk when you save.
- **Strict Lazy Loading**: Optimized resource management. Pages are rendered on-demand, allowing instant opening of 500+ page documents without memory spikes.
- **Modern UI**: A clean, distraction-free interface built with React, TypeScript, and TailwindCSS.
- **Thumbnail Overlay**: A specialized Grid View for organizing pages via Drag & Drop.

## 🛠 Tech Stack

- **Core Logic**: [Rust](https://www.rust-lang.org/)
- **App Framework**: [Tauri v2](https://tauri.app/)
- **PDF Engine**: [Google Pdfium](https://pdfium.googlesource.com/pdfium/) (via `pdfium-render` crate)
- **Frontend**: React, TypeScript, Vite, TailwindCSS
- **State Management**: Rust-side `Mutex` state for the virtual document model.

## 📦 Getting Started

### Prerequisites

1. **Rust**: Make sure you have the latest stable Rust installed.
2. **Node.js**: Install Node.js and a package manager (npm/pnpm/yarn).
3. **Pdfium Dynamic Library**:
   - Since Pdfium is a C++ library, you need the compiled binary.
   - Download the appropriate `pdfium.dll` (Windows), `libpdfium.dylib` (macOS), or `libpdfium.so` (Linux) from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries).
   - Place it in your project's root or resource folder (configure `tauri.conf.json` accordingly).

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/luminapdf.git
   cd luminapdf

2. **Install frontend dependencies**

   ```bash
   npm install
   # or
   pnpm install
   ```
  
3. Run in development mode

   ```Bash 
   npm run tauri dev
   # or
   cargo tauri dev
   ```
      

🧩 Architecture Highlights
The Virtual Document Model

Instead of modifying the physical PDF file for every operation (which is slow and risky), Lumina PDF maintains a lightweight Vec<PageInfo> in the Rust backend.

- Mapping: Frontend requests "Page 1", Backend looks up the virtual map -> fetches "Original Page 5 from file A.pdf".
- Safety: No data loss during editing. Complex operations like merging multiple files happen instantly in memory.

**Custom Protocol Rendering**

We utilize a custom Tauri protocol (pdf-page://) to stream rendered bitmaps directly from Rust memory to the frontend <img> tags, bypassing Base64 encoding overhead for maximum performance.

📄 **License**

This project is licensed under the [MIT License](https://www.google.com/url?sa=E&q=LICENSE). Feel free to fork, modify, and distribute.



## ✍️ Author's Note
Initially, my goal was simply to create a lightweight alternative to Adobe Reader, despite having limited knowledge of deep frontend or backend coding. Consequently, the execution of this project was entrusted almost entirely to AI—specifically, 90% of the code was generated using the Google Gemini CLI (Gemini Pro 3 model), with my role serving as the adjudicator of its suggestions.

I realize some might dismiss this as just another piece of 'AI slop' created by someone who doesn't understand the underlying code rules. However, that doesn't matter to me. When problems arose, they were solved; when decisions were needed, I grasped the context and acted on logic. A tool is ultimately just a tool, and my only hope is that the final product brings real value to its users.

=======



---

# Lumina PDF

<p align="left">
  <img src="https://img.shields.io/badge/Rust-backend-orange?style=flat-square&logo=rust" />
  <img src="https://img.shields.io/badge/Tauri-v2-blue?style=flat-square&logo=tauri" />
  <img src="https://img.shields.io/badge/React-frontend-61DAFB?style=flat-square&logo=react" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
</p>

**Lumina PDF** 是一款基於 **Rust**、**Tauri v2** 與 **Pdfium** 構建的高效能、輕量級桌面 PDF 工具。

不同於傳統依賴 Web 版 PDF.js 的應用程式，Lumina PDF 透過高效的 Rust 後端直接橋接 Google Pdfium 引擎來處理渲染，確保即使是開啟大型檔案，也能擁有極低的記憶體佔用與流暢的瀏覽體驗。

## 🚀 核心特色

- **極致效能**：透過 `pdfium-render` (Rust) 進行原生渲染，實現 60fps 的流暢捲動與秒開頁面。
- **虛擬文檔架構 (Virtual Document)**：支援「非破壞性編輯」。所有旋轉、排序、刪除或合併頁面的操作，皆在記憶體中的虛擬結構進行，直到儲存時才會寫入硬碟，快速且安全。
- **嚴格懶加載 (Lazy Loading)**：優化的資源管理機制。僅在需要時渲染可見頁面，開啟 500 頁以上的文件也不會造成記憶體暴衝。
- **現代化介面**：使用 React, TypeScript 與 TailwindCSS 打造簡潔、無干擾的閱讀介面。
- **縮圖管理**：提供 Grid View 覆蓋層 (Overlay)，支援直覺的拖放 (Drag & Drop) 頁面排序功能。

## 🛠 技術堆疊

- **核心邏輯**：[Rust](https://www.rust-lang.org/)
- **應用框架**：[Tauri v2](https://tauri.app/)
- **PDF 引擎**：[Google Pdfium](https://pdfium.googlesource.com/pdfium/) (透過 `pdfium-render` crate)
- **前端介面**：React, TypeScript, Vite, TailwindCSS
- **狀態管理**：Rust 端的 `Mutex` 用於管理虛擬文檔模型。

## 📦 如何開始 (Getting Started)

### 前置需求 (Prerequisites)

1. **Rust**：請確保已安裝最新穩定版的 Rust。
2. **Node.js**：安裝 Node.js 以及套件管理器 (npm/pnpm/yarn)。
3. **Pdfium 動態連結庫**：
   - 由於 Pdfium 是 C++ 庫，您需要下載編譯好的二進制檔案。
   - 請至 [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) 下載對應您系統的檔案：`pdfium.dll` (Windows), `libpdfium.dylib` (macOS), 或 `libpdfium.so` (Linux)。
   - 將檔案放入專案根目錄或資源資料夾中（並需配置 `tauri.conf.json`）。

### 安裝步驟 (Installation)

1. **複製專案 (Clone)**
   ```bash
   git clone https://github.com/YOUR_USERNAME/luminapdf.git
   cd luminapdf
   ```
   
2.**安裝前端依賴**
   ```bash
   npm install
   # 或使用
   pnpm install
   ```

3.**啟動開發模式**
   ```
   npm run tauri dev
   # 或使用
   cargo tauri dev
   ```


🧩 架構亮點
虛擬文檔模型 (The Virtual Document Model)

應用程式不會在每次操作時修改實體 PDF 檔案（這既慢又有風險），而是在 Rust 後端維護一個輕量的 Vec<PageInfo> 列表。

   - 映射機制：前端請求「第 1 頁」，後端查找虛擬映射表 -> 讀取「A.pdf 的原始第 5 頁」。
   - 安全性：編輯過程中無資料遺失風險。合併多個檔案等複雜操作皆在記憶體中瞬間完成。

自定義協議渲染

我們利用 Tauri 的自定義協議 (pdf-page://)，將 Rust 記憶體中渲染好的 Bitmap 直接串流給前端的 <img> 標籤，跳過了 Base64 編碼的效能開銷，達到最大效能。
📄 授權條款 (License)

本專案採用 [MIT License](https://www.google.com/url?sa=E&q=LICENSE) 授權。歡迎 Fork、修改與分發。



## ✍️ 我的一些碎碎唸
一開始，我只是想要做個 adobe reader 平替，而且我根本不懂太深的前後端編碼。所以，原則上，這程式在執行面上幾乎完全交付給 AI 進行處理，90%使用的是 Google Gemini CLI 的 gemini pro 3 model，我本身負責對 AI 的建議進行判斷。我知道有些人會覺得這又是另一個 AI slop 產物，明明對編碼內容規則一無所知，但，無所謂，問題來了就解決，判斷來了就理解脈絡，合理就做，工具始終是工具，但我更希望最終都是能讓使用者受惠。





