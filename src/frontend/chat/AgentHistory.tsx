import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, measureElement, renderToString, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { parseMouseWheel } from '../interaction/mouse';
import { useSelectionRegion } from '../interaction/useTextSelection';

export interface HistoryPosition { offset: number; height: number }

// Each agent keeps its own bottom-relative scroll offset and last measured
// height. When revisited, new output is added below the saved reading point.
export function AgentHistory({ children, position, active, hidden, sidebarWidth, empty, reset }: {
  children: ReactNode;
  position: HistoryPosition;
  active: boolean;
  hidden: boolean;
  sidebarWidth: number;
  empty: boolean;
  reset: number;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const { height: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const [offset, setOffset] = useState(position.offset);
  const previousHeight = useRef(position.height);
  const previousReset = useRef(reset);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const pageSize = Math.max(1, viewportHeight - 2);
  const content = useRef(children);
  content.current = children;
  const text = useCallback(() => {
    const width = contentRef.current ? measureElement(contentRef.current).width : 0;
    return width > 0 ? renderToString(<Box flexDirection="column" width={width}>{content.current}</Box>, { columns: width }).split('\n') : [];
  }, []);
  useSelectionRegion(viewportRef, { follows: contentRef, text });

  useEffect(() => {
    if (hidden || viewportHeight === 0 || contentHeight === 0) return;
    const delta = contentHeight - previousHeight.current;
    previousHeight.current = contentHeight;
    const shouldReset = previousReset.current !== reset;
    previousReset.current = reset;
    setOffset(current => {
      const next = shouldReset ? 0 : Math.min(maxScroll, Math.max(0, current > 0 ? current + delta : 0));
      position.offset = next;
      position.height = contentHeight;
      return next;
    });
  }, [contentHeight, viewportHeight, maxScroll, hidden, position, reset]);

  const scroll = (next: number) => {
    position.offset = Math.max(0, Math.min(maxScroll, next));
    setOffset(position.offset);
  };
  useInput((input, key) => {
    const wheel = parseMouseWheel(input);
    if (wheel && wheel.column > sidebarWidth) scroll(offset + (wheel.direction === 'up' ? 3 : -3));
    else if (key.pageUp) scroll(offset + pageSize);
    else if (key.pageDown) scroll(offset - pageSize);
    else if (key.ctrl && key.home) scroll(maxScroll);
    else if (key.ctrl && key.end) scroll(0);
  }, { isActive: active && !hidden });

  return (
    <Box display={hidden ? 'none' : 'flex'} flexDirection="column" flexGrow={1} minHeight={0}>
      <Box ref={viewportRef} position="relative" flexDirection="column" flexGrow={1} minHeight={0}
        overflow="hidden" justifyContent={empty ? 'center' : 'flex-end'}>
        <Box ref={contentRef} position={empty ? 'static' : 'absolute'} bottom={empty ? undefined : -offset}
          width="100%" flexDirection="column" flexShrink={0}>{children}</Box>
      </Box>
    </Box>
  );
}
