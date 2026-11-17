import { inflateSync } from "node:zlib";

// Reads a non-interlaced 8-bit PNG (indexed, RGB or RGBA) far enough to ask for the colour of a pixel. Used by the icon tests only.
export function readPng(bytes) {
  let at = 8;
  const chunks = [];
  let header = null;
  let palette = null;
  const data = [];

  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);

    chunks.push(type);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    if (type === "PLTE") palette = body;
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  if (header.depth !== 8 || header.interlace !== 0) throw new Error("only an 8-bit PNG without interlacing is read here");
  const channels = { 2: 3, 3: 1, 6: 4 }[header.colorType];
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(header.height * stride);

  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];

      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  /** The colour of a pixel as [r, g, b, a]. */
  const pixel = (x, y) => {
    const from = y * stride + x * channels;

    if (header.colorType === 3) return [palette[pixels[from] * 3], palette[pixels[from] * 3 + 1], palette[pixels[from] * 3 + 2], chunks.includes("tRNS") ? 0 : 255];
    return [pixels[from], pixels[from + 1], pixels[from + 2], header.colorType === 6 ? pixels[from + 3] : 255];
  };

  return { ...header, chunks, pixel };
}
