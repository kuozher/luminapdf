import { VirtuosoGrid, GridComponents, VirtuosoGridHandle } from "react-virtuoso";
import { RotateCw, Trash2, Loader2 } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { forwardRef, useMemo, useState, useEffect, useRef } from 'react';

interface PageMetadata {
  width: number;
  height: number;
  rotation: number;
  name: string;
}

interface OrganizerViewProps {
  pageMeta: PageMetadata[];
  docId: number;
  currentPage: number;
  selectedPages: Set<number>;
  processingIndices?: Set<number>;
  affectedRange?: [number, number] | null;
  onToggleSelect: (index: number, isShift: boolean, isCtrl: boolean) => void;
  onClearSelection: () => void;
  onRotate: (index: number) => void;
  onDelete: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  onRename: (index: number, newName: string) => void;
}

const StaticList = forwardRef<HTMLDivElement, any>(({ style, children, ...props }, ref) => (
    <div 
        ref={ref} 
        style={{ 
            ...style, 
            display: "grid", 
            gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
            gridAutoRows: "260px",
            gap: "20px", 
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            justifyContent: "center"
        }} 
        {...props}
    >
        {children}
    </div>
));

const StaticItem = forwardRef<HTMLDivElement, any>(({ children, ...props }, ref) => (
    <div ref={ref} {...props} style={{ width: "100%", height: "100%", position: "relative" }}>
        {children}
    </div>
));

const StaticScroller = forwardRef<HTMLDivElement, any>(({ style, children, ...props }, ref) => (
    <div ref={ref} style={{ ...style, padding: "20px 20px 40px 20px", boxSizing: "border-box", overflowX: "hidden" }} {...props}>
        {children}
    </div>
));

const gridComponents: GridComponents<any> = {
    List: StaticList,
    Item: StaticItem,
    Scroller: StaticScroller
};

const GridItemContent = ({ index, pageMeta, docId, onRotate, onDelete, isDragging, isOverlay, isSelected, isProcessing, isAffected, hideControls, selectedPages, onToggleSelect }: {
    index: number,
    pageMeta: PageMetadata[],
    docId: number,
    onRotate?: (index: number) => void,
    onDelete?: (index: number) => void,
    isDragging?: boolean,
    isOverlay?: boolean,
    isSelected?: boolean,
    isProcessing?: boolean,
    isAffected?: boolean,
    hideControls?: boolean,
    selectedPages: Set<number>,
    onToggleSelect?: (index: number, isShift: boolean, isCtrl: boolean) => void
}) => {
    const thumbScale = 0.2;
    const meta = pageMeta[index];
    if (!meta) return null;
    
    const pageUrl = `http://pdf-page.localhost/render?page=${index}&scale=${thumbScale}&docId=${docId}&dpr=1.0`;
    const cellWidth = 180;
    const cellHeight = 220;

    return (
        <div className={`flex flex-col items-center justify-center h-full w-full transition-opacity ${isDragging && !isOverlay ? "opacity-10" : "opacity-100"}`}>
            <div 
                style={{ width: cellWidth, height: cellHeight }}
                onClick={(e) => {
                    if (onToggleSelect) {
                        e.stopPropagation();
                        onToggleSelect(index, e.shiftKey, e.ctrlKey || e.metaKey);
                    }
                }}
                className={`relative group transition-all rounded flex items-center justify-center border-2 bg-neutral-800/20 touch-none
                    ${isOverlay ? "shadow-2xl ring-2 ring-blue-500 scale-105 cursor-grabbing bg-neutral-800 border-blue-500" : "cursor-grab"}
                    ${isSelected 
                        ? "border-amber-500 ring-2 ring-amber-500/30 bg-amber-900/10 shadow-lg shadow-amber-900/20" 
                        : "border-transparent hover:border-blue-500/50 hover:bg-neutral-800/30"
                    }
                    ${isProcessing ? "opacity-50 pointer-events-none" : ""}
                    ${!isProcessing && isAffected ? "opacity-80 transition-none" : ""} 
                `}
            >
                <div className="shadow-md bg-white overflow-hidden flex items-center justify-center max-w-[90%] max-h-[90%] pointer-events-none select-none">
                    <img 
                        src={pageUrl} 
                        loading="lazy" 
                        style={{ 
                            width: "auto", 
                            height: "auto", 
                            maxWidth: "100%", 
                            maxHeight: "100%", 
                            objectFit: "contain",
                            display: "block" 
                        }} 
                        alt={`Page ${index + 1}`} 
                    />
                </div>

                {isProcessing && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-40">
                        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
                    </div>
                )}
                
                {!isOverlay && !isDragging && !hideControls && !isProcessing && (
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-2 rounded">
                        <div className="flex gap-2 pointer-events-auto">
                            <button 
                                onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} 
                                onClick={(e) => { e.stopPropagation(); onRotate && onRotate(index); }} 
                                className="p-1.5 bg-neutral-700 hover:bg-blue-600 rounded text-white shadow-sm z-20" 
                                title="Rotate"
                            >
                                <RotateCw size={16} />
                            </button>
                            <button 
                                onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} 
                                onClick={(e) => { e.stopPropagation(); onDelete && onDelete(index); }} 
                                className="p-1.5 bg-neutral-700 hover:bg-red-600 rounded text-white shadow-sm z-20" 
                                title="Delete"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    </div>
                )}

                <div className="absolute top-2 left-2 text-white text-[10px] px-1.5 rounded pointer-events-none font-bold bg-black/70 select-none z-10">{index + 1}</div>
                {isSelected && (
                    <div className="absolute top-2 right-2 bg-amber-500 text-neutral-900 rounded-full p-0.5 shadow-sm z-10">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                )}

                {isOverlay && selectedPages.size > 1 && selectedPages.has(index) && (
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-amber-600 text-white text-[10px] font-bold px-3 py-1 rounded-full shadow-2xl border border-white/20 animate-in fade-in zoom-in duration-200 whitespace-nowrap z-30">
                        {selectedPages.size} pages
                    </div>
                )}
            </div>
        </div>
    );
};

