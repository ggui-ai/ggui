/**
 * The ink extent of a judge screenshot (ggui#1120): how far down the frame anything was painted, read
 * from the pixels the judge already holds. `contentHeight` is the document's scroll height, floored at
 * the viewport by definition — it can see overflow and never under-fill, and never a blank.
 *
 * The reading: the region's DOMINANT colour (its most common pixel) is the ground; a pixel is ink when
 * any channel differs from it by more than {@link INK_TOLERANCE}; `lastInkRow` is the last region row
 * with ink and `ratio` is `(lastInkRow + 1) / region.height`. Dominant, not the corners: an opening
 * hero band makes the top corners content, and a host panel's rounded corners expose the scrim behind
 * it (measured on the ggui#1083 judge frames — corner sampling read a card that fills as 1.0 and a
 * panelled page as all ink).
 *
 * Only the ZERO is judged (`canvas-blank`, the judge's verdict): a region with no ink is one flat
 * colour — the tree mounted and painted nothing, the mount-path class no compile-time check can reach
 * (ggui#1104 / #1119). Every other value is reported, never scored: the corpus does not support a
 * dead-space threshold (#1120).
 *
 * A PNG reader of exactly the judge's own captures — 8-bit RGB / RGBA, non-interlaced, `node:zlib`
 * for the IDAT stream and the five scanline filters by hand — so a published package takes no image
 * dependency. Any other PNG reads as unmeasurable (a reason), never as blank.
 */
import { inflateSync } from 'node:zlib';

/** A channel difference at or below this is the same colour (anti-aliasing and compositing noise). */
export const INK_TOLERANCE = 8;

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InkExtent {
  /** `(lastInkRow + 1) / region.height`, rounded to 3 places; `0` when nothing differs from the ground. */
  readonly ratio: number;
  /** The last region row (0-based from the region's top) carrying ink; `null` when there is none — the blank. */
  readonly lastInkRow: number | null;
  /** The region read, in image px. */
  readonly region: PixelRegion;
  /** The dominant colour the ink was read against, `[r, g, b]`. */
  readonly ground: readonly [number, number, number];
}

/** Why a capture could not be read — reported, never mistaken for a blank. */
export interface InkUnreadable {
  readonly reason: string;
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  /** Row-major, `channels` bytes per pixel, scanline filters undone. */
  readonly pixels: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The PNG subset the judge's browser writes: 8-bit RGB (colour type 2) or RGBA (6), not interlaced. */
export function decodePng(png: Uint8Array): DecodedImage | InkUnreadable {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 8 + 25) return { reason: `not a PNG: ${buf.length} bytes` };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return { reason: 'not a PNG: signature mismatch' };
  }
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | null = null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length + 4 > buf.length) return { reason: `truncated PNG: ${type} chunk runs past the end` };
    const data = buf.subarray(start, start + length);
    if (type === 'IHDR') {
      if (length !== 13) return { reason: `malformed IHDR: ${length} bytes` };
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) return { reason: `unsupported PNG: bit depth ${bitDepth}` };
      if (interlace !== 0) return { reason: 'unsupported PNG: interlaced' };
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else return { reason: `unsupported PNG: colour type ${colorType}` };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }
  if (channels === null) return { reason: 'malformed PNG: no IHDR' };
  if (width === 0 || height === 0) return { reason: `empty PNG: ${width}×${height}` };
  if (idat.length === 0) return { reason: 'malformed PNG: no IDAT' };
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    return { reason: `corrupt IDAT stream: ${error instanceof Error ? error.message : String(error)}` };
  }
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) {
    return { reason: `malformed PNG: ${raw.length} raw bytes for ${width}×${height}×${channels}` };
  }
  const pixels = new Uint8Array(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    const prevRow = outRow - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[inRow + i]!;
      const a = i >= bpp ? pixels[outRow + i - bpp]! : 0;
      const b = y > 0 ? pixels[prevRow + i]! : 0;
      const c = y > 0 && i >= bpp ? pixels[prevRow + i - bpp]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return { reason: `malformed PNG: scanline filter ${filter} at row ${y}` };
      }
      pixels[outRow + i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * The ink extent of a capture, read `insetPx` in from every edge — the judge's inset skips a host
 * panel's gap, rounded corners and hairline ({@link JUDGE_INK_INSET_PX}); `0` reads the whole image.
 */
export function readInkExtent(png: Uint8Array, insetPx = 0): InkExtent | InkUnreadable {
  const image = decodePng(png);
  if ('reason' in image) return image;
  const region: PixelRegion = { x: insetPx, y: insetPx, width: image.width - 2 * insetPx, height: image.height - 2 * insetPx };
  if (insetPx < 0 || region.width <= 0 || region.height <= 0) {
    return { reason: `an inset of ${insetPx}px leaves nothing of a ${image.width}×${image.height} image` };
  }
  const { channels, pixels, width } = image;
  // The ground: the region's most common colour.
  const counts = new Map<number, number>();
  let ground = 0;
  let groundCount = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * width + x) * channels;
      const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > groundCount) {
        groundCount = n;
        ground = key;
      }
    }
  }
  const gr = (ground >> 16) & 0xff;
  const gg = (ground >> 8) & 0xff;
  const gb = ground & 0xff;
  let lastInkRow: number | null = null;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * width + x) * channels;
      if (
        Math.abs(pixels[i]! - gr) > INK_TOLERANCE ||
        Math.abs(pixels[i + 1]! - gg) > INK_TOLERANCE ||
        Math.abs(pixels[i + 2]! - gb) > INK_TOLERANCE
      ) {
        lastInkRow = y - region.y;
        break;
      }
    }
  }
  const ratio = lastInkRow === null ? 0 : Math.round(((lastInkRow + 1) / region.height) * 1000) / 1000;
  return { ratio, lastInkRow, region, ground: [gr, gg, gb] };
}
