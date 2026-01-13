import { FileStack, Loader2 } from "lucide-react";

export default function EmptyState({ isFileLoading }: { isFileLoading: boolean }) {
    if (isFileLoading) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 bg-neutral-900">
                <Loader2 size={48} className="text-blue-500 animate-spin mb-6" />
                <p className="text-lg font-light tracking-widest uppercase text-white">Opening Document...</p>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 bg-neutral-900 overflow-hidden">
            <div className="w-24 h-24 mb-6 rounded-2xl bg-neutral-800 flex items-center justify-center shadow-inner">
                <FileStack size={40} className="opacity-20" />
            </div>
            <p className="text-lg font-light tracking-widest uppercase">No Document Open</p>
            <p className="text-xs mt-2 opacity-40">Select a PDF file to begin reading</p>
        </div>
    );
}