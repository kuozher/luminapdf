import { useState } from 'react';
import { X, Image as ImageIcon } from 'lucide-react';

interface ExportImageModalProps {
    isOpen: boolean;
    onClose: () => void;
    onExport: (settings: ExportSettings) => void;
    currentPage: number;
    totalPages: number;
}

export interface ExportSettings {
    scope: 'current' | 'all' | 'custom';
    customRange: string;
    format: 'png' | 'jpg' | 'webp';
}

export default function ExportImageModal({ isOpen, onClose, onExport, currentPage, totalPages }: ExportImageModalProps) {
    const [scope, setScope] = useState<'current' | 'all' | 'custom'>('current');
    const [customRange, setCustomRange] = useState("");
    const [format, setFormat] = useState<'png' | 'jpg' | 'webp'>('png');

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center text-blue-400">
                            <ImageIcon size={20} />
                        </div>
                        <h3 className="text-lg font-semibold text-white">Export to Image</h3>
                    </div>
                    <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <div className="space-y-6">
                    {/* Page Range Selection */}
                    <div>
                        <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3 block">Page Range</label>
                        <div className="space-y-3">
                            <label className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-all ${scope === 'current' ? 'bg-blue-600/10 border-blue-600/50' : 'bg-neutral-700/30 border-neutral-700 hover:bg-neutral-700'}`}>
                                <input type="radio" name="scope" value="current" checked={scope === 'current'} onChange={() => setScope('current')} className="w-4 h-4 text-blue-500 bg-neutral-800 border-neutral-600 focus:ring-blue-500 focus:ring-offset-neutral-900" />
                                <span className="text-sm text-neutral-200">Current Page <span className="text-neutral-500">({currentPage + 1})</span></span>
                            </label>

                            <label className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-all ${scope === 'all' ? 'bg-blue-600/10 border-blue-600/50' : 'bg-neutral-700/30 border-neutral-700 hover:bg-neutral-700'}`}>
                                <input type="radio" name="scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} className="w-4 h-4 text-blue-500 bg-neutral-800 border-neutral-600 focus:ring-blue-500 focus:ring-offset-neutral-900" />
                                <span className="text-sm text-neutral-200">All Pages <span className="text-neutral-500">({totalPages})</span></span>
                            </label>

                            <label className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-all ${scope === 'custom' ? 'bg-blue-600/10 border-blue-600/50' : 'bg-neutral-700/30 border-neutral-700 hover:bg-neutral-700'}`}>
                                <input type="radio" name="scope" value="custom" checked={scope === 'custom'} onChange={() => setScope('custom')} className="w-4 h-4 text-blue-500 bg-neutral-800 border-neutral-600 focus:ring-blue-500 focus:ring-offset-neutral-900" />
                                <span className="text-sm text-neutral-200">Custom Range</span>
                            </label>

                            {scope === 'custom' && (
                                <div className="ml-7 animate-in slide-in-from-top-2 fade-in duration-200">
                                    <input
                                        type="text"
                                        placeholder="e.g. 1, 3-5, 8"
                                        value={customRange}
                                        onChange={(e) => setCustomRange(e.target.value)}
                                        className="w-full bg-neutral-900 border border-neutral-600 rounded px-3 py-2 text-sm text-white focus:ring-1 focus:ring-blue-500 outline-none"
                                    />
                                    <p className="text-[10px] text-neutral-500 mt-1">Use commas for specific pages and hyphens for ranges.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Format Selection */}
                    <div>
                        <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3 block">Format</label>
                        <div className="flex gap-2">
                            {(['png', 'jpg', 'webp'] as const).map((fmt) => (
                                <button
                                    key={fmt}
                                    onClick={() => setFormat(fmt)}
                                    className={`px-4 py-2 rounded-md text-sm font-medium border transition-all flex-1 ${format === fmt ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-700/30 border-neutral-700 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}
                                >
                                    {fmt.toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="mt-8 flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 rounded text-neutral-300 hover:bg-neutral-700 transition-colors text-sm">Cancel</button>
                    <button
                        onClick={() => onExport({ scope, customRange, format })}
                        className="px-6 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors text-sm flex items-center gap-2 shadow-lg shadow-blue-900/20"
                    >
                        Save Images
                    </button>
                </div>
            </div>
        </div>
    );
}
