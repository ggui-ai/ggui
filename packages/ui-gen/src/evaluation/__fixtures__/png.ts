/**
 * A PNG writer for tests (ggui#1120): 8-bit RGB / RGBA, non-interlaced, one scanline filter for the
 * whole image — the shapes the judge's browser writes, so `decodePng` is exercised on every filter it
 * must undo. Test-only: nothing in `src` imports it.
 */
import { crc32, deflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];

export interface PngSpec {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  /** The colour at (x, y). */
  readonly pixel: (x: number, y: number) => Rgb;
  /** The scanline filter applied to every row (0 none, 1 sub, 2 up, 3 average, 4 paeth). */
  readonly filter?: 0 | 1 | 2 | 3 | 4;
  /** Overrides for the malformed cases. */
  readonly bitDepth?: number;
  readonly colorType?: number;
  readonly interlace?: number;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(Buffer.from(type, 'latin1'))) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(spec: PngSpec): Buffer {
  const { width, height, channels } = spec;
  const filter = spec.filter ?? 0;
  const stride = width * channels;
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b] = spec.pixel(x, y);
      row.push(r, g, b);
      if (channels === 4) row.push(255);
    }
    rows.push(row);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const x = rows[y]![i]!;
      const a = i >= channels ? rows[y]![i - channels]! : 0;
      const b = y > 0 ? rows[y - 1]![i]! : 0;
      const c = y > 0 && i >= channels ? rows[y - 1]![i - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = x;
          break;
        case 1:
          out = x - a;
          break;
        case 2:
          out = x - b;
          break;
        case 3:
          out = x - ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
      }
      raw[y * (stride + 1) + 1 + i] = out & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = spec.bitDepth ?? 8;
  ihdr[9] = spec.colorType ?? (channels === 4 ? 6 : 2);
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = spec.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One flat colour — the blank. */
export function flatPng(width: number, height: number, colour: Rgb, channels: 3 | 4 = 3, filter: PngSpec['filter'] = 0): Buffer {
  return encodePng({ width, height, channels, pixel: () => colour, filter });
}
