// Strict, lossless Netpbm rasters: raw PGM (P5) and PPM (P6) with 8-bit or big endian 16-bit samples, and PAM (P7)
// when alpha is involved.
//
// Unlike a general-purpose decoder, this one keeps the sample values and the bit depth: a 16-bit image stays 16-bit,
// and nothing is scaled to 8 bits. Header parsing is exact about where the pixels start: after MAXVAL exactly one
// whitespace byte is consumed, so a first pixel byte of 0x20 (space) or 0x23 ('#') is data, not a comment.
//
// Every size is checked (including multiplication overflow) against the caller's buffer budget *before* allocating,
// and trailing bytes, truncation, out-of-range samples and header garbage are rejected with the field name and offset.

import { BinaryError, BinaryReader, BinaryWriter } from '../util/binary.ts';
import { Raster, RasterAlpha, RasterData, checkMaxval } from '../util/raster.ts';

/** The default budget for one decoded or encoded raster: 1 GiB */
export const DEFAULT_MAX_RASTER_BYTES = 1024 * 1024 * 1024;

/** The options of the strict Netpbm decoder and encoder */
export interface NetpbmRasterOptions {
    /** The largest buffer the samples may need, in bytes (default {@link DEFAULT_MAX_RASTER_BYTES}) */
    maxBytes?: number;
    /** The largest number of pixels (default: the package's global pixel limit) */
    maxPixels?: number;
}

const SPACE = 0x20;
const HASH = 0x23;
const isWhitespace = (c: number): boolean => c === SPACE || (c >= 0x09 && c <= 0x0d);

/** Whether data starts like a raw PGM, PPM or PAM (P5, P6, P7 followed by whitespace) */
export function isNetpbmRaster(data: Uint8Array): boolean {
    if (data.length < 3 || data[0] !== 0x50) return false;
    if (data[1] === 0x37) return isWhitespace(data[2]);
    return (data[1] === 0x35 || data[1] === 0x36) && isWhitespace(data[2]);
}

// multiplies sizes, rejecting unsafe products before anything is allocated
function product(factors: readonly number[], field: string, offset: number, length: number): number {
    let value = 1;
    for (const factor of factors) {
        if (!Number.isSafeInteger(factor) || factor < 0)
            throw new BinaryError(`Invalid ${field} (${factor})`, field, offset, length);
        value *= factor;
        if (!Number.isSafeInteger(value))
            throw new BinaryError(`${field} overflows a safe integer`, field, offset, length);
    }
    return value;
}

/** The largest sample value for a bit depth */
function maxvalOfBits(bits: 8 | 16): number {
    return bits === 8 ? 255 : 65535;
}

// skips whitespace and comments in the header (not after MAXVAL, where only one separator byte is consumed)
function skipHeaderSpace(reader: BinaryReader, field: string): void {
    const data = reader.data;
    for (;;) {
        if (reader.done) return;
        const c = data[reader.offset];
        if (c === HASH) {
            while (!reader.done && data[reader.offset] !== 0x0a && data[reader.offset] !== 0x0d) reader.skip(1, field);
        } else if (isWhitespace(c)) reader.skip(1, field);
        else return;
    }
}

// reads a decimal header token (a run of digits) and leaves the cursor at its terminator
function headerInteger(reader: BinaryReader, field: string): number {
    skipHeaderSpace(reader, field);
    const data = reader.data;
    const start = reader.offset;
    let value = 0;
    while (!reader.done && data[reader.offset] >= 0x30 && data[reader.offset] <= 0x39) {
        // (bound the digit run before it can leave the safe integer range)
        if (reader.offset - start >= 10) throw new BinaryError(`Invalid ${field}: too many digits`, field, start, data.length);
        value = value * 10 + data[reader.offset] - 0x30;
        reader.skip(1, field);
    }
    if (reader.offset === start) throw new BinaryError(`Invalid ${field}: expected a decimal number`, field, start, data.length);
    return value;
}

interface NetpbmHeader {
    format: 'P5' | 'P6' | 'P7';
    width: number;
    height: number;
    channels: 1 | 2 | 3 | 4;
    maxval: number;
    dataOffset: number;
    alpha: RasterAlpha;
}

