// tests for the strict lossless Netpbm reader/writer, TIFF-like tiles and streamed file encoding
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeNetpbm, encodeNetpbm, encodeChunks, isNetpbm, ENCODE_CHUNK } = require('../dist/lossless/netpbm.js');
const { RasterError } = require('../dist/lossless/raster.js');
const { readTiles } = require('../dist/lossless/tiles.js');
const { writeNetpbmFile } = require('../dist/lossless/encode.js');

const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0));
const bytes = (header, data) => Uint8Array.from([...ascii(header), ...data]);

(async () => {
    // header, comments and padding are separated from the pixel data
    const p5 = decodeNetpbm(bytes('P5\n# a comment\n  3   2\n# another\n255\n', [1, 2, 3, 4, 5, 6]));
    assert.deepStrictEqual([p5.width, p5.height, p5.channels, p5.bitDepth, p5.maxval], [3, 2, 1, 8, 255]);
    assert.deepStrictEqual([...p5.data], [1, 2, 3, 4, 5, 6]);

    // the pixel data's first byte is kept even when it is a space or a hash
    assert.deepStrictEqual([...decodeNetpbm(bytes('P5\n1 1\n255\n', [0x20])).data], [0x20]);
    assert.deepStrictEqual([...decodeNetpbm(bytes('P5\n1 1\n255\n', [0x23])).data], [0x23]);
    // ... but only one whitespace byte ends the header
    assert.throws(() => decodeNetpbm(bytes('P5\n1 1\n255\n', [0x20, 0x20])), /trailing/);

    // P6, channel order kept
    const p6 = decodeNetpbm(bytes('P6\n1 2\n255\n', [1, 2, 3, 4, 5, 6]));
    assert.deepStrictEqual([p6.width, p6.height, p6.channels], [1, 2, 3]);
    assert.deepStrictEqual([...p6.data], [1, 2, 3, 4, 5, 6]);

    // 16 bit big endian samples stay 16 bit (no quantization), channel order kept
    const wide = [0x1234, 0xffff, 0x0001, 0x8000, 0x00ff, 0xff00];
    const p616 = decodeNetpbm(bytes('P6\n1 2\n65535\n', wide.flatMap(v => [v >> 8, v & 255])));
    assert(p616.data instanceof Uint16Array && p616.bitDepth === 16);
    assert.deepStrictEqual([...p616.data], wide);
    // a narrower 16 bit scale keeps its maxval and raw values
    const p5n = decodeNetpbm(bytes('P5\n2 1\n300\n', [1, 44, 0, 200]));
    assert.deepStrictEqual([p5n.bitDepth, p5n.maxval, ...p5n.data], [16, 300, 300, 200]);

    // PAM with alpha: GRAYSCALE_ALPHA and RGB_ALPHA
    const pam = decodeNetpbm(bytes('P7\n# comment\nWIDTH 1\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n', [1, 2, 3, 4, 5, 6, 7, 8]));
    assert.deepStrictEqual([pam.channels, ...pam.data], [4, 1, 2, 3, 4, 5, 6, 7, 8]);

    // detection
    assert(isNetpbm(ascii('P5\n1 1\n255\n')) && isNetpbm(ascii('P7\nWIDTH 1\n')));
    assert(!isNetpbm(ascii('P4\n1 1\n')) && !isNetpbm(ascii('P5')));

    // invalid fields are rejected with the field's name and offset
    const expectError = (data, field, offset) => {
        try {
            decodeNetpbm(data);
            assert.fail(`expected an error about ${field}`);
        } catch (e) {
            assert(e instanceof RasterError, `not a RasterError: ${e}`);
            assert.strictEqual(e.field, field, `${e.message}: field`);
            if (offset !== undefined) assert.strictEqual(e.offset, offset, `${e.message}: offset`);
            assert(e.message.includes(field), `the message names ${field}: ${e.message}`);
        }
    };
    expectError(ascii('P5\nx 1\n255\n'), 'width', 3);
    expectError(ascii('P5\n0 1\n255\n'), 'width', 3);
    expectError(ascii('P5\n1 1\n0\n'), 'maxval', 7);
    expectError(ascii('P5\n1 1\n65536\n'), 'maxval', 7);
    expectError(ascii('P6\n1 1\n255'), 'maxval'); // truncated header
    expectError(ascii('P7\nWIDTH 1\n'), 'header'); // no ENDHDR
    expectError(bytes('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 5\nMAXVAL 255\nENDHDR\n', []), 'depth');

    // truncation and trailing trailing data are rejected, the offset is where the data ended / the first trailing byte
    const truncated = bytes('P5\n2 2\n255\n', [1, 2, 3]);
    expectError(truncated, 'pixels', truncated.length);
    expectError(bytes('P5\n2 2\n255\n', [1, 2, 3, 4, 5]), 'pixels', 15);

    // overflowing dimensions and the byte limit are rejected before allocation
    expectError(ascii(`P5\n${2 ** 30} ${2 ** 30}\n255\n`), 'pixels');
    expectError(ascii(`P6\n9999999999 9999999999\n255\n`), 'pixels');
    try {
        decodeNetpbm(bytes('P5\n4 4\n255\n', new Array(16).fill(0)), { maxBytes: 8 });
        assert.fail('maxBytes not enforced');
    } catch (e) {
        assert.strictEqual(e.field, 'pixels');
    }

    // the decoded data is a copy: it doesn't alias the caller's buffer
    const source = bytes('P5\n1 1\n255\n', [7]);
    const decoded = decodeNetpbm(source);
    decoded.data[0] = 9;
    assert.strictEqual(source[source.length - 1], 7);

    // round trips: 8 and 16 bit, greyscale, RGB and both alpha layouts
    const roundTrips = [
        { width: 3, height: 2, channels: 1, bitDepth: 8, maxval: 255, data: Uint8Array.from([...Array(6)].map((_, i) => i * 40)) },
        { width: 2, height: 2, channels: 3, bitDepth: 8, maxval: 255, data: Uint8Array.from([...Array(12)].map((_, i) => i * 20)) },
        { width: 2, height: 1, channels: 2, bitDepth: 8, maxval: 255, data: Uint8Array.from([10, 20, 30, 40]) },
        { width: 1, height: 2, channels: 4, bitDepth: 8, maxval: 255, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) },
        { width: 2, height: 1, channels: 3, bitDepth: 16, maxval: 65535, data: Uint16Array.from([0, 1, 256, 32768, 65534, 65535]) },
        { width: 1, height: 1, channels: 4, bitDepth: 16, maxval: 1000, data: Uint16Array.from([1000, 999, 0, 500]) },
    ];
    for (const raster of roundTrips) {
        const back = decodeNetpbm(encodeNetpbm(raster));
        assert.strictEqual(back.bitDepth, raster.bitDepth);
        assert.strictEqual(back.maxval, raster.maxval);
        assert.strictEqual(back.channels, raster.channels);
        assert.deepStrictEqual([...back.data], [...raster.data], `${raster.channels} channels ${raster.bitDepth} bit`);
    }

    // encoding streams in small chunks that concatenate to the same bytes
    const big = { width: 300, height: 300, channels: 3, bitDepth: 16, maxval: 65535, data: new Uint16Array(300 * 300 * 3).map((_, i) => i * 7 & 0xffff) };
    const chunks = [...encodeChunks(big)];
    assert(chunks.length > 2, 'the encoding is chunked');
    for (const chunk of chunks.slice(1)) assert(chunk.length <= ENCODE_CHUNK, 'chunks are small');
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((o, c) => (joined.set(c, o), o + c.length), 0);
    assert.deepStrictEqual(joined, encodeNetpbm(big));

    // TIFF-like tiles with a row stride: a 5x3 image in 4x2 tiles, rows padded to 6 bytes
    const descriptor = { width: 5, height: 3, tileWidth: 4, tileHeight: 2, channels: 1, bitDepth: 8, rowStride: 6 };
    const tileBytes = (tile, rows) => {
        const out = [];
        for (let r = 0; r < rows; r++) out.push(...[...Array(4)].map((_, x) => tile * 40 + r * 10 + x), 0, 0);
        return out;
    };
    const tiles = [tileBytes(0, 2), tileBytes(1, 2), tileBytes(2, 1), tileBytes(3, 1)];
    const offsets = [];
    tiles.reduce((o, t) => (offsets.push(o), o + t.length), 0);
    const buffer = Uint8Array.from(tiles.flat());
    const tiled = readTiles(buffer, { ...descriptor, tiles: offsets.map(offset => ({ offset })) });
    assert.deepStrictEqual([tiled.width, tiled.height], [5, 3]);
    assert.deepStrictEqual([...tiled.data], [
        0, 1, 2, 3, 40,
        10, 11, 12, 13, 50,
        80, 81, 82, 83, 120,
    ]);

    // tile descriptors are validated before anything is allocated
    assert.throws(() => readTiles(buffer, { ...descriptor, rowStride: 3, tiles: [{ offset: 0 }] }), /row stride/);
    assert.throws(() => readTiles(buffer, { ...descriptor, tiles: [{ offset: 0 }] }), /tiles/);
    assert.throws(() => readTiles(buffer, { ...descriptor, tiles: [0, 12, 24, 36].map(offset => ({ offset: offset + 1000 })) }), /past the data's end/);
    assert.throws(() => readTiles(buffer, { ...descriptor, tiles: [0, 12, 24, 36].map(offset => ({ offset, byteCount: 1 })) }), /of 10 bytes/);
    assert.throws(() => readTiles(buffer, { ...descriptor, width: 2 ** 30, height: 2 ** 30, tiles: [] }), /overflow/);

    // 16 bit tiles, big endian in the buffer
    const t16 = readTiles(Uint8Array.from([0x12, 0x34, 0xff, 0xff, 0, 0, 0x00, 0x01, 0x80, 0x00, 0, 0]),
        { width: 2, height: 2, tileWidth: 2, tileHeight: 2, channels: 1, bitDepth: 16, rowStride: 6, tiles: [{ offset: 0 }] });
    assert.deepStrictEqual([...t16.data], [0x1234, 0xffff, 0x0001, 0x8000]);

    // streamed file encoding: the file decodes to the same raster, no temporary files remain
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-'));
    const file = path.join(dir, 'image.pam');
    const alpha16 = { width: 17, height: 13, channels: 4, bitDepth: 16, maxval: 65535, data: new Uint16Array(17 * 13 * 4).map((_, i) => i * 313 & 0xffff) };
    await writeNetpbmFile(alpha16, file);
    const fromFile = decodeNetpbm(fs.readFileSync(file));
    assert.deepStrictEqual([...fromFile.data], [...alpha16.data]);
    assert.deepStrictEqual(fs.readdirSync(dir), ['image.pam'], 'no temporary files remain');

    // a failing write cleans its temporary file up (a raster whose data is too short fails mid-stream)
    const corrupt = { width: 10, height: 10, channels: 3, bitDepth: 8, maxval: 255, data: new Uint8Array(10) };
    await assert.rejects(writeNetpbmFile(corrupt, path.join(dir, 'corrupt.ppm')));
    assert.deepStrictEqual(fs.readdirSync(dir), ['image.pam'], 'the temporary file was removed');

    // a target in a missing directory rejects and leaves nothing behind
    await assert.rejects(writeNetpbmFile(roundTrips[0], path.join(dir, 'missing', 'x.pgm')));
    assert.deepStrictEqual(fs.readdirSync(dir), ['image.pam']);

    fs.rmSync(dir, { recursive: true });
    console.log('lossless-netpbm: ok');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
