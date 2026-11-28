/** Coordinates: the agent works in the screenshot's pixels, the system takes screen points. */

export interface DisplayInfo {
  /** Size in points (what Electron calls DIPs), origin at the top left of the primary display. */
  width: number;
  height: number;
  scaleFactor: number;
  /** Position of the display in the virtual desktop, in points. Absent = 0,0. */
  originX?: number;
  originY?: number;
}

export interface ImageSize { width: number; height: number }

/** The size of a screenshot: never upscaled beyond the physical resolution, ratio kept. */
export function screenshotSize(display: DisplayInfo, maxWidth: number): ImageSize {
  const physical = Math.max(1, Math.round(display.width * display.scaleFactor));
  const width = Math.max(1, Math.min(maxWidth, physical));
  return { width, height: Math.max(1, Math.round(display.height * width / display.width)) };
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/** Image pixels → screen points, clamped on the display so a stray coordinate never leaves it. */
export function imageToPoints(display: DisplayInfo, image: ImageSize, x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(x * display.width / image.width, display.width - 1),
    y: clamp(y * display.height / image.height, display.height - 1),
  };
}

/** Screen points → image pixels, for `cursor_position`. */
export function pointsToImage(display: DisplayInfo, image: ImageSize, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(clamp(x - (display.originX ?? 0), display.width) * image.width / display.width),
    y: Math.round(clamp(y - (display.originY ?? 0), display.height) * image.height / display.height),
  };
}
