import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "../../..");
const consumer = mkdtempSync(join(tmpdir(), "metaplate-050-malformed-"));
const packageSpec = process.env.METAPLATE_PACKAGE_SPEC ?? "0.5.0";
const expectingHardened = process.env.METAPLATE_EXPECT_HARDENED === "1";
const expectationMode = expectingHardened ? "hardened" : "baseline-0.5.0";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
}

writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies: { metaplate: packageSpec } }),
);
run(npmCommand, ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"]);

const installedManifest = JSON.parse(
  readFileSync(join(consumer, "node_modules", "metaplate", "package.json"), "utf8"),
);

const imageModule = await import(
  pathToFileURL(join(consumer, "node_modules/metaplate/dist/image.js")).href
);
const { imageDimensions } = imageModule;

const crcTable = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u24le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function pngChunk(type, payload) {
  const typed = Uint8Array.from(type, character => character.charCodeAt(0));
  const body = Uint8Array.from([...typed, ...payload]);
  return [...u32be(payload.length), ...body, ...u32be(crc32(body))];
}

function png({
  width = 1,
  height = 1,
  bitDepth = 8,
  colorType = 6,
  compression = 0,
  filter = 0,
  interlace = 0,
  idat = deflateSync(Uint8Array.of(0, 255, 0, 0, 255)),
  beforeIdat = [],
  afterIdat = [],
} = {}) {
  const ihdr = [
    ...u32be(width),
    ...u32be(height),
    bitDepth,
    colorType,
    compression,
    filter,
    interlace,
  ];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", ihdr),
    ...beforeIdat.flat(),
    ...pngChunk("IDAT", [...idat]),
    ...afterIdat.flat(),
    ...pngChunk("IEND", []),
  ]);
}

function webpChunk(type, payload, padding = 0) {
  return [
    ...Uint8Array.from(type, character => character.charCodeAt(0)),
    ...u32le(payload.length),
    ...payload,
    ...(payload.length % 2 ? [padding] : []),
  ];
}

function riff(chunks) {
  const body = [0x57, 0x45, 0x42, 0x50, ...chunks.flat()];
  return Uint8Array.from([0x52, 0x49, 0x46, 0x46, ...u32le(body.length), ...body]);
}

function vp8x(width, height, flags = 0) {
  return webpChunk("VP8X", [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

function vp8l(width = 1, height = 1, padding = 0) {
  const packed = (width - 1) | ((height - 1) << 14);
  return webpChunk("VP8L", [0x2f, ...u32le(packed)], padding);
}

function anmf({ x = 0, y = 0, width = 1, height = 1 } = {}) {
  const header = [
    ...u24le(x / 2),
    ...u24le(y / 2),
    ...u24le(width - 1),
    ...u24le(height - 1),
    1, 0, 0,
    0,
  ];
  return webpChunk("ANMF", [...header, ...vp8l(width, height)]);
}

function minimalJpeg(width, height) {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b,
    0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x01,
    0xff, 0xd9,
  ]);
}

const validIhdr = [...u32be(1), ...u32be(1), 8, 6, 0, 0, 0];
const invalidZlib = Uint8Array.from(deflateSync(Uint8Array.of(0, 255, 0, 0, 255)));
invalidZlib[0] = 0xf8;
invalidZlib[1] = 0x00;
assert.throws(() => inflateSync(invalidZlib), /window|header|data/i);

const cases = [
  { name: "png-invalid-bit-depth-color", bytes: png({ bitDepth: 1, colorType: 6 }) },
  { name: "png-invalid-compression-method", bytes: png({ compression: 1 }) },
  { name: "png-invalid-filter-method", bytes: png({ filter: 1 }) },
  { name: "png-invalid-interlace-method", bytes: png({ interlace: 2 }) },
  { name: "png-invalid-zlib-window", bytes: png({ idat: invalidZlib }) },
  {
    name: "png-duplicate-ihdr",
    bytes: png({ beforeIdat: [pngChunk("IHDR", validIhdr)] }),
  },
  {
    name: "png-indexed-without-plte",
    bytes: png({ colorType: 3, idat: deflateSync(Uint8Array.of(0, 0)) }),
  },
  {
    name: "png-plte-after-idat",
    bytes: png({
      colorType: 3,
      idat: deflateSync(Uint8Array.of(0, 0)),
      afterIdat: [pngChunk("PLTE", [255, 0, 0])],
    }),
  },
  {
    name: "png-unknown-critical-chunk",
    bytes: png({ beforeIdat: [pngChunk("ABCD", [])] }),
  },
  { name: "jpeg-zero-width", bytes: minimalJpeg(0, 1) },
  {
    name: "webp-nonzero-riff-padding",
    bytes: riff([webpChunk("VP8L", [0x2f, 0, 0, 0, 0, 0, 0, 0, 0], 0xff)]),
  },
  {
    name: "webp-canvas-area-overflow",
    bytes: riff([vp8x(65_536, 65_536), vp8l(1, 1)]),
  },
  {
    name: "webp-animation-without-anim-control",
    bytes: riff([vp8x(1, 1, 0x02), anmf()]),
  },
  {
    name: "webp-frame-outside-canvas",
    bytes: riff([
      vp8x(1, 1, 0x02),
      webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
      anmf({ x: 2, width: 1, height: 1 }),
    ]),
  },
];

const accepted = [];
for (const testCase of cases) {
  const file = join(consumer, `${testCase.name}.${testCase.name.startsWith("jpeg") ? "jpg" : testCase.name.startsWith("webp") ? "webp" : "png"}`);
  writeFileSync(file, testCase.bytes);
  let metaplate;
  try {
    metaplate = { accepted: true, dimensions: imageDimensions(testCase.bytes) };
    accepted.push(testCase.name);
  } catch (error) {
    metaplate = { accepted: false, error: error.message };
  }

  let ffprobe;
  try {
    run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file]);
    ffprobe = "accepted";
  } catch {
    ffprobe = "rejected";
  }
  testCase.result = { metaplate, ffprobe };
}