// P7's header: KEY VALUE lines up to ENDHDR. Only the keys the format defines are accepted
function pamHeader(reader: BinaryReader): NetpbmHeader {
    const fields = new Map<string, string>();
    const data = reader.data;
    reader.seek(2, 'magic');
    // (the magic's own line break is part of the line structure: P7 headers start right after it)
    if (reader.done) throw new BinaryError('Truncated PAM header', 'magic', 2, data.length);
    if (!isWhitespace(data[reader.offset])) throw new BinaryError('Invalid PAM header: a line break must follow P7', 'magic', 2, data.length);
    while (!reader.done && data[reader.offset] !== 0x0a) reader.skip(1, 'P7');

    let tupleType = '';
    for (;;) {
        if (reader.done) throw new BinaryError('Truncated PAM header: ENDHDR missing', 'ENDHDR', reader.offset, data.length);
        const lineStart = reader.offset;
        let end = lineStart;
        while (end < data.length && data[end] !== 0x0a) end++;
        if (end >= data.length) throw new BinaryError('Truncated PAM header line', 'header line', lineStart, data.length);
        let line = '';
        for (let i = lineStart; i < end; i++) line += String.fromCharCode(data[i]);
        reader.seek(end + 1, 'header line');
        // (a trailing CR of a CRLF line ending)
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed === 'ENDHDR') break;

        const match = /^([A-Za-z]+)[ \t]+(.*)$/.exec(line);
        if (!match) throw new BinaryError('Invalid PAM header line', 'header line', lineStart, data.length);
        const key = match[1], value = match[2].trim();
        if (key === 'TUPLTYPE') {
            if (tupleType) throw new BinaryError('Duplicate TUPLTYPE', 'TUPLTYPE', lineStart, data.length);
            tupleType = value;
        } else if (['WIDTH', 'HEIGHT', 'DEPTH', 'MAXVAL'].includes(key)) {
            if (fields.has(key)) throw new BinaryError(`Duplicate ${key}`, key, lineStart, data.length);
            if (!/^\d{1,10}$/.test(value)) throw new BinaryError(`Invalid ${key}`, key, lineStart, data.length);
            fields.set(key, value);
        } else throw new BinaryError(`Unknown PAM field ${key}`, key, lineStart, data.length);
    }

    for (const key of ['WIDTH', 'HEIGHT', 'DEPTH', 'MAXVAL'])
        if (!fields.has(key)) throw new BinaryError(`Missing PAM field ${key}`, key, reader.offset, data.length);

    const width = +fields.get('WIDTH')!, height = +fields.get('HEIGHT')!, depth = +fields.get('DEPTH')!;
    const maxval = checkMaxval(+fields.get('MAXVAL')!, 'MAXVAL');
    if (depth < 1 || depth > 4) throw new BinaryError(`Unsupported PAM depth ${depth}`, 'DEPTH', reader.offset, data.length);
    checkHeader(width, height, maxval, reader.offset, data.length);

    // the tuple type is optional, but when present it has to agree with the depth
    const expected: Record<number, string[]> = {
        1: ['BLACKANDWHITE', 'GRAYSCALE', ''],
        2: ['GRAYSCALE_ALPHA', 'BLACKANDWHITE_ALPHA'],
        3: ['RGB', ''],
        4: ['RGB_ALPHA'],
    };
    if (tupleType && !expected[depth].includes(tupleType))
        throw new BinaryError(`TUPLTYPE ${tupleType} does not fit depth ${depth}`, 'TUPLTYPE', reader.offset, data.length);

    return {
        format: 'P7', width, height, channels: depth as 1 | 2 | 3 | 4, maxval,
        // (PAM's alpha is unassociated by definition; BLACKANDWHITE_ALPHA is 1-bit inverted like PBM, see below)
        alpha: depth === 2 || depth === 4 ? 'straight' : 'straight',
        dataOffset: reader.offset,
    };
}

function checkHeader(width: number, height: number, maxval: number, offset: number, length: number): void {
    if (!Number.isSafeInteger(width) || width < 1) throw new BinaryError(`Invalid width ${width}`, 'width', offset, length);
    if (!Number.isSafeInteger(height) || height < 1) throw new BinaryError(`Invalid height ${height}`, 'height', offset, length);
    checkMaxval(maxval, 'maxval');
}

/**
 * Reads the header of a raw Netpbm raster, leaving the reader at the first pixel byte
 * @param reader The reader positioned at the magic number
 */
function readHeader(reader: BinaryReader): NetpbmHeader {
    const data = reader.data;
    reader.seek(0, 'magic');
    if (reader.length < 2) throw new BinaryError('Truncated magic number', 'magic', 0, reader.length);
    if (data[0] !== 0x50) throw new BinaryError('Invalid magic number', 'magic', 0, reader.length);
    const kind = data[1];
    if (kind === 0x37) return pamHeader(reader);

    if (kind !== 0x35 && kind !== 0x36) throw new BinaryError(`Unsupported Netpbm format P${String.fromCharCode(kind)}`, 'magic', 1, reader.length);
    const format = kind === 0x35 ? 'P5' : 'P6';
    reader.seek(2, 'magic');
    if (reader.done || !isWhitespace(data[2])) throw new BinaryError('Invalid magic number: whitespace must follow', 'magic', 2, reader.length);

    const width = headerInteger(reader, 'width');
    const height = headerInteger(reader, 'height');
    const maxval = headerInteger(reader, 'maxval');
    checkHeader(width, height, maxval, reader.offset, reader.length);

    // exactly one separator byte, so a first pixel byte of ' ' or '#' stays data
    if (reader.done) throw new BinaryError('Truncated header: no pixel data', 'pixels', reader.offset, reader.length);
    if (!isWhitespace(data[reader.offset]))
        throw new BinaryError('Invalid header: a single whitespace byte must separate MAXVAL from the pixels', 'pixels', reader.offset, reader.length);
    reader.skip(1, 'pixels');

    return { format, width, height, channels: format === 'P5' ? 1 : 3, maxval, dataOffset: reader.offset, alpha: 'straight' };
}

