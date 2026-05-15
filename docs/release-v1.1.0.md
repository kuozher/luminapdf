# Lumina PDF v1.1.0 Release Notes

Release date: 2026-05-15

## English

### Highlights

- Adds experimental printing support on Windows, including printer selection, page ranges, copies, color mode, paper size, quality, preview generation, and PDF virtual-printer handling.
- Improves annotation visibility by showing annotation markers directly on pages, highlighting the selected or hovered annotation, and syncing the annotation side panel with page selections.
- Keeps the Windows one-click installer target enabled through the Tauri MSI bundle output.

### Notes

- Printing is experimental. Physical-printer behavior may vary by driver, and some virtual printers may ignore duplex or orientation settings.
- The MSI installer is expected at `src-tauri/target/release/bundle/msi/Lumina PDF_1.1.0_x64_en-US.msi` after a successful Tauri build.

## 繁體中文

### 版本重點

- 新增 Windows 實驗性列印功能，包含印表機選擇、頁面範圍、份數、色彩模式、紙張尺寸、列印品質、預覽產生，以及 PDF 虛擬印表機處理。
- 改善註釋顯示方式：在頁面上直接顯示註釋標記，滑過或選取註釋時會醒目標示，並同步右側註釋清單與頁面選取狀態。
- 保留 Windows 一鍵安裝需求，Tauri 仍會輸出 MSI 安裝包。

### 注意事項

- 列印功能仍屬實驗中。實體印表機行為可能因驅動程式不同而有差異，部分虛擬印表機可能不套用雙面或方向設定。
- 成功執行 Tauri build 後，MSI 預期輸出位置為 `src-tauri/target/release/bundle/msi/Lumina PDF_1.1.0_x64_en-US.msi`。
