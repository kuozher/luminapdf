import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { AlertCircle, MessageSquare } from "lucide-react";

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

interface ReaderViewProps {
  pageMeta: { width: number; height: number; rotation: number }[];
  scale: number;
  renderScale: number;
  docId: number;
  error: string | null;
  currentPage: number;
  setCurrentPage: (index: number) => void;
  scrollSignal: { index: number; timestamp: number; annotation?: AnnotationData; searchResult?: SearchResult } | null;
  onScrollComplete?: () => void;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  annotations: AnnotationData[];
  focusedAnnotation: AnnotationData | null;
  focusedSearchResult: SearchResult | null;
  onAnnotationClick: (annotation: AnnotationData) => void;
}

export default function ReaderView({
  pageMeta, scale, renderScale, docId, error,
  currentPage, setCurrentPage, scrollSignal, onScrollComplete, initialScrollTop, onScrollTopChange,
  annotations, focusedAnnotation, focusedSearchResult, onAnnotationClick
}: ReaderViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const ignoreScrollUntil = useRef<number>(0);
  const isInitialMount = useRef(true);
  const [hoveredAnnotation, setHoveredAnnotation] = useState<AnnotationData | null>(null);

  // Force scroll to top when new file is loaded (component mounts with new fileSessionId)
  // Only scroll once when pageMeta first becomes available
  useEffect(() => {
    if (isInitialMount.current && virtuosoRef.current && pageMeta.length > 0) {
      virtuosoRef.current.scrollToIndex({ index: 0, align: "start", behavior: "auto" });
      isInitialMount.current = false;
    }
  }, [pageMeta.length]);

  const handleSetCurrentPage = useCallback((index: number) => {
    if (Date.now() < ignoreScrollUntil.current) return;
    setCurrentPage(index);
  }, [setCurrentPage]);

  useEffect(() => {
    if (scrollSignal && virtuosoRef.current) {
      ignoreScrollUntil.current = Date.now() + 1200;

      setTimeout(() => {
        let align: "center" | "start" = "center";
        let offset = 0;

        const target = scrollSignal.annotation || (scrollSignal.searchResult ? {
          rect: scrollSignal.searchResult.rects[0],
          page_height: pageMeta[scrollSignal.index].height
        } : null);

        if (target) {
          const viewportHeight = window.innerHeight;
          const { rect, page_height } = target;
          const rectTop = rect[3];
          const rectBottom = rect[1];
          const annotTop = (page_height - rectTop) * scale;
          const annotHeight = (rectTop - rectBottom) * scale;
          const annotCenter = annotTop + annotHeight / 2;
          offset = annotCenter - (viewportHeight / 2);
          align = "start";
        }

        virtuosoRef.current?.scrollToIndex({
          index: scrollSignal.index,
          align: align,
          offset: offset,
          behavior: "auto"
        });

        // Clear scrollSignal after use to prevent repeated triggers
        onScrollComplete?.();
      }, 50);

      setCurrentPage(scrollSignal.index);
    }
  }, [scrollSignal, setCurrentPage, pageMeta, scale, onScrollComplete]);

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-red-400 p-8 text-center bg-neutral-900">
        <AlertCircle size={48} className="mb-4 opacity-50" />
        <h2 className="text-xl font-bold mb-2">Failed to load PDF</h2>
        <p className="text-sm text-neutral-500 max-w-md">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-neutral-900 relative overflow-hidden select-text">
      <Virtuoso
        ref={virtuosoRef}
        style={{ height: "100%", width: "100%" }}
        data={pageMeta}
        initialScrollTop={initialScrollTop}
        overscan={2}
        onScroll={(e) => {
          const scrollTop = (e.target as HTMLElement).scrollTop;
          onScrollTopChange?.(scrollTop);
        }}
        rangeChanged={(range) => {
          handleSetCurrentPage(range.startIndex);
        }}
        itemContent={(index, meta) => {
          const isCurrent = currentPage === index;
          const displayWidth = meta.width * scale;
          const displayHeight = meta.height * scale;
          const imgUrl = `http://pdf-page.localhost/render?page=${index}&scale=${renderScale}&docId=${docId}&dpr=${window.devicePixelRatio}`;
          const pageAnnotations = annotations.filter(a => a.page_index === index && a.subtype !== 'Link');

          return (
            <div className="flex justify-center py-8 bg-neutral-900 group/page min-w-max overflow-x-auto">
              <div
                className={`relative shadow-2xl transition-shadow duration-300 flex-shrink-0 ${isCurrent ? 'ring-1 ring-blue-500/50' : ''}`}
                style={{
                  width: displayWidth,
                  height: displayHeight,
                  backgroundColor: '#fff',
                  minWidth: displayWidth
                }}
              >
                <img
                  src={imgUrl}
                  style={{ width: "100%", height: "100%", display: "block", userSelect: "none" }}
                  alt={`Page ${index + 1}`}
                  draggable={false}
                />

                {/* Link Layer - Using Percentage Positioning */}
                {annotations.filter(a => a.page_index === index && a.subtype === 'Link').map((link, i) => (
                  <div
                    key={i}
                    className="absolute cursor-pointer hover:bg-blue-500/10 transition-colors z-30"
                    style={{
                      left: `${link.rect[0] * 100}%`,
                      top: `${link.rect[1] * 100}%`,
                      width: `${link.rect[2] * 100}%`,
                      height: `${link.rect[3] * 100}%`,
                    }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (link.uri) {
                        await open(link.uri);
                      } else if (link.dest_page_index !== undefined) {
                        virtuosoRef.current?.scrollToIndex({ index: link.dest_page_index, align: 'start' });
                        setCurrentPage(link.dest_page_index);
                      }
                    }}
                    title={link.uri || (link.dest_page_index !== undefined ? `Go to page ${link.dest_page_index + 1}` : 'Link')}
                  />
                ))}

                {/* Floating Page Badge */}
                <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-md text-white px-2.5 py-1 rounded-md text-[10px] font-mono font-bold border border-white/10 opacity-0 group-hover/page:opacity-100 transition-opacity pointer-events-none z-50">
                  {index + 1} / {pageMeta.length}
                </div>

                <TextLayer pageIndex={index} scale={scale} docId={docId} pageHeight={meta.height} />

                {pageAnnotations.map((ann, i) => {
                  const left = ann.rect[0] * scale;
                  const top = (ann.page_height - ann.rect[3]) * scale;
                  const width = (ann.rect[2] - ann.rect[0]) * scale;
                  const height = (ann.rect[3] - ann.rect[1]) * scale;
                  const maxMarkerLeft = Math.max(4, displayWidth - 28);
                  const maxMarkerTop = Math.max(4, displayHeight - 28);
                  const markerLeft = Math.min(Math.max(left + width + 6, 4), maxMarkerLeft);
                  const markerTop = Math.min(Math.max(top - 14, 4), maxMarkerTop);
                  const isActive = ann === focusedAnnotation || ann === hoveredAnnotation;

                  return (
                    <div key={i} className="absolute inset-0 pointer-events-none z-40">
                      {isActive && (
                        <div
                          className="absolute bg-amber-400/20 ring-2 ring-amber-400 rounded-sm annotation-highlight"
                          style={{ left: left - 4, top: top - 4, width: width + 8, height: height + 8 }}
                        />
                      )}
                      <button
                        type="button"
                        className={`absolute w-7 h-7 rounded-full border flex items-center justify-center transition-all pointer-events-auto cursor-pointer ${
                          isActive
                            ? 'bg-amber-400 text-neutral-950 border-amber-200 shadow-lg shadow-amber-900/40 annotation-marker-bounce'
                            : 'bg-amber-300/20 text-amber-800/70 border-amber-400/35 shadow-sm shadow-amber-900/10 hover:bg-amber-300/40 hover:text-amber-900 hover:border-amber-500/60'
                        }`}
                        style={{ left: markerLeft, top: markerTop }}
                        title={ann.content ? String(ann.content) : `${ann.subtype} annotation`}
                        aria-label={ann.content ? `Annotation: ${ann.content}` : `${ann.subtype} annotation`}
                        onMouseEnter={() => setHoveredAnnotation(ann)}
                        onMouseLeave={() => setHoveredAnnotation(null)}
                        onClick={(e) => {
                          e.stopPropagation();
                          onAnnotationClick(ann);
                        }}
                      >
                        <MessageSquare size={15} strokeWidth={2.4} />
                      </button>
                    </div>
                  );
                })}

                {focusedSearchResult && focusedSearchResult.page_index === index && (
                  <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    {focusedSearchResult.rects.map((rect, i) => {
                      const [l, b, r, t] = rect;
                      const coords = transformRect(l, b, r, t, meta.width, meta.height, meta.rotation, scale);
                      return (
                        <div key={i} className="absolute bg-red-500/30 ring-2 ring-red-500 rounded-sm animate-pulse-fast z-30"
                          style={{ left: coords.left - 4, top: coords.top - 4, width: coords.width + 8, height: coords.height + 8 }} />
                      );
                    })}
                  </div>
                )}

              </div>
            </div>
          );
        }}
      />
    </div>
  );
}