/**
 * Decodes a raw Netpbm raster (P5, P6, or PAM P7) without losing bit depth. 16-bit samples must be big endian and are
 * kept as a Uint16Array; 8-bit ones become a Uint8Array. The channel order follows the format (grey, RGB, grey+alpha,
 * RGBA). Throws {@link BinaryError} naming the field and offset for any structural problem, and RangeError for a
 * buffer that would exceed `maxBytes` or `maxPixels` (both are checked before allocating)
 * @param input The file data
 * @param options The buffer and pixel budgets
 */
export function decodeNetpbmRaster(input: Uint8Array, options: NetpbmRasterOptions = {}): Raster {
    if (!(input instanceof Uint8Array)) throw new TypeError('Netpbm input must be a Uint8Array');
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_RASTER_BYTES;
    const maxPixels = options.maxPixels ?? Infinity;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes must be a positive integer, not ${maxBytes}`);

    const reader = new BinaryReader(input, true);
    if (!isNetpbmRaster(input)) throw new BinaryError('Invalid Netpbm header', 'magic', 0, input.length);
    const header = readHeader(reader);
    const { width, height, channels, maxval, dataOffset } = header;

    // (the pixel budget too is checked before the sample count becomes an allocation)
    if (!(width * height <= maxPixels))
        throw new RangeError(`Netpbm: ${width}x${height} exceeds the pixel limit of ${maxPixels}`);

    const bits: 8 | 16 = maxval > 255 ? 16 : 8;
    const bytesPerSample = bits / 8;
    const sampleCount = product([width, height, channels], 'sample count', dataOffset, input.length);
    const byteCount = product([sampleCount, bytesPerSample], 'sample bytes', dataOffset, input.length);
    if (byteCount > maxBytes) throw new RangeError(`Netpbm: ${byteCount} sample bytes exceed the limit of ${maxBytes}`);

    const start = dataOffset;
    const end = start + byteCount;
    if (end > input.length)
        throw new BinaryError(`Truncated pixels: needs ${byteCount} bytes`, 'pixels', start, input.length);
    if (end < input.length)
        throw new BinaryError(`Trailing data after the pixels: ${input.length - end} bytes`, 'pixels', end, input.length);

    const data: RasterData = bits === 8 ? new Uint8Array(sampleCount) : new Uint16Array(sampleCount);
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    // (8-bit PAM BLACKANDWHITE_ALPHA inverts like PBM; P5/P6 have no such tuple type)
    const blackAndWhite = header.format === 'P7' && maxval === 1 && header.channels < 3;

    for (let i = 0; i < sampleCount; i++) {
        const value = bits === 8 ? input[start + i] : view.getUint16(start + i * 2, false);
        if (value > maxval)
            throw new BinaryError(`Sample ${value} exceeds MAXVAL ${maxval}`, 'pixels', start + i * bytesPerSample, input.length);
        data[i] = blackAndWhite && (i % channels === 0 || channels === 2) ? (value ? 0 : 1) : value;
    }

    return {
        width, height, channels, maxval, data,
        ...(channels === 2 || channels === 4 ? { alpha: 'straight' as const } : {}),
    };
}

/** The Netpbm format an encoder should use for a raster */
export function netpbmFormatOf(raster: Raster): 'P5' | 'P6' | 'P7' {
    if (raster.channels === 1) return 'P5';
    if (raster.channels === 3) return 'P6';
    return 'P7';
}

// validates that every sample fits the raster's declared maximum (a caller-built raster might not)
function checkSamples(raster: Raster): void {
    const { maxval, data } = raster;
    for (let i = 0; i < data.length; i++)
        if (data[i] > maxval) throw new RangeError(`The raster has a sample of ${data[i]}, above its maxval of ${maxval}`);
}

/**
 * Encodes a raster as raw Netpbm: P5 for grey, P6 for RGB and PAM (P7) for grey+alpha and RGBA. The bit depth follows
 * `maxval` (more than 255 means 16-bit big endian samples); samples are never scaled or quantised. PAM cannot record
 * premultiplied alpha, so a premultiplied raster is un-premultiplied (with the module's fixed rounding) and the header
 * says nothing about alpha: the pixels are straight.
 * @param raster The raster to encode
 * @param options The buffer budget
 */
export function encodeNetpbmRaster(raster: Raster, options: NetpbmRasterOptions = {}): Uint8Array {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_RASTER_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes must be a positive integer, not ${maxBytes}`);

    const chunks = netpbmChunks(raster, { ...options, maxBytes, chunkBytes: maxBytes });
    const parts: Uint8Array[] = [];
    let length = 0;
    for (const chunk of chunks) { parts.push(chunk); length += chunk.length; }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

