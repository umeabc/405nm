import zlib from 'node:zlib';

/**
 * 最小 PNG 编码器（IHDR + IDAT + IEND）。
 *
 * 验证脚本必须能**造出真图**，不能拿假字节糊弄：后端要用 libvips 解出宽高、
 * 生成缩略图与预览图，假字节会在第一步就被拒，于是「上传成功但尺寸不对」
 * 这类问题根本测不到。
 *
 * 手写而不是引入依赖：脚本要在容器里、在开发机上、在 CI 里都能直接跑，
 * 而这几行代码的全部复杂度就是 CRC32 与两个块。
 *
 * 三个验证脚本（m1/m2/m3）共用这一份 —— 以前各抄一份，改尺寸或改颜色时
 * 必然漏掉一个，表现是「只有某一个脚本的断言莫名其妙地过了」。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** 生成一张纯色 PNG。尺寸可控，便于断言 width/height 与缩略图缩放。 */
export function makePng(width, height, [r, g, b] = [255, 101, 124]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