function transformRect(l: number, b: number, r: number, t: number, pW: number, pH: number, rot: number, scale: number) {
  let left, top, width, height;
  if (rot === 0) {
    left = l * scale; top = (pH - t) * scale; width = (r - l) * scale; height = (t - b) * scale;
  } else if (rot === 90) {
    left = b * scale; top = l * scale; width = (t - b) * scale; height = (r - l) * scale;
  } else if (rot === 180) {
    left = (pW - r) * scale; top = b * scale; width = (r - l) * scale; height = (t - b) * scale;
  } else { // 270
    left = (pH - t) * scale; top = (pW - r) * scale; width = (t - b) * scale; height = (r - l) * scale;
  }
  return { left, top, width, height };
}

function TextLayer({ pageIndex, scale, docId, pageHeight }: { pageIndex: number, scale: number, docId: number, pageHeight: number }) {
  const [spans, setSpans] = useState<{ text: string, rect: [number, number, number, number] }[]>([]);

  useEffect(() => {
    const loadText = async () => {
      try {
        const data = await invoke<any[]>("get_page_text", { index: pageIndex });
        setSpans(data);
      } catch (e) { console.error(e); }
    };
    loadText();
  }, [pageIndex, docId]);

  return (
    <div className="absolute inset-0 pointer-events-auto z-20 overflow-hidden opacity-0 hover:opacity-100 transition-opacity">
      {spans.map((span, i) => {
        const [l, b, , t] = span.rect;
        return (
          <span key={i} className="absolute text-transparent leading-none whitespace-pre select-text"
            style={{ left: l * scale, top: (pageHeight - t) * scale, fontSize: (t - b) * scale }}>
            {span.text}
          </span>
        );
      })}
    </div>
  );
}
