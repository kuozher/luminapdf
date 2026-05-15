import { useState, useEffect, useRef } from 'react';
import {
    Printer, LayoutTemplate, Loader2, ChevronDown, AlertCircle, Check,
    Palette, CircleOff, Contrast,
    FileText, BookOpen, StickyNote,
    ChevronLeft, ChevronRight, X, AlertTriangle
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface PrinterInfo {
    name: string;
    is_default: boolean;
}

interface PrintSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentPage: number;
    totalPages: number;
    fileName: string;
}

export interface PrintSettings {
    scope: 'all' | 'current' | 'custom' | 'odd' | 'even';
    custom_range: string;
    include_headers: boolean;
    header_left: string;
    header_center: string;
    header_right: string;
    include_footer: boolean;
    footer_left: string;
    footer_center: string;
    footer_right: string;
}

export default function PrintSettingsModal({ isOpen, onClose, currentPage, totalPages, fileName }: PrintSettingsModalProps) {
    // Printer Settings
    const [printers, setPrinters] = useState<PrinterInfo[]>([]);
    const [selectedPrinter, setSelectedPrinter] = useState<string>("");
    const [paperSize, setPaperSize] = useState<"A4" | "Letter" | "Legal">("A4");
    const [colorMode, setColorMode] = useState<"color" | "grayscale" | "bw">("color");
    const [duplex, setDuplex] = useState<"simplex" | "long" | "short">("simplex");
    const [quality, setQuality] = useState<150 | 300 | 600>(300);
    const [copies, setCopies] = useState(1);
    const [loadingPrinters, setLoadingPrinters] = useState(false);

    // Page Settings
    const [scope, setScope] = useState<'all' | 'current' | 'custom' | 'odd' | 'even'>('all');
    const [customRange, setCustomRange] = useState("");
    const [includeHeaders, setIncludeHeaders] = useState(false);
    const [headerLeft, setHeaderLeft] = useState(fileName);
    const [headerCenter, setHeaderCenter] = useState("");
    const [headerRight, setHeaderRight] = useState("[Page]");
    const [includeFooter, setIncludeFooter] = useState(false);
    const [footerLeft, setFooterLeft] = useState("");
    const [footerCenter, setFooterCenter] = useState("");
    const [footerRight, setFooterRight] = useState("");

    // Accordion State
    const [annotationsExpanded, setAnnotationsExpanded] = useState(false);

    // Preview & Status
    const [previewCache, setPreviewCache] = useState<Record<number, string>>({});
    const [previewTotalPages, setPreviewTotalPages] = useState(0);
    const [previewPage, setPreviewPage] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [isPrinting, setIsPrinting] = useState(false);
    const [printResult, setPrintResult] = useState<{ success: boolean; message: string } | null>(null);

    const timerRef = useRef<number | null>(null);

    // Reset all state (except printers) when modal opens
    useEffect(() => {
        if (!isOpen) return;
        setPaperSize("A4");
        setColorMode("color");
        setDuplex("simplex");
        setQuality(300);
        setCopies(1);
        setScope("all");
        setCustomRange("");
        setIncludeHeaders(false);
        setHeaderLeft(fileName);
        setHeaderCenter("");
        setHeaderRight("[Page]");
        setIncludeFooter(false);
        setFooterLeft("");
        setFooterCenter("");
        setFooterRight("");
        setPreviewCache({});
        setPreviewTotalPages(0);
        setPreviewPage(0);
        setPrintResult(null);
        setIsPrinting(false);
    }, [isOpen]);

    // Fetch printers on open
    useEffect(() => {
        if (!isOpen) return;
        setLoadingPrinters(true);
        invoke<PrinterInfo[]>("list_printers")
            .then((list) => {
                setPrinters(list);
                const defaultPrinter = list.find(p => p.is_default);
                if (defaultPrinter) setSelectedPrinter(defaultPrinter.name);
                else if (list.length > 0) setSelectedPrinter(list[0].name);
            })
            .catch(e => console.error("Failed to list printers:", e))
            .finally(() => setLoadingPrinters(false));
    }, [isOpen]);

    const fetchSinglePage = async (pageIndex: number, resetCache = false) => {
        setIsLoading(true);
        try {
            const result = await invoke<{ image: string; total_pages: number }>("generate_print_document", {
                settings: {
                    scope,
                    custom_range: customRange,
                    include_headers: includeHeaders,
                    header_left: headerLeft,
                    header_center: headerCenter,
                    header_right: headerRight,
                    include_footer: includeFooter,
                    footer_left: footerLeft,
                    footer_center: footerCenter,
                    footer_right: footerRight,
                    color_mode: colorMode,
                    paper_size: paperSize,
                    quality_dpi: quality,
                    current_page: currentPage,
                    requested_page_index: pageIndex
                }
            });
            setPreviewTotalPages(result.total_pages);
            setPreviewCache(prev => resetCache
                ? { [pageIndex]: result.image }
                : { ...prev, [pageIndex]: result.image }
            );
        } catch (e) {
            console.error("Preview Gen Failed:", e);
            if (resetCache) {
                setPreviewCache({});
                setPreviewTotalPages(0);
            }
        } finally {
            setIsLoading(false);
        }
    };

    // When settings change, reset cache and fetch the current page (not page 0)
    useEffect(() => {
        if (!isOpen) return;
        if (totalPages === 0) return;
        if (scope === 'custom' && !customRange) return;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            // We fetch the current previewPage.
            // If the backend returns a new total_pages smaller than previewPage,
            // the subsequent effect will handle the clamping.
            fetchSinglePage(previewPage, true);
        }, 800) as unknown as number;

        return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }, [isOpen, scope, customRange, includeHeaders, headerLeft, headerCenter, headerRight, includeFooter, footerLeft, footerCenter, footerRight, colorMode, paperSize, quality]);

    // Safety: clamp previewPage if total pages decrease
    useEffect(() => {
        if (previewTotalPages > 0 && previewPage >= previewTotalPages) {
            setPreviewPage(previewTotalPages - 1);
        }
    }, [previewTotalPages]);

    // When navigating to a page not yet cached, fetch it
    useEffect(() => {
        if (!isOpen || previewTotalPages === 0) return;
        if (previewCache[previewPage]) return; // already cached
        fetchSinglePage(previewPage);
    }, [previewPage]);

    const handlePrint = async () => {
        if (!selectedPrinter) return;
        setIsPrinting(true);
        setPrintResult(null);

        // UX Optimization for Virtual PDF Printers
        if (isVirtualPrinter) {
            try {
                // 1. Ask user for save location first (consistent UX)
                const savePath = await invoke<string | null>("pick_save_path");
                if (!savePath) {
                    setIsPrinting(false);
                    return;
                }

                // 2. Generate and Save (using the same backend logic but a dedicated flow)
                // We'll reuse the print logic but since it's a "virtual" one,
                // we treat it as a "Save As" operation.
                const message = await invoke<string>("print_to_printer", {
                    settings: {
                        printer_name: selectedPrinter,
                        copies: 1, // PDF only needs 1 copy
                        color_mode: colorMode,
                        duplex: duplex,
                        quality_dpi: quality,
                        paper_size: paperSize,
                        scope,
                        current_page: currentPage,
                        custom_range: customRange,
                        include_headers: includeHeaders,
                        header_left: headerLeft,
                        header_center: headerCenter,
                        header_right: headerRight,
                        include_footer: includeFooter,
                        footer_left: footerLeft,
                        footer_center: footerCenter,
                        footer_right: footerRight,
                        target_path: savePath
                    }
                });
                setPrintResult({ success: true, message: message || "Exported successfully" });
                setTimeout(() => onClose(), 2000);
            } catch (e) {
                setPrintResult({ success: false, message: String(e) });
            } finally {
                setIsPrinting(false);
            }
            return;
        }

        // Standard Physical Printer Flow
        try {
            const result = await invoke<string>("print_to_printer", {
                settings: {
                    printer_name: selectedPrinter,
                    copies,
                    color_mode: colorMode,
                    duplex: duplex,
                    quality_dpi: quality,
                    paper_size: paperSize,
                    scope,
                    current_page: currentPage,
                    custom_range: customRange,
                    include_headers: includeHeaders,
                    header_left: headerLeft,
                    header_center: headerCenter,
                    header_right: headerRight,
                    include_footer: includeFooter,
                    footer_left: footerLeft,
                    footer_center: footerCenter,
                    footer_right: footerRight
                }
            });
            setPrintResult({ success: true, message: result });
            setTimeout(() => onClose(), 2000);
        } catch (e) {
            setPrintResult({ success: false, message: String(e) });
        } finally {
            setIsPrinting(false);
        }
    };

    if (!isOpen) return null;

    const canPrint = !isPrinting && selectedPrinter && printers.length > 0 && (previewTotalPages > 0 || totalPages > 0);
    const isVirtualPrinter = /pdf|xps|onenote|fax|print to/i.test(selectedPrinter);
    const isDuplexOddPage = previewPage % 2 === 1 && duplex !== 'simplex';
    const duplexFlipStyle: React.CSSProperties = isDuplexOddPage
        ? { transform: duplex === 'short' ? 'scaleY(-1)' : 'scaleX(-1)' }
        : {};

    const getActionButtonLabel = () => {
        if (isPrinting) return 'Processing...';
        if (printers.length === 0) return 'No printers available';
        if (isVirtualPrinter) return `Save as PDF`;
        return `Print to ${selectedPrinter}`;
    };

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl overflow-hidden max-w-6xl w-full h-[85vh] flex flex-row" onClick={(e) => e.stopPropagation()}>

                {/* Left: Settings Panel */}
                <div className="w-[420px] shrink-0 border-r border-neutral-700 flex flex-col bg-neutral-800/50">
                    <div className="p-6 border-b border-neutral-700 flex items-center justify-between shrink-0">
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                            <Printer size={20} className="text-blue-400" />
                            Print Settings
                        </h3>
                        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors">
                            <X size={18} />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-5">
                        {/* Printer Selection */}
                        <div>
                            <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Printer</label>
                            <div className="relative">
                                <select
                                    value={selectedPrinter}
                                    onChange={(e) => setSelectedPrinter(e.target.value)}
                                    disabled={loadingPrinters}
                                    className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-3 py-2.5 text-sm text-white appearance-none cursor-pointer focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                                >
                                    {loadingPrinters ? (
                                        <option>Loading printers...</option>
                                    ) : printers.length === 0 ? (
                                        <option>No printers found</option>
                                    ) : (
                                        printers.map(p => (
                                            <option key={p.name} value={p.name}>
                                                {p.name} {p.is_default && "(Default)"}
                                            </option>
                                        ))
                                    )}
                                </select>
                                <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
                            </div>
                        </div>

                        {/* Paper, Quality, Copies Row */}
                        <div className="grid grid-cols-3 gap-3">
                            <div>
                                <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Paper</label>
                                <div className="relative">
                                    <select
                                        value={paperSize}
                                        onChange={(e) => setPaperSize(e.target.value as "A4" | "Letter" | "Legal")}
                                        className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-2.5 py-2 text-sm text-white appearance-none cursor-pointer focus:ring-2 focus:ring-blue-500 outline-none"
                                    >
                                        <option value="A4">A4</option>
                                        <option value="Letter">Letter</option>
                                        <option value="Legal">Legal</option>
                                    </select>
                                    <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Quality</label>
                                <div className="relative">
                                    <select
                                        value={quality}
                                        onChange={(e) => setQuality(Number(e.target.value) as 150 | 300 | 600)}
                                        className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-2.5 py-2 text-sm text-white appearance-none cursor-pointer focus:ring-2 focus:ring-blue-500 outline-none"
                                    >
                                        <option value={150}>Draft</option>
                                        <option value={300}>Normal</option>
                                        <option value={600}>High</option>
                                    </select>
                                    <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Copies</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={99}
                                    value={copies}
                                    onChange={(e) => setCopies(Math.max(1, Math.min(99, Number(e.target.value))))}
                                    className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-2 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none text-center"
                                />
                            </div>
                        </div>

                        {/* Color Mode */}
                        <div>
                            <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Color Mode</label>
                            <div className="flex gap-2">
                                {[
                                    { value: 'color', label: 'Color', Icon: Palette },
                                    { value: 'grayscale', label: 'Gray', Icon: CircleOff },
                                    { value: 'bw', label: 'B&W', Icon: Contrast }
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setColorMode(opt.value as typeof colorMode)}
                                        className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer
                                            ${colorMode === opt.value
                                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                                                : 'bg-neutral-700/50 text-neutral-300 hover:bg-neutral-700'
                                            }`}
                                    >
                                        <opt.Icon size={14} />
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Duplex Mode */}
                        <div>
                            <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Duplex</label>
                            <div className="flex gap-2">
                                {[
                                    { value: 'simplex', label: 'One-sided', Icon: FileText },
                                    { value: 'long', label: 'Two-sided (Long Edge)', Icon: BookOpen },
                                    { value: 'short', label: 'Two-sided (Short Edge)', Icon: StickyNote }
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setDuplex(opt.value as typeof duplex)}
                                        className={`flex-1 py-2 px-1 rounded-lg text-sm font-medium transition-all flex flex-col items-center justify-center gap-1 cursor-pointer
                                            ${duplex === opt.value
                                                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
                                                : 'bg-neutral-700/50 text-neutral-300 hover:bg-neutral-700'
                                            }`}
                                    >
                                        <opt.Icon size={16} />
                                        <span className="text-[10px] leading-tight text-center">{opt.label}</span>
                                    </button>
                                ))}
                            </div>
                            {isVirtualPrinter && duplex !== 'simplex' && (
                                <div className="mt-2 flex items-start gap-2 p-2.5 rounded-lg bg-amber-900/20 border border-amber-700/50 text-amber-400 text-xs leading-relaxed animate-in fade-in slide-in-from-top-1">
                                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                                    <span>Virtual printers use driver defaults. Duplex/orientation settings may not apply.</span>
                                </div>
                            )}
                        </div>

                        <hr className="border-neutral-700" />

                        {/* Page Range — now includes Odd/Even */}
                        <div>
                            <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Page Range</label>
                            <div className="grid grid-cols-5 gap-1.5">
                                {[
                                    { value: 'all', label: `All (${totalPages})` },
                                    { value: 'current', label: 'Current' },
                                    { value: 'custom', label: 'Custom' },
                                    { value: 'odd', label: 'Odd' },
                                    { value: 'even', label: 'Even' },
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setScope(opt.value as typeof scope)}
                                        className={`py-2 px-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer
                                            ${scope === opt.value
                                                ? 'bg-blue-600/20 border-blue-600/50 text-blue-400 border'
                                                : 'bg-neutral-700/30 border-neutral-700 text-neutral-300 border hover:bg-neutral-700'
                                            }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                            {scope === 'custom' && (
                                <input
                                    type="text"
                                    placeholder="e.g. 1, 3-5, 8"
                                    value={customRange}
                                    onChange={(e) => setCustomRange(e.target.value)}
                                    className="w-full mt-2 bg-neutral-900 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                            )}
                        </div>

                        {/* Print Annotations Collapsible Section */}
                        <div className="space-y-1">
                            <button
                                onClick={() => setAnnotationsExpanded(!annotationsExpanded)}
                                className="w-full flex items-center justify-between py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-300 uppercase tracking-wider transition-colors cursor-pointer group"
                            >
                                <span className="flex items-center gap-2">
                                    Print Annotations
                                    {(includeHeaders || includeFooter) && (
                                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                                    )}
                                </span>
                                {annotationsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>

                            {annotationsExpanded && (
                                <div className="space-y-4 pt-1 animate-in fade-in slide-in-from-top-1">
                                    {/* Headers */}
                                    <div className="bg-neutral-900/40 p-3 rounded-lg border border-neutral-700/50 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-medium text-neutral-300">Header</span>
                                            <label className="relative inline-flex items-center cursor-pointer">
                                                <input type="checkbox" checked={includeHeaders} onChange={(e) => setIncludeHeaders(e.target.checked)} className="sr-only peer" />
                                                <div className="w-8 h-4 bg-neutral-700 rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4"></div>
                                            </label>
                                        </div>
                                        {includeHeaders && (
                                            <div className="grid grid-cols-3 gap-1.5 animate-in fade-in slide-in-from-top-1">
                                                <input type="text" placeholder="Left" value={headerLeft} onChange={(e) => setHeaderLeft(e.target.value)} className="bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-blue-500 outline-none" />
                                                <input type="text" placeholder="Center" value={headerCenter} onChange={(e) => setHeaderCenter(e.target.value)} className="bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-blue-500 outline-none text-center" />
                                                <input type="text" placeholder="Right" value={headerRight} onChange={(e) => setHeaderRight(e.target.value)} className="bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-blue-500 outline-none text-right" />
                                            </div>
                                        )}
                                    </div>

                                    {/* Footer */}
                                    <div className="bg-neutral-900/40 p-3 rounded-lg border border-neutral-700/50 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-medium text-neutral-300">Footer</span>
                                            <label className="relative inline-flex items-center cursor-pointer">
                                                <input type="checkbox" checked={includeFooter} onChange={(e) => setIncludeFooter(e.target.checked)} className="sr-only peer" />
                                                <div className="w-8 h-4 bg-neutral-700 rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4"></div>
                                            </label>
                                        </div>
                                        {includeFooter && (
                                            <div className="grid grid-cols-3 gap-1.5 animate-in fade-in slide-in-from-top-1">
                                                <input type="text" placeholder="Left" value={footerLeft} onChange={(e) => setFooterLeft(e.target.value)} className="bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-blue-500 outline-none" />
                                                <input type="text" placeholder="Center" value={footerCenter} onChange={(e) => setFooterCenter(e.target.value)} className="bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-blue-500 outline-none text-center" />
                                                <input type="text" placeholder="Right" value={footerRight} onChange={(e) => setFooterRight(e.target.value)} className="bg-neutral-950 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-white focus:ring-1 focus:ring-blue-500 outline-none text-right" />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="p-4 border-t border-neutral-700 bg-neutral-800 shrink-0 space-y-3">
                        {printResult && (
                            <div className={`p-3 rounded-lg flex items-center gap-2 text-sm ${printResult.success ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                                {printResult.success ? <Check size={16} /> : <AlertCircle size={16} />}
                                {printResult.message}
                            </div>
                        )}
                        <div className="flex gap-3">
                            <button onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-medium text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors cursor-pointer">Cancel</button>
                            <button
                                onClick={handlePrint}
                                disabled={!canPrint}
                                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2.5 text-sm font-semibold transition-all shadow-lg hover:shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
                            >
                                {isPrinting ? <Loader2 className="animate-spin" size={16} /> : <Printer size={16} />}
                                {getActionButtonLabel()}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Right: Preview Panel */}
                <div className="flex-1 bg-neutral-900 overflow-hidden flex flex-col relative">
                    {/* Preview header — minimal, nav moved to overlay */}
                    <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-700/50 bg-neutral-900/80 shrink-0">
                        <span className="text-xs text-neutral-500 font-medium">Preview</span>
                        {previewTotalPages > 0 && (
                            <span className="text-xs text-neutral-400 font-mono tabular-nums">
                                {previewPage + 1} / {previewTotalPages}
                            </span>
                        )}
                        {isLoading && (
                            <div className="flex items-center gap-1.5 text-blue-400">
                                <Loader2 size={12} className="animate-spin" />
                                <span className="text-xs">Generating...</span>
                            </div>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center justify-center gap-8 bg-neutral-950/50 relative">
                        {totalPages === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-neutral-500 gap-3">
                                <AlertCircle size={48} className="opacity-30" />
                                <p className="text-sm">No document loaded</p>
                            </div>
                        ) : previewTotalPages === 0 && !isLoading ? (
                            <div className="flex flex-col items-center justify-center h-full text-neutral-500">
                                <LayoutTemplate size={48} className="mb-4 opacity-50" />
                                <p>Preview will appear here</p>
                            </div>
                        ) : previewTotalPages > 0 ? (
                            <div className="relative group flex flex-col items-center w-full h-full justify-center">
                                {/* Preview image with duplex flip - fixed: use drop-shadow to follow content shape */}
                                <div className="relative w-full h-full max-w-[95%] max-h-[calc(100%-80px)] flex items-center justify-center overflow-hidden">
                                    {previewCache[previewPage] ? (
                                        <img
                                            src={previewCache[previewPage]}
                                            alt={`Page ${previewPage + 1}`}
                                            className="w-full h-full object-contain block transition-transform duration-200 [filter:drop-shadow(0_20px_30px_rgba(0,0,0,0.5))]"
                                            style={duplexFlipStyle}
                                        />
                                    ) : (
                                        <div className="aspect-[210/297] w-[400px] max-w-full flex items-center justify-center bg-neutral-800/50 rounded-sm border border-neutral-700/50">
                                            <Loader2 size={32} className="animate-spin text-neutral-500" />
                                        </div>
                                    )}
                                </div>

                                {/* Duplex badge */}
                                {isDuplexOddPage && (
                                    <div className="mt-2 text-[11px] text-amber-400 bg-amber-900/25 border border-amber-700/40 rounded-full px-3 py-0.5 font-medium">
                                        Back side ({duplex === 'short' ? 'short-edge' : 'long-edge'} flip)
                                    </div>
                                )}

                                {/* Page indicator below preview */}
                                <div className="mt-3 flex items-center gap-3">
                                    <button
                                        onClick={() => setPreviewPage(Math.max(0, previewPage - 1))}
                                        disabled={previewPage === 0}
                                        className="p-1 rounded-md hover:bg-neutral-700 text-neutral-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                                    >
                                        <ChevronLeft size={16} />
                                    </button>
                                    <span className="text-xs text-neutral-400 font-mono tabular-nums min-w-[60px] text-center">
                                        Page {previewPage + 1} of {previewTotalPages}
                                    </span>
                                    <button
                                        onClick={() => setPreviewPage(Math.min(previewTotalPages - 1, previewPage + 1))}
                                        disabled={previewPage >= previewTotalPages - 1}
                                        className="p-1 rounded-md hover:bg-neutral-700 text-neutral-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                                    >
                                        <ChevronRight size={16} />
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
