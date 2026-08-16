interface FixedVirtualWindowOptions {
  itemCount: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}

export interface FixedVirtualWindow {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
  scrollTop: number;
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveFixedVirtualWindow({
  itemCount,
  itemHeight,
  scrollTop,
  viewportHeight,
  overscan = 4
}: FixedVirtualWindowOptions): FixedVirtualWindow {
  const count = Math.floor(finiteNonNegative(itemCount));
  if (count === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0, scrollTop: 0 };
  }

  const height = Math.max(1, finiteNonNegative(itemHeight));
  const viewport = Math.max(height, finiteNonNegative(viewportHeight));
  const extraRows = Math.floor(finiteNonNegative(overscan));
  const totalHeight = count * height;
  const normalizedScrollTop = Math.min(finiteNonNegative(scrollTop), Math.max(0, totalHeight - viewport));
  const firstVisibleIndex = Math.min(count - 1, Math.floor(normalizedScrollTop / height));
  const visibleCount = Math.max(1, Math.ceil(viewport / height));
  const startIndex = Math.max(0, firstVisibleIndex - extraRows);
  const endIndex = Math.min(count, firstVisibleIndex + visibleCount + extraRows);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * height,
    totalHeight,
    scrollTop: normalizedScrollTop
  };
}
