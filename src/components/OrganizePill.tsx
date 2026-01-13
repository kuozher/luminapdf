import { Plus, RotateCw, Trash2, Download, FileStack, Files, ChevronUp, X } from "lucide-react";
import { useState, useRef, useEffect } from "react";

interface OrganizePillProps {
    selectedCount: number;
    onImport: (mode: 'start' | 'before' | 'after' | 'replace' | 'end') => void;
    onRotate: () => void;
    onDelete: () => void;
    onExport: (mode: 'single' | 'individual') => void;
    onClear: () => void;
}

export default function OrganizePill({ selectedCount, onImport, onRotate, onDelete, onExport, onClear }: OrganizePillProps) {
    const [showImportMenu, setShowImportMenu] = useState(false);
    const [showExportMenu, setShowExportMenu] = useState(false);
    
    const importBtnRef = useRef<HTMLButtonElement>(null);
    const exportBtnRef = useRef<HTMLButtonElement>(null);
    const importMenuRef = useRef<HTMLDivElement>(null);
    const exportMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            // Exclusion logic: if click is on button or inside menu, don't trigger global close
            if (importBtnRef.current?.contains(target) || importMenuRef.current?.contains(target)) return;
            if (exportBtnRef.current?.contains(target) || exportMenuRef.current?.contains(target)) return;
            
            setShowImportMenu(false);
            setShowExportMenu(false);
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const hasSelection = selectedCount > 0;

    return (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 pointer-events-none">
            <div className="bg-neutral-900/80 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl p-1.5 flex items-center gap-1 pointer-events-auto">
                
                {/* Import Section with Relative Anchor */}
                <div className="relative">
                    {showImportMenu && (
                        <div ref={importMenuRef} className="absolute bottom-full left-0 mb-3 bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl p-1 animate-in fade-in slide-in-from-bottom-2 duration-200 w-48 overflow-hidden">
                            <button onClick={() => { onImport('start'); setShowImportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-blue-600 rounded text-xs transition-colors">To Beginning</button>
                            {hasSelection && (
                                <>
                                    <button onClick={() => { onImport('before'); setShowImportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-blue-600 rounded text-xs transition-colors border-t border-white/5">Before Selection</button>
                                    <button onClick={() => { onImport('after'); setShowImportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-blue-600 rounded text-xs transition-colors">After Selection</button>
                                    <button onClick={() => { onImport('replace'); setShowImportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-red-600 rounded text-xs transition-colors font-bold text-red-400 hover:text-white border-t border-white/5">Replace Selection</button>
                                </>
                            )}
                            <button onClick={() => { onImport('end'); setShowImportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-blue-600 rounded text-xs transition-colors border-t border-white/5">To End</button>
                        </div>
                    )}
                    <button 
                        ref={importBtnRef}
                        onClick={() => { setShowImportMenu(!showImportMenu); setShowExportMenu(false); }}
                        className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all ${showImportMenu ? 'bg-blue-600 text-white' : 'hover:bg-white/10 text-neutral-300'}`}
                    >
                        <Plus size={18} />
                        <span className="text-xs font-bold hidden md:inline">Import</span>
                        <ChevronUp size={14} className={`opacity-50 transition-transform ${showImportMenu ? 'rotate-180' : ''}`} />
                    </button>
                </div>

                {hasSelection && (
                    <>
                        <div className="w-px h-6 bg-white/10 mx-1"></div>
                        <button onClick={onRotate} className="p-2 hover:bg-white/10 rounded-full text-neutral-300 flex items-center gap-2 transition-colors" title="Rotate">
                            <RotateCw size={18} /><span className="text-xs font-bold hidden md:inline">Rotate</span>
                        </button>
                        <button onClick={onDelete} className="p-2 hover:bg-red-600/20 hover:text-red-400 rounded-full text-neutral-300 flex items-center gap-2 transition-colors" title="Delete">
                            <Trash2 size={18} /><span className="text-xs font-bold hidden md:inline">Delete</span>
                        </button>

                        {/* Export Section with Relative Anchor */}
                        <div className="relative">
                            {showExportMenu && (
                                <div ref={exportMenuRef} className="absolute bottom-full right-0 mb-3 bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl p-1 animate-in fade-in slide-in-from-bottom-2 duration-200 w-56 overflow-hidden">
                                    <button onClick={() => { onExport('single'); setShowExportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-blue-600 rounded text-xs flex items-center gap-2 transition-colors"><FileStack size={14}/> Combined File (.pdf)</button>
                                    <button onClick={() => { onExport('individual'); setShowExportMenu(false); }} className="w-full text-left px-4 py-2.5 hover:bg-blue-600 rounded text-xs flex items-center gap-2 transition-colors border-t border-white/5"><Files size={14}/> Individual Pages</button>
                                </div>
                            )}
                            <button 
                                ref={exportBtnRef}
                                onClick={() => { setShowExportMenu(!showExportMenu); setShowImportMenu(false); }}
                                className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all ${showExportMenu ? 'bg-amber-600 text-white' : 'hover:bg-amber-600/20 text-amber-500'}`}
                            >
                                <Download size={18} />
                                <span className="text-xs font-bold hidden md:inline">Export</span>
                                <span className="bg-amber-500/20 px-1.5 py-0.5 rounded text-[10px] ml-1">{selectedCount}</span>
                            </button>
                        </div>

                        <button onClick={onClear} className="p-2 text-neutral-500 hover:text-white transition-colors" title="Clear Selection">
                            <X size={18} />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}