const SortableGridItem = ({ index, pageMeta, docId, onRotate, onDelete, isSelected, isProcessing, isAffected, onToggleSelect, hideControls, selectedPages }: {
    index: number,
    pageMeta: PageMetadata[],
    docId: number,
    onRotate: (index: number) => void,
    onDelete: (index: number) => void,
    isSelected: boolean,
    isProcessing: boolean,
    isAffected: boolean,
    onToggleSelect: (index: number, isShift: boolean, isCtrl: boolean) => void,
    hideControls: boolean,
    selectedPages: Set<number>
}) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `page-${index}` });
    
    // Disable transition if this item is part of the affected range during processing
    const activeTransition = isAffected ? "none" : transition;
    
    const style = { 
        transform: CSS.Translate.toString(transform), 
        transition: activeTransition, 
        zIndex: isDragging ? 50 : "auto", 
        height: "100%", 
        width: "100%", 
        touchAction: "none" 
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
            <GridItemContent 
                index={index} pageMeta={pageMeta} docId={docId} onRotate={onRotate} onDelete={onDelete} 
                isDragging={isDragging} isSelected={isSelected} isProcessing={isProcessing} isAffected={isAffected}
                hideControls={hideControls} selectedPages={selectedPages}
                onToggleSelect={onToggleSelect}
            />
        </div>
    );
};

export default function OrganizerView({
    pageMeta, docId, currentPage, selectedPages, processingIndices, affectedRange, onToggleSelect, onClearSelection, onRotate, onDelete, onReorder 
}: OrganizerViewProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const virtuosoRef = useRef<VirtuosoGridHandle>(null);
  const isAnySelected = selectedPages.size > 0;

  useEffect(() => {
      const timer = setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: currentPage, align: 'center' });
      }, 100);
      return () => clearTimeout(timer);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = (event: DragStartEvent) => { setActiveId(event.active.id as string); };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id && over) {
      const oldIndex = parseInt((active.id as string).replace('page-', ''));
      const newIndex = parseInt((over.id as string).replace('page-', ''));
      if (!isNaN(oldIndex) && !isNaN(newIndex)) { onReorder(oldIndex, newIndex); }
    }
    setActiveId(null);
  };

  const itemIds = useMemo(() => pageMeta.map((_, i) => `page-${i}`), [pageMeta.length]);

  return (
      <div className="flex-1 bg-neutral-900 h-full overflow-x-hidden" onClick={onClearSelection}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>              <SortableContext items={itemIds} strategy={rectSortingStrategy}>
                  <VirtuosoGrid
                      ref={virtuosoRef}
                      style={{ height: '100%', width: '100%' }} 
                      totalCount={pageMeta.length} 
                      overscan={1000} 
                      components={gridComponents}
                      itemContent={(index) => (
                          <SortableGridItem 
                            index={index} pageMeta={pageMeta} docId={docId} onRotate={onRotate} onDelete={onDelete}
                            isSelected={selectedPages.has(index)} 
                            isProcessing={processingIndices?.has(index) || false}
                            isAffected={affectedRange ? index >= affectedRange[0] && index <= affectedRange[1] : false}
                            onToggleSelect={onToggleSelect} hideControls={isAnySelected} selectedPages={selectedPages}
                          />
                      )}
                  />
              </SortableContext>
              <DragOverlay adjustScale={true} dropAnimation={null}>
                  {activeId ? (
                      <GridItemContent 
                          index={parseInt(activeId.replace('page-', ''))}
                          pageMeta={pageMeta} docId={docId} isOverlay={true}
                          isSelected={selectedPages.has(parseInt(activeId.replace('page-', '')))}
                          hideControls={isAnySelected} selectedPages={selectedPages}
                      />
                  ) : null}
              </DragOverlay>
          </DndContext>
      </div>
  );
}