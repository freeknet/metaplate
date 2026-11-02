/**
 * Builds a minimal TrueType font whose every glyph is a solid square, for
 * tests that must prove a fallback font drew a segment. The outlines are
 * original (no third-party font data is committed or copied), so the fixture
 * carries no license, and a few hundred bytes stand in for a multi-megabyte
 * CJK face. Satori parses it with opentype.js and shapes it with HarfBuzz
 * like any other TrueType file.
 */

const UNITS_PER_EM = 1000;
const ASCENDER = 880;
const DESCENDER = -120;
/** The square every glyph draws, in font units. */
const SQUARE = { xMin: 50, yMin: -100, xMax: 950, yMax: 800 } as const;

class Writer {
  private readonly bytes: number[] = [];
  u8(value: number) {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number) {
    return this.u8(value >> 8).u8(value);
  }
  i16(value: number) {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }
  u32(value: number) {
    return this.u16(Math.floor(value / 0x10000)).u16(value);
  }
  zeros(count: number) {
    for (let index = 0; index < count; index += 1) this.u8(0);
    return this;
  }
  pad4() {
    while (this.bytes.length % 4 !== 0) this.u8(0);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function squareGlyph(): Uint8Array {
  const { xMin, yMin, xMax, yMax } = SQUARE;
  const glyph = new Writer().i16(1).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
  glyph.u16(3).u16(0); // one contour ending at point 3, no instructions
  for (let point = 0; point < 4; point += 1) glyph.u8(0x01); // on-curve, 16-bit deltas
  // Clockwise outer contour (filled in TrueType): up, right, down.
  for (const dx of [xMin, 0, xMax - xMin, 0]) glyph.i16(dx);
  for (const dy of [yMin, yMax - yMin, 0, yMin - yMax]) glyph.i16(dy);
  return glyph.pad4().done();
}

function utf16be(text: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes.push(unit >> 8, unit & 0xff);
  }
  return bytes;
}

function checksum(table: Uint8Array): number {
  let sum = 0;
  for (let offset = 0; offset < table.length; offset += 4) {
    const word =
      ((table[offset] ?? 0) << 24) |
      ((table[offset + 1] ?? 0) << 16) |
      ((table[offset + 2] ?? 0) << 8) |
      (table[offset + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/**
 * A TrueType font named `family` that maps each code point in `characters`
 * to a solid square glyph (`.notdef` is empty).
 */
export function squareGlyphFont(family: string, characters: string): Uint8Array {
  const codepoints = [...new Set(Array.from(characters, (character) => character.codePointAt(0)!))].sort(
    (a, b) => a - b,
  );
  const numGlyphs = codepoints.length + 1;
  const square = squareGlyph();

  const glyf = new Writer();
  const loca = new Writer().u32(0).u32(0); // .notdef is empty
  for (let glyph = 1; glyph < numGlyphs; glyph += 1) {
    for (const byte of square) glyf.u8(byte);
    loca.u32(glyf.length);
  }

  const head = new Writer()
    .u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5)
    .u16(0x000b).u16(UNITS_PER_EM).zeros(16)
    .i16(SQUARE.xMin).i16(SQUARE.yMin).i16(SQUARE.xMax).i16(SQUARE.yMax)
    .u16(0).u16(8).i16(2).i16(1).i16(0);

  const hhea = new Writer()
    .u32(0x00010000).i16(ASCENDER).i16(DESCENDER).i16(0)
    .u16(UNITS_PER_EM).i16(SQUARE.xMin).i16(UNITS_PER_EM - SQUARE.xMax).i16(SQUARE.xMax)
    .i16(1).i16(0).i16(0).zeros(8).i16(0).u16(numGlyphs);

  const maxp = new Writer().u32(0x00010000).u16(numGlyphs).u16(4).u16(1).zeros(4).u16(2).zeros(16);

  const hmtx = new Writer().u16(UNITS_PER_EM).i16(0);
  for (let glyph = 1; glyph < numGlyphs; glyph += 1) hmtx.u16(UNITS_PER_EM).i16(SQUARE.xMin);

  // cmap format 12 (Windows, full Unicode): one group per code point.
  const cmap = new Writer().u16(0).u16(1).u16(3).u16(10).u32(12);
  cmap.u16(12).u16(0).u32(16 + 12 * codepoints.length).u32(0).u32(codepoints.length);
  codepoints.forEach((codepoint, index) => cmap.u32(codepoint).u32(codepoint).u32(index + 1));

  const names: [id: number, value: string][] = [
    [1, family],
    [2, "Regular"],
    [4, family],
    [6, family.replace(/\s/g, "")],
  ];
  const strings = names.map(([, value]) => utf16be(value));
  const name = new Writer().u16(0).u16(names.length).u16(6 + 12 * names.length);
  let stringOffset = 0;
  names.forEach(([id], index) => {
    name.u16(3).u16(1).u16(0x409).u16(id).u16(strings[index]!.length).u16(stringOffset);
    stringOffset += strings[index]!.length;
  });
  for (const value of strings) for (const byte of value) name.u8(byte);

  const post = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).zeros(20);

  const os2 = new Writer()
    .u16(4).i16(UNITS_PER_EM).u16(400).u16(5).u16(0)
    .zeros(20).i16(0).zeros(10).zeros(16).u8(0x4d).u8(0x50).u8(0x4c).u8(0x54)
    .u16(0x40).u16(Math.min(codepoints[0] ?? 0, 0xffff)).u16(Math.min(codepoints.at(-1) ?? 0, 0xffff))
    .i16(ASCENDER).i16(DESCENDER).i16(0).u16(ASCENDER).u16(-DESCENDER)
    .zeros(8).i16(500).i16(700).u16(0).u16(32).u16(1);

  const tables = (
    [
      ["OS/2", os2],
      ["cmap", cmap],
      ["glyf", glyf],
      ["head", head],
      ["hhea", hhea],
      ["hmtx", hmtx],
      ["loca", loca],
      ["maxp", maxp],
      ["name", name],
      ["post", post],
    ] as const
  ).map(([tag, writer]) => [tag, writer.done()] as const);

  const entrySelector = Math.floor(Math.log2(tables.length));
  const searchRange = 2 ** entrySelector * 16;
  const font = new Writer()
    .u32(0x00010000).u16(tables.length).u16(searchRange).u16(entrySelector)
    .u16(tables.length * 16 - searchRange);
  let offset = 12 + tables.length * 16;
  for (const [tag, data] of tables) {
    for (const character of tag) font.u8(character.charCodeAt(0));
    font.u32(checksum(data)).u32(offset).u32(data.length);
    offset += Math.ceil(data.length / 4) * 4;
  }
  for (const [, data] of tables) {
    for (const byte of data) font.u8(byte);
    font.pad4();
  }
  return font.done();
}
