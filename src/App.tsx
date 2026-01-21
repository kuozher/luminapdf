import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen, ZoomIn, ZoomOut, Loader2, Book, MessageSquare, Grid, List as ListIcon, Save, Copy, Search, X, AlertCircle, FileText, Edit2 } from "lucide-react";
import ReaderView from "./components/ReaderView";
import OrganizerView from "./components/OrganizerView";
import OrganizePill from "./components/OrganizePill";
import EmptyState from "./components/EmptyState";

interface AnnotationData {
    page_index: number;
    subtype: String;
    content: String;
    rect: number[];
    page_height: number;
    uri?: string;
    dest_page_index?: number;
}

interface SearchResult {
    page_index: number;
    text: string;
    rects: number[][];
}

interface ReorderResponse {
    metadata: PageMetadata[];
    final_index: number;
}

interface PageMetadata {
    width: number;
    height: number;
    rotation: number;
    name: string;
    has_bookmark: boolean;
}

function App() {
    const [currentFile, setCurrentFile] = useState<string | null>(null);
    const [pageMeta, setPageMeta] = useState<PageMetadata[]>([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [scale, setScale] = useState(1.0);
    const [renderScale, setRenderScale] = useState(1.0);
    const [tempScale, setTempScale] = useState("100");
    const [error, setError] = useState<string | null>(null);
    const [docId, setDocId] = useState(0);
    const [fileSessionId, setFileSessionId] = useState(0);
    const [readerScrollTop, setReaderScrollTop] = useState(0);

    const [isFileLoading, setIsFileLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const [showLeftPanel, setShowLeftPanel] = useState(false);
    const [showRightPanel, setShowRightPanel] = useState(false);
    const [rightPanelTab, setRightPanelTab] = useState<'annotations' | 'search'>('annotations');

    const [annotations, setAnnotations] = useState<AnnotationData[]>([]);
    const [focusedAnnotation, setFocusedAnnotation] = useState<AnnotationData | null>(null);

    const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

    const [searchQuery, setSearchQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [focusedSearchResult, setFocusedSearchResult] = useState<SearchResult | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const [selectionInfo, setSelectionInfo] = useState<{ x: number, y: number, text: string } | null>(null);

    const [deleteTarget, setDeleteTarget] = useState<number | number[] | null>(null);
    const [showToast, setShowToast] = useState(false);
    const [toastMessage, setToastMessage] = useState<string>("Page deleted");
    const [viewMode, setViewMode] = useState<'reader' | 'organizer'>('reader');

    const [scrollSignal, setScrollSignal] = useState<{ index: number, timestamp: number, annotation?: AnnotationData, searchResult?: SearchResult } | null>(null);

    const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
    const [renamingValue, setRenamingValue] = useState("");
    const [processingIndices, setProcessingIndices] = useState<Set<number>>(new Set());
    const [affectedRange, setAffectedRange] = useState<[number, number] | null>(null);

    // Password modal state
    const [passwordModalPath, setPasswordModalPath] = useState<string | null>(null);
    const [passwordInput, setPasswordInput] = useState("");
    const [passwordError, setPasswordError] = useState<string | null>(null);

    useEffect(() => {
        const timer = setTimeout(() => { setRenderScale(scale); }, 400);
        return () => clearTimeout(timer);
    }, [scale]);

    useEffect(() => {
        const appWindow = getCurrentWindow();
        if (currentFile) {
            const fileName = currentFile.split(/[\/]/).pop();
            appWindow.setTitle(`Lumina PDF - ${fileName}`);
        } else {
            appWindow.setTitle("Lumina PDF");
        }
    }, [currentFile]);

    useEffect(() => {
        setSelectedPages(new Set());
        setLastSelectedIndex(null);
        // Reset scroll position when opening new file
    }, [viewMode]);

    const handleUndo = useCallback(async () => {
        try {
            const newMeta = await invoke<PageMetadata[]>("undo");
            setPageMeta(newMeta); setDocId(Date.now()); setShowToast(false);
            const anns = await invoke<AnnotationData[]>("get_all_annotations");
            setAnnotations(anns || []);
        } catch (e) { console.error("Undo failed:", e); }
    }, []);

    const confirmDelete = useCallback(async () => {
        if (deleteTarget === null) return;
        try {
            const indices = Array.isArray(deleteTarget) ? deleteTarget : [deleteTarget];
            const newMeta = await invoke<PageMetadata[]>("delete_pages", { indices });
            setPageMeta(newMeta); setDocId(Date.now()); setDeleteTarget(null); setSelectedPages(new Set());
            const anns = await invoke<AnnotationData[] | null>("get_all_annotations"); setAnnotations(anns || []);
            setToastMessage(indices.length > 1 ? `${indices.length} pages deleted` : "Page deleted");
            setShowToast(true); setTimeout(() => setShowToast(false), 5000);
        } catch (e) { console.error(e); }
    }, [deleteTarget]);

    const loadFromFilePath = async (path: string, password?: string) => {
        setIsFileLoading(true);
        try {
            const meta = await invoke<PageMetadata[]>("load_document", { path, password: password || null });
            const anns = await invoke<AnnotationData[] | null>("get_all_annotations");
            setPageMeta(meta); setCurrentPage(0); setCurrentFile(path); setAnnotations(anns || []);
            setViewMode('reader'); // Reset mode to reader on new file
            handleClearSearch(); setFocusedAnnotation(null); setScrollSignal(null); setReaderScrollTop(0); setDocId(Date.now()); setFileSessionId(Date.now()); setError(null);
            // Clear password modal on success
            setPasswordModalPath(null); setPasswordInput(""); setPasswordError(null);
        } catch (e) {
            const errStr = String(e);
            if (errStr.includes("PASSWORD_REQUIRED")) {
                setPasswordModalPath(path);
                setPasswordError(null);
            } else if (errStr.includes("PASSWORD_INCORRECT")) {
                setPasswordModalPath(path);
                setPasswordError("Incorrect password. Please try again.");
            } else {
                setError(errStr);
            }
        }
        finally { setIsFileLoading(false); }
    };

    const handlePasswordSubmit = () => {
        if (passwordModalPath && passwordInput) {
            loadFromFilePath(passwordModalPath, passwordInput);
        }
    };

    const handlePasswordCancel = () => {
        setPasswordModalPath(null);
        setPasswordInput("");
        setPasswordError(null);
    };

    const openFile = async () => {
        try {
            const selected = await invoke<string | null>("pick_file");
            if (selected) {
                await loadFromFilePath(selected);
            }
        } catch (e) { setError(String(e)); setIsFileLoading(false); }
    };

    useEffect(() => {
        invoke<string | null>("get_startup_file").then(path => {
            if (path) loadFromFilePath(path);
        }).catch(console.error);
    }, []);

    const handleSave = async () => {
        if (!currentFile) return;
        try {
            const path = await invoke<string | null>("pick_save_path");
            if (path) {
                setIsSaving(true); await invoke("save_document", { path }); setIsSaving(false);
                setToastMessage("Document Saved"); setShowToast(true); setTimeout(() => setShowToast(false), 3000);
            }
        } catch (e) { setError(String(e)); setIsSaving(false); }
    };

    const executeSearch = useCallback(async (query: string) => {
        if (!query.trim()) { setSearchResults([]); setFocusedSearchResult(null); return; }
        setIsSearching(true);
        try {
            const results = await invoke<SearchResult[]>("search_document", { query });
            setSearchResults(results);
        } catch (e) { console.error("Search failed:", e); }
        setIsSearching(false);
    }, []);

    useEffect(() => {
        const q = searchQuery.trim();
        if (!q) { setSearchResults([]); setFocusedSearchResult(null); return; }
        const timer = setTimeout(() => { executeSearch(q); }, 600);
        return () => clearTimeout(timer);
    }, [searchQuery, executeSearch]);

    const handleClearSearch = useCallback(() => {
        setSearchQuery(""); setSearchResults([]); setFocusedSearchResult(null); searchInputRef.current?.focus();
    }, []);

    const handleToggleSelect = useCallback((index: number, isShift: boolean, isCtrl: boolean) => {
        setSelectedPages(prev => {
            const newSelected = new Set(prev);
            if (isShift && lastSelectedIndex !== null) {
                const start = Math.min(lastSelectedIndex, index);
                const end = Math.max(lastSelectedIndex, index);
                for (let i = start; i <= end; i++) { newSelected.add(i); }
            } else if (isCtrl) {
                if (newSelected.has(index)) { newSelected.delete(index); } else { newSelected.add(index); }
            } else {
                newSelected.clear(); newSelected.add(index);
            }
            return newSelected;
        });
        setLastSelectedIndex(index);
    }, [lastSelectedIndex]);

    const handleClearSelection = useCallback(() => { setSelectedPages(new Set()); setLastSelectedIndex(null); }, []);

    const handleBatchRotate = useCallback(async () => {
        if (selectedPages.size === 0) return;
        try {
            const indices = Array.from(selectedPages);
            const newMeta = await invoke<PageMetadata[]>("rotate_pages", { indices });
            setPageMeta(newMeta); setDocId(Date.now());
        } catch (e) { console.error(e); }
    }, [selectedPages]);

    const handleBatchDelete = useCallback(() => { if (selectedPages.size === 0) return; setDeleteTarget(Array.from(selectedPages)); }, [selectedPages]);

    const handleImport = useCallback(async (mode: 'start' | 'before' | 'after' | 'replace' | 'end') => {
        try {
            const paths = await invoke<string[]>("pick_files");
            if (!paths || paths.length === 0) return;

            let insertAt = pageMeta.length;
            let deleteIndices: number[] = [];

            const sortedSelected = Array.from(selectedPages).sort((a, b) => a - b);

            if (mode === 'start') insertAt = 0;
            else if (mode === 'before' && sortedSelected.length > 0) insertAt = sortedSelected[0];
            else if (mode === 'after' && sortedSelected.length > 0) insertAt = sortedSelected[sortedSelected.length - 1] + 1;
            else if (mode === 'replace' && sortedSelected.length > 0) {
                insertAt = sortedSelected[0];
                deleteIndices = Array.from(selectedPages);
            }
            else if (mode === 'end') insertAt = pageMeta.length;

            setIsFileLoading(true);
            // Tauri 2.0 automatic camelCase -> snake_case mapping: deleteIndices -> delete_indices
            const newMeta = await invoke<PageMetadata[]>("import_pages", { paths, insertAt: insertAt, deleteIndices: deleteIndices });
            console.log("Import complete. Received metadata length:", newMeta.length);

            setPageMeta(newMeta); setDocId(Date.now());

            // Select newly imported pages
            // The actual insertion happened at: insertAt - deletedBeforeInsert
            // But wait, our backend logic handles the shift.
            // The new pages start at: (insertAt - count(deleted < insertAt))

            const effectiveInsertPos = insertAt - deleteIndices.filter(x => x < insertAt).length;
            const newPagesCount = newMeta.length - (pageMeta.length - deleteIndices.length);

            const newSelected = new Set<number>();
            for (let i = 0; i < newPagesCount; i++) { newSelected.add(effectiveInsertPos + i); }

            setSelectedPages(newSelected); setScrollSignal({ index: effectiveInsertPos, timestamp: Date.now() });
            setIsFileLoading(false);
        } catch (e) { console.error(e); setIsFileLoading(false); }
    }, [selectedPages, pageMeta.length]);

    const handleExport = useCallback(async (mode: 'single' | 'individual') => {
        if (selectedPages.size === 0) return;
        try {
            const path = await invoke<string | null>("pick_save_path");
            if (!path) return;
            setIsSaving(true);
            const indices = Array.from(selectedPages).sort((a, b) => a - b);
            if (mode === 'single') { await invoke("save_document", { path, indices }); }
            else { await invoke("export_individual_pages", { basePath: path, indices }); }
            setIsSaving(false); setToastMessage(mode === 'single' ? "Exported Combined PDF" : `Exported ${indices.length} files`);
            setShowToast(true); setTimeout(() => setShowToast(false), 3000);
        } catch (e) { console.error(e); setIsSaving(false); }
    }, [selectedPages]);

    const handleReorder = useCallback(async (from: number, to: number) => {
        if (from === to) return;
        try {
            const indices = selectedPages.has(from) ? Array.from(selectedPages).sort((a, b) => a - b) : [from];
            setProcessingIndices(new Set(indices));

            // Calculate affected range for visual feedback
            const minIdx = Math.min(from, to);
            const maxIdx = Math.max(from, to);
            setAffectedRange([minIdx, maxIdx]);

            let response: ReorderResponse;

            if (selectedPages.has(from)) {
                response = await invoke<ReorderResponse>("reorder_pages", { indices, from, to });
                const newSelected = new Set<number>();
                for (let i = 0; i < indices.length; i++) { newSelected.add(response.final_index + i); }
                setSelectedPages(newSelected);
            } else {
                setSelectedPages(new Set());
                response = await invoke<ReorderResponse>("reorder_pages", { indices, from, to });
            }

            setPageMeta(response.metadata);
            setDocId(Date.now());
            setScrollSignal({ index: response.final_index, timestamp: Date.now() });

            const anns = await invoke<AnnotationData[] | null>("get_all_annotations");
            setAnnotations(anns || []);
            if (searchQuery) executeSearch(searchQuery);

        } catch (e) {
            console.error(e);
        } finally {
            setProcessingIndices(new Set());
            setAffectedRange(null);
        }
    }, [selectedPages, searchQuery, executeSearch, pageMeta]);

    const handleRenamePage = useCallback(async (index: number, newName: string) => {
        if (!newName.trim()) return setRenamingIndex(null);
        try {
            const newMeta = await invoke<PageMetadata[]>("rename_page", { index, name: newName });
            setPageMeta(newMeta); setRenamingIndex(null);
        } catch (e) { console.error(e); }
    }, []);

    const handleRotate = useCallback(async (index: number) => {
        try {
            const newMeta = await invoke<PageMetadata[]>("rotate_pages", { indices: [index] });
            setPageMeta(newMeta); setDocId(Date.now());
        } catch (e) { console.error(e); }
    }, []);

    const handleDelete = useCallback(async (index: number) => { setDeleteTarget(index); }, []);

    const handleScaleChange = useCallback((newScale: number) => {
        const s = Math.min(Math.max(0.1, newScale), 5.0);
        setScale(s); setTempScale(Math.round(s * 100).toString());
    }, []);

    const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { const val = parseInt(tempScale); if (!isNaN(val)) handleScaleChange(val / 100); }
    };

    const scrollToPage = useCallback((index: number) => {
        setScrollSignal({ index, timestamp: Date.now() }); setCurrentPage(index);
    }, []);

    const handlePageItemClick = useCallback((index: number, e: React.MouseEvent) => {
        if (viewMode === 'organizer') { handleToggleSelect(index, e.shiftKey, e.ctrlKey || e.metaKey); }
        else { scrollToPage(index); }
    }, [viewMode, handleToggleSelect, scrollToPage]);

    const handleAnnotationClick = useCallback((ann: AnnotationData) => {
        setFocusedAnnotation(ann); setFocusedSearchResult(null);
        setScrollSignal({ index: ann.page_index, timestamp: Date.now(), annotation: ann });
        setCurrentPage(ann.page_index);
    }, []);

    const handleSearchResultClick = useCallback((result: SearchResult) => {
        setFocusedSearchResult(result); setFocusedAnnotation(null);
        setScrollSignal({ index: result.page_index, timestamp: Date.now(), searchResult: result });
        setCurrentPage(result.page_index);
    }, []);

    const handleToggleRightPanel = useCallback((tab: 'annotations' | 'search') => {
        if (!showRightPanel) { setShowRightPanel(true); setRightPanelTab(tab); if (tab === 'search') setTimeout(() => searchInputRef.current?.focus(), 50); }
        else if (rightPanelTab === tab) { setShowRightPanel(false); }
        else { setRightPanelTab(tab); if (tab === 'search') setTimeout(() => searchInputRef.current?.focus(), 50); }
    }, [showRightPanel, rightPanelTab]);

    const handleMouseUp = useCallback(() => {
        setTimeout(() => {
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) {
                const text = selection.toString().trim();
                if (text) { const range = selection.getRangeAt(0); const rect = range.getBoundingClientRect(); setSelectionInfo({ x: rect.left + rect.width / 2, y: rect.top - 40, text }); return; }
            }
            setSelectionInfo(null);
        }, 10);
    }, []);

    const handleCopySelection = useCallback(async () => {
        if (selectionInfo) { await navigator.clipboard.writeText(selectionInfo.text); setSelectionInfo(null); window.getSelection()?.removeAllRanges(); setToastMessage("Text Copied"); setShowToast(true); setTimeout(() => setShowToast(false), 2000); }
    }, [selectionInfo]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === 'z') { e.preventDefault(); handleUndo(); }
            if (e.ctrlKey && e.key === 'f') { e.preventDefault(); handleToggleRightPanel('search'); }
            if (e.key === 'Delete' && selectedPages.size > 0 && viewMode === 'organizer') { e.preventDefault(); handleBatchDelete(); }
        };
        const disableContextMenu = (e: MouseEvent) => e.preventDefault();
        window.addEventListener('keydown', handleKeyDown); window.addEventListener('contextmenu', disableContextMenu); window.addEventListener('mouseup', handleMouseUp);
        const handleWheel = (e: WheelEvent) => {
            if (e.ctrlKey) {
                e.preventDefault(); const delta = e.deltaY > 0 ? 0.9 : 1.1;
                setScale(prev => { const newS = Math.min(Math.max(0.1, prev * delta), 5.0); setTempScale(Math.round(newS * 100).toString()); return newS; });
            }
        };
        window.addEventListener("wheel", handleWheel, { passive: false });
        return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('contextmenu', disableContextMenu); window.removeEventListener('mouseup', handleMouseUp); window.removeEventListener("wheel", handleWheel); };
    }, [handleUndo, handleToggleRightPanel, handleBatchDelete, handleMouseUp, selectedPages.size, viewMode]);

    return (
        <div className="flex flex-col h-screen bg-neutral-900 text-white overflow-hidden font-sans relative">
            {selectionInfo && (
                <div className="fixed z-[100] transform -translate-x-1/2 flex items-center bg-blue-600 rounded shadow-2xl p-1 animate-in fade-in zoom-in duration-200" style={{ left: selectionInfo.x, top: selectionInfo.y }}>
                    <button onClick={handleCopySelection} className="flex items-center gap-2 px-3 py-1 hover:bg-blue-500 rounded text-sm font-bold text-white transition-colors"><Copy size={14} /> Copy</button>
                </div>
            )}
            {deleteTarget !== null && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl p-6 max-w-sm w-full transform transition-all scale-100">
                        <h3 className="text-lg font-semibold text-white mb-2">Confirm Delete</h3>
                        <p className="text-neutral-400 mb-6 text-sm">Are you sure you want to delete {Array.isArray(deleteTarget) ? `${deleteTarget.length} pages` : `Page ${deleteTarget + 1}`}?</p>
                        <div className="flex justify-end gap-3">
                            <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 rounded text-neutral-300 hover:bg-neutral-700 transition-colors text-sm">Cancel</button>
                            <button onClick={confirmDelete} className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-white font-medium transition-colors text-sm">Delete</button>
                        </div>
                    </div>
                </div>
            )}
            {passwordModalPath !== null && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl p-6 max-w-sm w-full transform transition-all scale-100">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                                <AlertCircle size={20} className="text-amber-400" />
                            </div>
                            <div>
                                <h3 className="text-lg font-semibold text-white">Password Protected</h3>
                                <p className="text-neutral-500 text-xs truncate max-w-[200px]">{passwordModalPath.split(/[\/\\]/).pop()}</p>
                            </div>
                        </div>
                        <p className="text-neutral-400 mb-4 text-sm">This document is password protected. Please enter your password to unlock.</p>
                        {passwordError && (
                            <div className="bg-red-900/30 border border-red-700 text-red-400 text-xs px-3 py-2 rounded mb-4">
                                {passwordError}
                            </div>
                        )}
                        <input
                            type="password"
                            autoFocus
                            placeholder="Enter password..."
                            value={passwordInput}
                            onChange={(e) => setPasswordInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handlePasswordSubmit(); if (e.key === 'Escape') handlePasswordCancel(); }}
                            className="w-full bg-neutral-900 border border-neutral-600 rounded px-3 py-2 text-white text-sm mb-4 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                        <div className="flex justify-end gap-3">
                            <button onClick={handlePasswordCancel} className="px-4 py-2 rounded text-neutral-300 hover:bg-neutral-700 transition-colors text-sm">Cancel</button>
                            <button onClick={handlePasswordSubmit} disabled={!passwordInput} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-600 disabled:cursor-not-allowed text-white font-medium transition-colors text-sm">Unlock</button>
                        </div>
                    </div>
                </div>
            )}
            <div className={`fixed left-1/2 -translate-x-1/2 bottom-12 z-[60] transition-all duration-300 transform ${showToast ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0 pointer-events-none'}`}>
                <div className="bg-neutral-900 border border-neutral-700 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-4 whitespace-nowrap">
                    <span className="text-sm font-medium">{toastMessage}</span>
                    {(toastMessage.includes("deleted")) && (
                        <button onClick={handleUndo} className="text-blue-400 hover:text-blue-300 font-bold text-sm uppercase tracking-wide px-2 py-1 hover:bg-neutral-800 rounded transition-colors">Undo</button>
                    )}
                    <button onClick={() => setShowToast(false)} className="text-neutral-500 hover:text-white ml-2">✕</button>
                </div>
            </div>
            {(isFileLoading || isSaving) && (
                <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80 backdrop-blur-md">
                    <Loader2 className="w-16 h-16 text-blue-500 animate-spin mb-6" />
                    <p className="text-2xl font-light tracking-widest text-white uppercase">{isSaving ? "SAVING DOCUMENT" : "OPENING DOCUMENT"}</p>
                </div>
            )}

            {/* 3-Column Grid Toolbar for Absolute Centering */}
            <div className="grid grid-cols-[1fr_auto_1fr] px-4 items-center bg-neutral-800 border-b border-neutral-700 shadow-md z-10 h-12 flex-shrink-0">
                <div className="flex items-center gap-2 justify-self-start">
                    <button onClick={() => setShowLeftPanel(!showLeftPanel)} className={`p-1.5 rounded-md hover:bg-neutral-700 transition-colors ${showLeftPanel ? 'bg-neutral-700 text-blue-400' : 'text-neutral-400'}`} title="Toggle Sidebar"><Book size={18} /></button>
                    <div className="h-6 w-px bg-neutral-700 mx-1"></div>
                    <button onClick={openFile} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${currentFile ? 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}>
                        <FolderOpen size={16} /> <span className="hidden md:inline">Open</span>
                    </button>
                    {currentFile && (
                        <button onClick={handleSave} className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-md text-sm font-medium transition-colors shadow-lg active:scale-95">
                            <Save size={16} /> <span className="hidden md:inline">Save</span>
                        </button>
                    )}
                </div>

                <div className="flex items-center justify-center">
                    {currentFile && (
                        <div className="flex bg-neutral-900 rounded-lg p-1 border border-neutral-700 shadow-inner h-9 items-center">
                            <button onClick={() => setViewMode('reader')} className={`h-7 px-3 rounded flex items-center gap-2 transition-all ${viewMode === 'reader' ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-neutral-200'}`} title="Reader View">
                                <ListIcon size={14} /><span className="text-xs font-medium hidden md:inline">Read</span>
                            </button>
                            <button onClick={() => setViewMode('organizer')} className={`h-7 px-3 rounded flex items-center gap-2 transition-all ${viewMode === 'organizer' ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-neutral-200'}`} title="Organizer View">
                                <Grid size={14} /><span className="text-xs font-medium hidden md:inline">Grid</span>
                            </button>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2 justify-self-end">
                    <div className={`items-center gap-2 mr-2 text-sm font-mono text-neutral-400 bg-neutral-900/50 px-2 py-1 rounded border border-neutral-700/50 ${viewMode === 'organizer' ? 'hidden xl:flex' : 'hidden sm:flex'}`}>
                        <input type="text" value={pageMeta.length > 0 ? currentPage + 1 : 0} onChange={(e) => { const val = parseInt(e.target.value); if (!isNaN(val) && val >= 1 && val <= pageMeta.length) scrollToPage(val - 1); }} className="w-10 bg-transparent text-center focus:text-blue-400 outline-none text-white" />
                        <span className="text-neutral-600">/</span><span>{pageMeta.length}</span>
                    </div>
                    {viewMode === 'reader' && (
                        <div className="hidden md:flex items-center gap-1">
                            <button onClick={() => handleScaleChange(scale - 0.1)} className="p-1.5 hover:bg-neutral-700 rounded-md transition-colors text-neutral-400"><ZoomOut size={18} /></button>
                            <input type="text" value={tempScale} onChange={(e) => setTempScale(e.target.value)} onKeyDown={handleInputKeyDown} onBlur={() => handleInputKeyDown({ key: 'Enter' } as any)} className="w-10 bg-neutral-900 border border-neutral-600 rounded px-1 text-center text-[10px] focus:ring-1 focus:ring-blue-500 outline-none text-white" />
                            <button onClick={() => handleScaleChange(scale + 0.1)} className="p-1.5 hover:bg-neutral-700 rounded-md transition-colors text-neutral-400"><ZoomIn size={18} /></button>
                        </div>
                    )}
                    <div className="h-6 w-px bg-neutral-700 mx-1 flex-shrink-0"></div>
                    <button onClick={() => handleToggleRightPanel('annotations')} className={`p-1.5 rounded-md hover:bg-neutral-700 transition-colors relative ${showRightPanel && rightPanelTab === 'annotations' ? 'bg-neutral-700 text-blue-400' : 'text-neutral-400'}`} title="Toggle Annotations"><MessageSquare size={18} />{annotations.filter(a => a.subtype !== 'Link').length > 0 && <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full border border-neutral-800"></span>}</button>
                    <button onClick={() => handleToggleRightPanel('search')} className={`p-1.5 rounded-md hover:bg-neutral-700 transition-colors relative ${showRightPanel && rightPanelTab === 'search' ? 'bg-neutral-700 text-blue-400' : 'text-neutral-400'}`} title="Search Results"><Search size={18} />{(searchResults.length > 0 || searchQuery) && <span className="absolute top-1 right-1 px-1 min-w-[12px] h-3 bg-amber-500 rounded-full text-[8px] flex items-center justify-center text-white border border-neutral-800 font-bold">{searchResults.length}</span>}</button>
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden relative">
                {currentFile && (
                    <div className={`bg-neutral-800 border-r border-neutral-700 flex flex-col flex-shrink-0 transition-all duration-300 ease-in-out ${showLeftPanel ? 'w-64 opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
                        <div className="p-2 text-xs font-bold text-neutral-500 uppercase tracking-wider flex items-center gap-2 border-b border-neutral-700 whitespace-nowrap"><FileText size={14} /> Navigation</div>
                        <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">
                            <div className="flex flex-col">
                                {pageMeta.map((meta, i) => {
                                    // In Reader mode, only show pages with bookmarks
                                    if (viewMode === 'reader' && !meta.has_bookmark) return null;
                                    const isSelected = selectedPages.has(i) && viewMode === 'organizer';
                                    const isCurrent = viewMode === 'reader' && currentPage === i;
                                    return (
                                        <div key={i} onClick={(e) => handlePageItemClick(i, e)} className={`px-4 py-2 text-sm cursor-pointer border-l-2 transition-all flex items-center justify-between group/item
                                    ${isSelected ? 'bg-amber-900/20 border-amber-500 text-amber-400' :
                                                isCurrent ? 'bg-blue-900/20 border-blue-500 text-blue-400' : 'border-transparent text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200'}
                                  `}>
                                            <div className="flex items-center gap-3 overflow-hidden">
                                                <span className="font-mono text-[10px] opacity-50 flex-shrink-0">{i + 1}</span>
                                                {renamingIndex === i ? (
                                                    <input autoFocus className="bg-neutral-700 text-white text-xs px-1 rounded outline-none border border-blue-500 w-full" value={renamingValue} onChange={e => setRenamingValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRenamePage(i, renamingValue); if (e.key === 'Escape') setRenamingIndex(null); }} onBlur={() => handleRenamePage(i, renamingValue)} onClick={e => e.stopPropagation()} />
                                                ) : (
                                                    <span className="truncate text-xs">{meta.name}</span>
                                                )}
                                            </div>
                                            <button onClick={(e) => { e.stopPropagation(); setRenamingIndex(i); setRenamingValue(meta.name); }} className="p-1 opacity-0 group-hover/item:opacity-100 hover:bg-neutral-600 rounded transition-all"><Edit2 size={12} /></button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex-1 flex flex-col overflow-hidden relative">
                    {!currentFile ? (
                        <EmptyState isFileLoading={isFileLoading} />
                    ) : viewMode === 'reader' ? (
                        <ReaderView key={fileSessionId} pageMeta={pageMeta} scale={scale} renderScale={renderScale} docId={docId} error={error} currentPage={currentPage} setCurrentPage={setCurrentPage} scrollSignal={scrollSignal} onScrollComplete={() => setScrollSignal(null)} initialScrollTop={readerScrollTop} onScrollTopChange={setReaderScrollTop} annotations={annotations} focusedAnnotation={focusedAnnotation} focusedSearchResult={focusedSearchResult} />
                    ) : (
                        <div className="relative flex-1">
                            <OrganizerView
                                key={fileSessionId}
                                pageMeta={pageMeta} docId={docId} currentPage={currentPage} selectedPages={selectedPages}
                                processingIndices={processingIndices} affectedRange={affectedRange}
                                onToggleSelect={handleToggleSelect} onClearSelection={handleClearSelection}
                                onRotate={handleRotate} onDelete={handleDelete} onReorder={handleReorder} onRename={handleRenamePage}
                            />
                            <OrganizePill
                                selectedCount={selectedPages.size}
                                onImport={handleImport}
                                onRotate={handleBatchRotate}
                                onDelete={handleBatchDelete}
                                onExport={handleExport}
                                onClear={handleClearSelection}
                            />
                        </div>
                    )}
                </div>

                {currentFile && (
                    <div className={`bg-neutral-800 border-l border-neutral-700 flex flex-col flex-shrink-0 transition-all duration-300 ease-in-out ${showRightPanel ? 'w-72 opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
                        <div className="flex border-b border-neutral-700 h-10 flex-shrink-0">
                            <button onClick={() => setRightPanelTab('annotations')} className={`flex-1 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${rightPanelTab === 'annotations' ? 'text-blue-400 bg-neutral-900/50 border-b-2 border-blue-500' : 'text-neutral-500 hover:text-neutral-300'}`}><MessageSquare size={14} /> ({annotations.filter(a => a.subtype !== 'Link').length})</button>
                            <button onClick={() => setRightPanelTab('search')} className={`flex-1 text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${rightPanelTab === 'search' ? 'text-amber-400 bg-neutral-900/50 border-b-2 border-amber-500' : 'text-neutral-500 hover:text-neutral-300'}`}><Search size={14} /> ({searchResults.length})</button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
                            {rightPanelTab === 'annotations' ? (
                                annotations.filter(a => a.subtype !== 'Link').length === 0 ? <div className="text-center text-neutral-500 text-sm mt-4">No Annotations</div> :
                                    annotations.filter(a => a.subtype !== 'Link').map((ann, i) => (
                                        <div key={i} onClick={() => handleAnnotationClick(ann)} className={`p-3 rounded border text-sm cursor-pointer transition-all ${ann === focusedAnnotation ? 'bg-blue-900 border-blue-500 ring-1 ring-blue-500' : 'bg-neutral-800 border-neutral-700 hover:border-blue-500 hover:ring-1 hover:ring-blue-500'}`}>
                                            <div className="flex justify-between items-center mb-1"><span className="text-blue-400 font-bold text-xs">{ann.subtype}</span><span className="text-neutral-500 text-xs">P. {ann.page_index + 1}</span></div>
                                            <div className="text-neutral-200 break-words whitespace-pre-wrap line-clamp-4">{ann.content || <span className="italic text-neutral-500">No content</span>}</div>
                                        </div>
                                    ))
                            ) : (<div className="flex flex-col gap-3">
                                <div className="flex items-center bg-neutral-900 border border-neutral-700 rounded-lg px-3 h-10 gap-2 focus-within:ring-2 focus-within:ring-amber-500/50 focus-within:border-amber-500 transition-all mb-2">
                                    {isSearching ? <Loader2 size={14} className="text-amber-400 animate-spin flex-shrink-0" /> : <Search size={14} className="text-neutral-500 flex-shrink-0" />}
                                    <input ref={searchInputRef} type="text" placeholder="Search in document..." className="bg-transparent border-none outline-none text-xs flex-1 text-white placeholder-neutral-600 h-full" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && executeSearch(searchQuery)} />
                                    {(searchQuery || searchResults.length > 0) && <button onClick={handleClearSearch} className="text-neutral-500 hover:text-white p-1 rounded-full hover:bg-neutral-700 transition-colors"><X size={14} /></button>}
                                </div>
                                {isSearching ? <div className="flex flex-col items-center justify-center py-10 text-neutral-500 gap-4"><Loader2 className="animate-spin" /> Searching...</div> :
                                    searchResults.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-10 text-neutral-500 gap-2">
                                            <AlertCircle size={24} className="opacity-20" /><div className="text-center text-sm">{searchQuery ? "No matches found" : "Enter text above to search"}</div>
                                        </div>
                                    ) :
                                        searchResults.map((res, i) => (
                                            <div key={i} onClick={() => handleSearchResultClick(res)} className={`p-3 rounded border text-sm cursor-pointer transition-all ${res === focusedSearchResult ? 'bg-amber-900/30 border-amber-500 ring-1 ring-amber-500' : 'bg-neutral-800 border-neutral-700 hover:border-amber-500 hover:ring-1 hover:ring-amber-500'}`}>
                                                <div className="flex justify-between items-center mb-1"><span className="text-amber-400 font-bold text-[10px] uppercase tracking-tighter">Match {i + 1}</span><span className="text-neutral-500 text-xs">P. {res.page_index + 1}</span></div>
                                                <div className="text-neutral-200 line-clamp-2 italic font-serif text-xs leading-relaxed">"...{res.text}..."</div>
                                            </div>
                                        ))}
                            </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;