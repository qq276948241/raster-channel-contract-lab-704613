// A strict lossless Netpbm reader and writer: raw PGM (P5) and PPM (P6), and PAM (P7) for images with alpha, at 8
// and 16 bits. 16 bit samples (big endian in the file) stay 16 bit; nothing is quantized. The reader separates
// header, comments, padding and the pixel data's start exactly: after the maxval token a single whitespace byte
// ends the header, and the pixel data's first byte is kept even when it is a space or a hash

import { Raster, RasterError, MAX_RASTER_BYTES, checkedSampleBytes, checkRaster } from './raster.ts';

const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);

/** Whether the data starts like a raw PGM/PPM or a PAM */
export function isNetpbm(d: Uint8Array): boolean {
    if (d.length < 3 || d[0] !== 0x50) return false;
    if (d[1] === 0x37) return d[2] === 0x0a;
    return (d[1] === 0x35 || d[1] === 0x36) && isSpace(d[2]);
}

interface Token {
    text: string;
    offset: number;
    end: number;
}

// the next token: whitespace and comments (# to the line's end) are skipped, the token runs to the next one of either
function token(d: Uint8Array, o: number): Token {
    while (o < d.length) {
        if (d[o] === 0x23) while (o < d.length && d[o] !== 0x0a && d[o] !== 0x0d) o++;
        else if (isSpace(d[o])) o++;
        else break;
    }
    const start = o;
    while (o < d.length && !isSpace(d[o]) && d[o] !== 0x23) o++;
    if (start === o) throw new RasterError('Netpbm: truncated header', 'header', start);
    return { text: String.fromCharCode(...d.subarray(start, o)), offset: start, end: o };
}

function integer(d: Uint8Array, o: number, field: string, max: number): { value: number, end: number } {
    const t = token(d, o);
    if (!/^\d{1,10}$/.test(t.text)) throw new RasterError(`Netpbm: invalid ${field} "${t.text.slice(0, 20)}"`, field, t.offset);
    const value = +t.text;
    if (value < 1 || value > max) throw new RasterError(`Netpbm: invalid ${field} ${value}`, field, t.offset);
    return { value, end: t.end };
}

interface Header {
    width: number;
    height: number;
    channels: number;
    maxval: number;
    /** The offset of the pixel data's first byte */
    start: number;
}

// P5/P6: magic, width, height, maxval, a single whitespace byte, then the pixels
function rawHeader(d: Uint8Array): Header {
    const channels = d[1] === 0x35 ? 1 : 3;
    const width = integer(d, 2, 'width', Number.MAX_SAFE_INTEGER);
    const height = integer(d, width.end, 'height', Number.MAX_SAFE_INTEGER);
    const maxval = integer(d, height.end, 'maxval', 65535);
    // the byte ending the header must be a single whitespace; a comment here would eat pixel data
    if (maxval.end >= d.length) throw new RasterError('Netpbm: truncated header', 'maxval', maxval.end);
    if (!isSpace(d[maxval.end])) throw new RasterError('Netpbm: the maxval must be followed by a single whitespace', 'maxval', maxval.end);
    return { width: width.value, height: height.value, channels, maxval: maxval.value, start: maxval.end + 1 };
}

// P7 (PAM): lines of a name and its value up to ENDHDR; comments are whole lines starting with #
function pamHeader(d: Uint8Array): Header {
    const fields: Record<string, { value: string, offset: number }> = {};
    let o = 3;
    for (;;) {
        let end = o;
        while (end < d.length && d[end] !== 0x0a) end++;
        if (end >= d.length) throw new RasterError('PAM: truncated header', 'header', o);
        const line = String.fromCharCode(...d.subarray(o, end)).trim();
        const offset = o;
        o = end + 1;
        if (line === 'ENDHDR') break;
        if (!line || line.startsWith('#')) continue;
        const space = line.search(/\s/);
        if (space < 1) throw new RasterError(`PAM: invalid header line "${line.slice(0, 20)}"`, 'header', offset);
        fields[line.slice(0, space)] = { value: line.slice(space + 1).trim(), offset };
    }

    const number = (name: string, max: number): number => {
        const field = fields[name];
        if (!field || !/^\d{1,10}$/.test(field.value)) throw new RasterError(`PAM: invalid ${name} "${field?.value.slice(0, 20) ?? ''}"`, name.toLowerCase(), field?.offset ?? o);
        const value = +field.value;
        if (value < 1 || value > max) throw new RasterError(`PAM: invalid ${name} ${value}`, name.toLowerCase(), field.offset);
        return value;
    };

    return {
        width: number('WIDTH', Number.MAX_SAFE_INTEGER),
        height: number('HEIGHT', Number.MAX_SAFE_INTEGER),
        channels: number('DEPTH', 4),
        maxval: number('MAXVAL', 65535),
        start: o,
    };
}