if (expectingHardened) {
  assert.deepEqual(accepted, []);
  for (const testCase of cases) {
    const format = testCase.name.startsWith("png")
      ? "PNG"
      : testCase.name.startsWith("jpeg")
        ? "JPEG"
        : "WebP";
    assert.equal(testCase.result.metaplate.accepted, false, `${testCase.name} was accepted`);
    assert.match(
      testCase.result.metaplate.error,
      new RegExp(format, "i"),
      `${testCase.name} did not report a format-specific error`,
    );
  }
} else {
  assert.deepEqual(accepted, cases.map(testCase => testCase.name));
}

const fixtures = ["card.png", "card.jpg", "card-lossy.webp", "card-lossless.webp", "card-alpha.webp"];
let truncations = 0;
let acceptedTruncations = 0;
const started = performance.now();
for (const fixture of fixtures) {
  const bytes = readFileSync(join(root, "tests/fixtures", fixture));
  const samples = new Set([16, bytes.length - 1]);
  for (let index = 1; index <= 64; index += 1) {
    samples.add(Math.max(16, Math.floor((bytes.length * index) / 65)));
  }
  for (const end of samples) {
    if (end >= bytes.length) continue;
    truncations += 1;
    try {
      imageDimensions(bytes.subarray(0, end));
      acceptedTruncations += 1;
    } catch {
      // Expected: the terminator or declared container boundary is missing.
    }
  }
}
const durationMs = performance.now() - started;
assert.equal(acceptedTruncations, 0);
assert.ok(durationMs < 2_000, `truncation sweep took ${durationMs}ms`);

const cliCase = cases.find(testCase => testCase.name === "png-invalid-compression-method");
let cliExitCode = 0;
try {
  run("node", [
    "node_modules/metaplate/dist/cli.js",
    "verify",
    "--format",
    "png",
    "--size",
    "1x1",
    join(consumer, "png-invalid-compression-method.png"),
  ]);
} catch (error) {
  cliExitCode = error.status;
}
if (expectingHardened) {
  assert.equal(cliCase.result.metaplate.accepted, false);
  assert.match(cliCase.result.metaplate.error, /PNG/i);
  assert.notEqual(cliExitCode, 0);
} else {
  assert.equal(cliCase.result.metaplate.accepted, true);
  assert.equal(cliExitCode, 0);
}

console.log(
  JSON.stringify(
    {
      consumer,
      packageSpec,
      installedVersion: installedManifest.version,
      expectationMode,
      invalidContainersAccepted: cases.map(testCase => ({
        name: testCase.name,
        ...testCase.result,
      })),
      truncationSweep: { samples: truncations, accepted: acceptedTruncations, durationMs },
      cliReproduction: expectingHardened
        ? "rejected a PNG whose IHDR declares unsupported compression method 1"
        : "accepted a PNG whose IHDR declares unsupported compression method 1",
    },
    null,
    2,
  ),
);