/**
 * Streams an encoded Netpbm raster in small chunks (a header, then blocks of rows of at most `chunkBytes`). Nothing the
 * caller passes is modified; encoding is deterministic, so the concatenation of the chunks is exactly
 * {@link encodeNetpbmRaster}'s result. Yields nothing until the whole raster has been validated
 * @param raster The raster to encode
 * @param options The buffer budget and the chunk size (default 64 KiB)
 */
export function* netpbmChunks(raster: Raster, options: NetpbmRasterOptions & { chunkBytes?: number } = {}): Generator<Uint8Array> {
    const { checkRaster } = requireRasterChecks();
    checkRaster(raster);
    checkSamples(raster);

    const { width, height, channels, maxval } = raster;
    const bits: 8 | 16 = maxval > 255 ? 16 : 8;
    const bytesPerSample = bits / 8;
    const rowBytes = product([width, channels, bytesPerSample], 'row bytes', 0, 0);
    const total = product([rowBytes, height], 'sample bytes', 0, 0);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_RASTER_BYTES;
    if (total > maxBytes) throw new RangeError(`Netpbm: ${total} sample bytes exceed the limit of ${maxBytes}`);

    const format = netpbmFormatOf(raster);
    const header = new BinaryWriter(256);
    if (format === 'P7') {
        const grey = channels === 2;
        header.ascii(`P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH ${channels}\nMAXVAL ${maxval}\n`)
            .ascii(`TUPLTYPE ${grey ? 'GRAYSCALE_ALPHA' : 'RGB_ALPHA'}\nENDHDR\n`);
    } else {
        header.ascii(format).ascii(`\n${width} ${height}\n${maxval}\n`);
    }
    yield header.toUint8Array();

    // premultiplied alpha is not representable in PAM: un-premultiply the samples as they are written
    const source = raster.alpha === 'premultiplied' && (channels === 2 || channels === 4) ? unpremultipliedSamples(raster) : raster.data;
    const alphaIndex = channels === 2 || channels === 4 ? channels - 1 : -1;

    const rowsPerChunk = Math.max(1, Math.floor((options.chunkBytes ?? 65536) / rowBytes));
    const chunk = new Uint8Array(Math.min(height, rowsPerChunk) * rowBytes);
    const view = new DataView(chunk.buffer);
    for (let first = 0; first < height; first += rowsPerChunk) {
        const rows = Math.min(rowsPerChunk, height - first);
        const bytes = rows * rowBytes;
        let o = 0;
        for (let s = first * width * channels, end = (first + rows) * width * channels; s < end; s++, o += bytesPerSample) {
            const value = source[s];
            // (the alpha of a premultiplied raster was just converted; it is written like any other sample)
            void alphaIndex;
            if (bits === 8) chunk[o] = value;
            else view.setUint16(o, value, false);
        }
        yield chunk.slice(0, bytes);
    }
}

// the color-ops helper, imported lazily to keep this module's imports acyclic and its header path lean
function unpremultipliedSamples(raster: Raster): RasterData {
    // (a local implementation of unpremultiplyAlpha's exact arithmetic, so the encoder's output does not depend on
    //  import order)
    const { channels, maxval, data } = raster;
    const out: RasterData = data instanceof Uint8Array ? new Uint8Array(data.length) : new Uint16Array(data.length);
    out.set(data);
    const a = channels - 1;
    for (let s = 0; s < data.length; s += channels) {
        const alpha = data[s + a];
        if (alpha === maxval) continue;
        if (alpha === 0) {
            for (let c = 0; c < a; c++) out[s + c] = 0;
            continue;
        }
        for (let c = 0; c < a; c++) {
            const value = Math.floor(data[s + c] * maxval / alpha + 0.5);
            out[s + c] = value > maxval ? maxval : value;
        }
    }
    return out;
}

// checkRaster lives in raster.ts; this indirection keeps the import list of the hot decoder small
import { checkRaster } from '../util/raster.ts';
function requireRasterChecks(): { checkRaster: typeof checkRaster } {
    return { checkRaster };
}

/** The maximum value of a bit depth (exported for callers sizing their own buffers) */
export { maxvalOfBits };