export interface NetpbmDecodeOptions {
    /** The most bytes of samples to accept (rejected before allocation), default MAX_RASTER_BYTES */
    maxBytes?: number;
}

/**
 * Decodes a raw PGM/PPM or PAM into a lossless raster. Truncated and trailing data, invalid dimensions, overflowing
 * sizes and images over the byte limit are rejected (before anything is allocated) with the field and offset
 */
export function decodeNetpbm(d: Uint8Array, options: NetpbmDecodeOptions = {}): Raster {
    if (!isNetpbm(d)) throw new RasterError('Netpbm: invalid magic', 'magic', 0);
    const header = d[1] === 0x37 ? pamHeader(d) : rawHeader(d);
    const { width, height, channels, maxval, start } = header;
    const bitDepth = maxval > 255 ? 16 : 8;

    // the size is checked before the pixel data's length is: both reject before the samples are allocated
    const bytes = checkedSampleBytes(width, height, channels, bitDepth, options.maxBytes ?? MAX_RASTER_BYTES, start);
    if (d.length < start + bytes)
        throw new RasterError(`Netpbm: truncated pixel data: ${d.length - start} of ${bytes} bytes`, 'pixels', d.length);
    if (d.length > start + bytes)
        throw new RasterError(`Netpbm: ${d.length - start - bytes} trailing byte(s)`, 'pixels', start + bytes);

    if (bitDepth === 8)
        // a copy: the raster never aliases the caller's buffer
        return { width, height, channels, bitDepth, maxval, data: d.slice(start, start + bytes) };

    const samples = new Uint16Array(bytes >> 1);
    for (let i = 0, p = start; i < samples.length; i++, p += 2) samples[i] = d[p] << 8 | d[p + 1];
    return { width, height, channels, bitDepth, maxval, data: samples };
}

const ascii = (text: string): Uint8Array => Uint8Array.from(text, c => c.charCodeAt(0));

/** The Netpbm header for a raster: P5/P6 without alpha, P7 (PAM) with it */
export function headerOf(raster: Raster): Uint8Array {
    const { width, height, channels, maxval } = raster;
    if (channels === 1) return ascii(`P5\n${width} ${height}\n${maxval}\n`);
    if (channels === 3) return ascii(`P6\n${width} ${height}\n${maxval}\n`);
    const type = channels === 2 ? 'GRAYSCALE_ALPHA' : 'RGB_ALPHA';
    return ascii(`P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH ${channels}\nMAXVAL ${maxval}\nTUPLTYPE ${type}\nENDHDR\n`);
}

/** The largest chunk encodeChunks yields (pixel rows are split to fit) */
export const ENCODE_CHUNK = 1 << 16;

/**
 * A raster as a Netpbm stream: the header, then the samples in chunks of at most ENCODE_CHUNK bytes. Channel order,
 * bit depth and alpha are kept; 16 bit samples are written big endian, never quantized to 8
 */
export function* encodeChunks(raster: Raster): Generator<Uint8Array> {
    checkRaster(raster);
    yield headerOf(raster);

    const { width, height, channels, bitDepth, data } = raster;
    const samplesPerRow = width * channels;
    if (bitDepth === 8) {
        const bytes = data as Uint8Array;
        for (let y = 0; y < height;) {
            const rows = Math.min(height - y, Math.max(1, ENCODE_CHUNK / samplesPerRow | 0));
            yield bytes.subarray(y * samplesPerRow, (y + rows) * samplesPerRow);
            y += rows;
        }
    } else {
        const samples = data as Uint16Array;
        const rowsPerChunk = Math.max(1, ENCODE_CHUNK / (samplesPerRow * 2) | 0);
        const chunk = new Uint8Array(rowsPerChunk * samplesPerRow * 2);
        for (let y = 0; y < height; y += rowsPerChunk) {
            const rows = Math.min(height - y, rowsPerChunk);
            let o = 0;
            for (let i = y * samplesPerRow, end = (y + rows) * samplesPerRow; i < end; i++) {
                const v = samples[i];
                chunk[o++] = v >> 8;
                chunk[o++] = v & 0xff;
            }
            yield chunk.subarray(0, rows * samplesPerRow * 2);
        }
    }
}

/** Encodes a raster into a single Netpbm buffer (encodeChunks joined) */
export function encodeNetpbm(raster: Raster): Uint8Array {
    const chunks = [...encodeChunks(raster)];
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let o = 0;
    for (const chunk of chunks) {
        out.set(chunk, o);
        o += chunk.length;
    }
    return out;
}
