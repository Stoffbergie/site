import type { IconShape } from "./resolve";

type Layout = { size: number; cell: number; radius: number };

const LAYOUTS: Record<IconShape, Layout> = {
  tab: { size: 64, cell: 8, radius: 14 },
  touch: { size: 180, cell: 22, radius: 0 }
};
const GRID = 5;
const MIRRORED_COLUMNS = 3;
const CORNER_SAMPLES = 4;
const TILE_COLORS = [
  [220, 38, 38],
  [234, 88, 12],
  [202, 138, 4],
  [22, 163, 74],
  [13, 148, 136],
  [8, 145, 178],
  [37, 99, 235],
  [79, 70, 229],
  [124, 58, 237],
  [192, 38, 211],
  [219, 39, 119],
  [71, 85, 105]
];
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_HEADER_BYTES = 22;
const CRC_TABLE = crcTable();

/**
 * Draws the icon a site without one of its own gets: a tile in a colour picked by the site's label, with a mirrored five by five pattern from the same label, so the same site always gets the same icon. The tab shape is a 64 pixel PNG inside an ICO file with rounded corners, the touch shape a square 180 pixel PNG.
 */
export async function siteIcon(label: string, shape: IconShape): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(label)));
  const layout = LAYOUTS[shape];
  const png = await encodePng(paint(digest, layout), layout.size);
  if (shape === "touch") return png;
  return wrapInIco(png, layout.size);
}

function paint(digest: Uint8Array, layout: Layout): Uint8Array {
  const { size, cell } = layout;
  const tile = TILE_COLORS[digest[0] % TILE_COLORS.length];
  const filled = filledCells(digest);
  const margin = (size - GRID * cell) / 2;
  const stride = 1 + size * 4;
  const rows = new Uint8Array(size * stride);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const column = Math.floor((x - margin) / cell);
      const row = Math.floor((y - margin) / cell);
      const inGrid = column >= 0 && column < GRID && row >= 0 && row < GRID;
      let color = tile;
      if (inGrid && filled[row * GRID + column]) color = [255, 255, 255];
      const at = y * stride + 1 + x * 4;
      rows[at] = color[0];
      rows[at + 1] = color[1];
      rows[at + 2] = color[2];
      rows[at + 3] = Math.round(255 * coverage(x, y, layout));
    }
  }
  return rows;
}

function filledCells(digest: Uint8Array): boolean[] {
  const bits = digest[1] | (digest[2] << 8);
  const cells = Array.from({ length: GRID * GRID }, () => false);
  let anyFilled = false;
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < MIRRORED_COLUMNS; column += 1) {
      const on = ((bits >> (row * MIRRORED_COLUMNS + column)) & 1) === 1;
      cells[row * GRID + column] = on;
      cells[row * GRID + GRID - 1 - column] = on;
      if (on) anyFilled = true;
    }
  }
  if (!anyFilled) cells[Math.floor((GRID * GRID) / 2)] = true;
  return cells;
}

function coverage(x: number, y: number, layout: Layout): number {
  const { size, radius } = layout;
  if (radius === 0) return 1;
  let inside = 0;
  for (let sampleY = 0; sampleY < CORNER_SAMPLES; sampleY += 1) {
    for (let sampleX = 0; sampleX < CORNER_SAMPLES; sampleX += 1) {
      const pointX = x + (sampleX + 0.5) / CORNER_SAMPLES;
      const pointY = y + (sampleY + 0.5) / CORNER_SAMPLES;
      const outsideX = Math.max(radius - pointX, pointX - (size - radius), 0);
      const outsideY = Math.max(radius - pointY, pointY - (size - radius), 0);
      if (outsideX * outsideX + outsideY * outsideY <= radius * radius) inside += 1;
    }
  }
  return inside / (CORNER_SAMPLES * CORNER_SAMPLES);
}

async function encodePng(rows: Uint8Array, size: number): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8;
  header[9] = 6;
  const deflated = new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"));
  const pixels = new Uint8Array(await new Response(deflated).arrayBuffer());
  return concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", new Uint8Array(0))]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([new TextEncoder().encode(type), data]);
  const framed = new Uint8Array(4 + typed.byteLength + 4);
  const view = new DataView(framed.buffer);
  view.setUint32(0, data.byteLength);
  framed.set(typed, 4);
  view.setUint32(4 + typed.byteLength, crc(typed));
  return framed;
}

function wrapInIco(png: Uint8Array, size: number): Uint8Array {
  const header = new Uint8Array(ICO_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  header[6] = size;
  header[7] = size;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.byteLength, true);
  view.setUint32(18, ICO_HEADER_BYTES, true);
  return concat([header, png]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & 1) === 1) value = 0xedb88320 ^ (value >>> 1);
      else value >>>= 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
