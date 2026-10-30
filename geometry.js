/**
 * Pure monitor math shared by the extension service worker.
 * Coordinates are Chrome DIP pixels (the same space as chrome.system.display).
 */

export function intersectionArea(rect, bounds) {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.left + rect.width, bounds.left + bounds.width);
  const bottom = Math.min(rect.top + rect.height, bounds.top + bounds.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

export function displayAtPoint(x, y, displays) {
  return (
    displays.find((display) => {
      const bounds = display.bounds;
      return (
        x >= bounds.left &&
        x < bounds.left + bounds.width &&
        y >= bounds.top &&
        y < bounds.top + bounds.height
      );
    }) || null
  );
}

export function displayByOverlap(rect, displays) {
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(rect, display.bounds);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  return best;
}

export function monitorSnapshot(display) {
  const bounds = display.bounds;
  return {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
}

export function relativePlacement(rect, display) {
  const area = display.workArea || display.bounds;
  return {
    x: (rect.left - area.left) / area.width,
    y: (rect.top - area.top) / area.height,
    w: rect.width / area.width,
    h: rect.height / area.height,
  };
}

function areaOf(display) {
  const box = display.workArea || display.bounds;
  return box.width * box.height;
}

/** Where a window goes when its original monitor is gone. */
export function fallbackDisplay(displays) {
  if (!displays.length) return null;
  const ranked = displays.map((display) => ({ display, area: areaOf(display) }));
  ranked.sort((a, b) => b.area - a.area);
  const primary = ranked.find((item) => item.display.isPrimary);
  if (primary && primary.area >= ranked[0].area * 0.9) return primary.display;
  return ranked[0].display;
}

export function matchDisplay(monitor, displays) {
  if (!monitor || !displays.length) return null;
  let best = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(monitor, display.bounds);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  const monitorArea = monitor.width * monitor.height;
  if (!best || !monitorArea || bestArea < monitorArea * 0.25) return null;
  return best;
}

export function visibleFraction(rect, displays) {
  const area = rect.width * rect.height;
  if (area <= 0) return 0;
  let covered = 0;
  for (const display of displays) covered += intersectionArea(rect, display.bounds);
  return covered / area;
}

export function clampToVisible(rect, displays) {
  let width = Math.max(100, Math.round(rect.width));
  let height = Math.max(80, Math.round(rect.height));
  if (!displays.length) {
    return { left: Math.round(rect.left), top: Math.round(rect.top), width, height };
  }

  const biggest = displays.reduce((best, display) =>
    areaOf(display) > areaOf(best) ? display : best,
  );
  const biggestBox = biggest.bounds;
  width = Math.min(width, biggestBox.width);
  height = Math.min(height, biggestBox.height);

  const initial = {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width,
    height,
  };
  if (visibleFraction(initial, displays) >= 0.5) return initial;

  const host =
    displayByOverlap(initial, displays) ||
    displays.find((display) => display.isPrimary) ||
    displays[0];
  const box = host.workArea || host.bounds;
  width = Math.min(width, box.width);
  height = Math.min(height, box.height);
  const left = Math.round(box.left + (box.width - width) / 2);
  const top = Math.round(box.top + (box.height - height) / 2);
  const centered = { left, top, width, height };
  if (visibleFraction(centered, displays) >= 0.5) return centered;

  return {
    left: Math.round(box.left + Math.max(0, Math.min(left - box.left, box.width - width))),
    top: Math.round(box.top + Math.max(0, Math.min(top - box.top, box.height - height))),
    width,
    height,
  };
}

/**
 * Place one saved window onto the displays currently attached.
 * `cascade` nudges fallback windows so they don't stack perfectly.
 */
export function mapWindowBounds(saved, displays, cascade = 0) {
  const matched = matchDisplay(saved.monitor, displays);
  if (matched && saved.rel && saved.rel.w > 0.04 && saved.rel.h > 0.04) {
    const box = matched.workArea || matched.bounds;
    return clampToVisible(
      {
        left: box.left + saved.rel.x * box.width,
        top: box.top + saved.rel.y * box.height,
        width: saved.rel.w * box.width,
        height: saved.rel.h * box.height,
      },
      displays,
    );
  }

  const host = fallbackDisplay(displays);
  if (!host) {
    return clampToVisible(
      {
        left: saved.left || 80,
        top: saved.top || 80,
        width: saved.width || 960,
        height: saved.height || 640,
      },
      displays,
    );
  }
  const box = host.workArea || host.bounds;
  const width = Math.min(Math.max(saved.width || box.width * 0.72, 100), box.width * 0.86);
  const height = Math.min(Math.max(saved.height || box.height * 0.72, 80), box.height * 0.86);
  const nudge = cascade * 32;
  return clampToVisible(
    {
      left: box.left + (box.width - width) / 2 + nudge,
      top: box.top + (box.height - height) / 2 + nudge,
      width,
      height,
    },
    displays,
  );
}
