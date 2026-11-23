// Color and geometry operators on lossless rasters. Every operator returns a new raster and never mutates its
// input. Every float that becomes a sample is rounded the same fixed way: Math.round (halves toward positive
// infinity), then clamped to the sample range; NaN samples become 0, infinite ones the full-scale value

import { Raster, RasterError, hasAlpha, blank, checkedSampleBytes } from './raster.ts';

const round = Math.round;

// NaN (every comparison is false) and negative values become 0, anything past the full scale clamps to it
const clampSample = (v: number, max: number): number => v >= 0 ? (v > max ? max : v) : 0;

// the number of color channels: all but a trailing alpha
const colorChannels = (channels: number): number => channels === 2 || channels === 4 ? channels - 1 : channels;

// sRGB electro-optical transfer (and its inverse), tabulated over the raster's scale for reproducibility
function transferTable(maxval: number, direction: 'linear' | 'srgb'): Uint16Array {
    const table = new Uint16Array(maxval + 1);
    for (let v = 0; v <= maxval; v++) {
        const c = v / maxval;
        const t = direction === 'linear'
            ? c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
            : c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
        table[v] = clampSample(round(t * maxval), maxval);
    }
    return table;
}

type Samples = Uint8Array | Uint16Array;

/** Converts rows y0..y1 of color channels between sRGB and linear light (alpha is copied), input into output */
export function convertTile(direction: 'linear' | 'srgb', input: Samples, output: Samples, width: number, channels: number, maxval: number, y0: number, y1: number): void {
    const table = transferTable(maxval, direction);
    const color = colorChannels(channels);
    const end = y1 * width * channels;
    for (let i = y0 * width * channels; i < end;) {
        for (let c = 0; c < color; c++, i++) output[i] = table[input[i]];
        if (color !== channels) {
            output[i] = input[i];
            i++;
        }
    }
}

/** Premultiplies rows y0..y1 (color = color * alpha / maxval, rounded), input into output */
export function premultiplyTile(input: Samples, output: Samples, width: number, channels: number, maxval: number, y0: number, y1: number): void {
    const color = colorChannels(channels);
    if (color === channels) throw new RasterError('premultiplying needs an alpha channel', 'channels');
    const end = y1 * width * channels;
    for (let i = y0 * width * channels; i < end; i += channels) {
        const a = input[i + channels - 1];
        output[i + channels - 1] = a;
        if (a === maxval) {
            for (let c = 0; c < color; c++) output[i + c] = input[i + c];
        } else if (a === 0) {
            for (let c = 0; c < color; c++) output[i + c] = 0;
        } else {
            for (let c = 0; c < color; c++) output[i + c] = round(input[i + c] * a / maxval);
        }
    }
}

/** Unpremultiplies rows y0..y1 (color = color * maxval / alpha, rounded and clamped; alpha 0 stays all zero) */
export function unpremultiplyTile(input: Samples, output: Samples, width: number, channels: number, maxval: number, y0: number, y1: number): void {
    const color = colorChannels(channels);
    if (color === channels) throw new RasterError('unpremultiplying needs an alpha channel', 'channels');
    const end = y1 * width * channels;
    for (let i = y0 * width * channels; i < end; i += channels) {
        const a = input[i + channels - 1];
        output[i + channels - 1] = a;
        if (a === 0) {
            for (let c = 0; c < color; c++) output[i + c] = 0;
        } else if (a === maxval) {
            for (let c = 0; c < color; c++) output[i + c] = input[i + c];
        } else {
            for (let c = 0; c < color; c++) output[i + c] = Math.min(maxval, round(input[i + c] * maxval / a));
        }
    }
}

/** The greyscale histogram of rows y0..y1 (Rec. 601 luma, rounded; alpha ignored), maxval + 1 bins */
export function histogramTile(input: Samples, width: number, channels: number, maxval: number, y0: number, y1: number): Uint32Array {
    const histogram = new Uint32Array(maxval + 1);
    const end = y1 * width * channels;
    if (channels === 3 || channels === 4) {
        for (let i = y0 * width * channels; i < end; i += channels)
            histogram[clampSample(round(0.299 * input[i] + 0.587 * input[i + 1] + 0.114 * input[i + 2]), maxval)]++;
    } else {
        for (let i = y0 * width * channels; i < end; i += channels) histogram[input[i]]++;
    }
    return histogram;
}

/** A raster converted between sRGB and linear light (color channels only, alpha kept) */
export function convert(raster: Raster, direction: 'linear' | 'srgb'): Raster {
    const out = blank(raster.width, raster.height, raster.channels, raster.bitDepth, raster.maxval);
    convertTile(direction, raster.data, out.data, raster.width, raster.channels, raster.maxval, 0, raster.height);
    return out;
}

/** sRGB samples as linear light */
export const toLinearLight = (raster: Raster): Raster => convert(raster, 'linear');

/** Linear light samples as sRGB */
export const toSrgb = (raster: Raster): Raster => convert(raster, 'srgb');

/** The raster with its color channels premultiplied by its alpha channel */
export function premultiply(raster: Raster): Raster {
    const out = blank(raster.width, raster.height, raster.channels, raster.bitDepth, raster.maxval);
    premultiplyTile(raster.data, out.data, raster.width, raster.channels, raster.maxval, 0, raster.height);
    return out;
}

/** The inverse of premultiply: unpremultiply(premultiply(r)) is r, up to one rounding step per channel */
export function unpremultiply(raster: Raster): Raster {
    const out = blank(raster.width, raster.height, raster.channels, raster.bitDepth, raster.maxval);
    unpremultiplyTile(raster.data, out.data, raster.width, raster.channels, raster.maxval, 0, raster.height);
    return out;
}

/** The greyscale histogram of the whole raster (see histogramTile) */
export function histogramGray(raster: Raster): Uint32Array {
    return histogramTile(raster.data, raster.width, raster.channels, raster.maxval, 0, raster.height);
}

/** The operators that run tiled over a raster's rows (see parallel.ts) */
export type TileOp = 'to-linear' | 'to-srgb' | 'premultiply' | 'unpremultiply' | 'histogram';

/**
 * Runs one tile of an operator on rows y0..y1: raster operators write into output and return null, histogram
 * returns its rows' histogram. Unknown operators throw
 */
export function runTile(op: string, input: Samples, output: Samples | undefined, width: number, channels: number, maxval: number, y0: number, y1: number): Uint32Array | null {
    switch (op) {
        case 'to-linear': convertTile('linear', input, output as Samples, width, channels, maxval, y0, y1); return null;
        case 'to-srgb': convertTile('srgb', input, output as Samples, width, channels, maxval, y0, y1); return null;
        case 'premultiply': premultiplyTile(input, output as Samples, width, channels, maxval, y0, y1); return null;
        case 'unpremultiply': unpremultiplyTile(input, output as Samples, width, channels, maxval, y0, y1); return null;
        case 'histogram': return histogramTile(input, width, channels, maxval, y0, y1);
        default: throw new RasterError(`unknown operator ${op}`, 'op');
    }
}

/**
 * A histogram's p-th percentile (nearest rank: the smallest value the rank ceil(p / 100 * total) falls into; p 0 is
 * the minimum). p must be a finite number within 0..100
 */
export function percentile(histogram: Uint32Array, p: number): number {
    if (!Number.isFinite(p) || p < 0 || p > 100) throw new RangeError(`invalid percentile ${p}`);
    let total = 0;
    for (const count of histogram) total += count;
    if (!total) throw new RasterError('the percentile of an empty histogram', 'histogram');
    const rank = Math.max(1, Math.ceil(p / 100 * total));
    let seen = 0;
    for (let v = 0; v < histogram.length; v++) {
        seen += histogram[v];
        if (seen >= rank) return v;
    }
    return histogram.length - 1;
}

// one clockwise quarter turn
function quarterTurn(raster: Raster): Raster {
    const { width, height, channels } = raster;
    const out = blank(height, width, channels, raster.bitDepth, raster.maxval);
    const src = raster.data, dst = out.data;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = (y * width + x) * channels;
            const to = (x * height + (height - 1 - y)) * channels;
            for (let c = 0; c < channels; c++) dst[to + c] = src[from + c];
        }
    }
    return out;
}

/**
 * The raster rotated clockwise by 90 degrees times `times` (negative turns counterclockwise). Exact: samples are
 * copied, never interpolated
 */
export function rotate90(raster: Raster, times = 1): Raster {
    if (!Number.isSafeInteger(times)) throw new RangeError(`invalid turn count ${times}`);
    const t = ((times % 4) + 4) % 4;
    let out = raster;
    for (let i = 0; i < t; i++) out = quarterTurn(out);
    if (out === raster) return { ...raster, data: raster.data.slice() };
    return out;
}

/**
 * Bilinear scaling to width x height. With an alpha channel the colors are scaled premultiplied (so fully
 * transparent pixels contribute no color) and unpremultiplied afterwards; a fully transparent result stays all zero
 */
export function scaleBilinear(raster: Raster, width: number, height: number): Raster {
    checkedSampleBytes(width, height, raster.channels, raster.bitDepth);
    const { channels, maxval } = raster;
    const alpha = hasAlpha(raster);
    const source = alpha ? premultiply(raster) : raster;
    const src = source.data;
    const out = blank(width, height, channels, raster.bitDepth, maxval);
    const dst = out.data;
    const sw = raster.width, sh = raster.height;

    for (let y = 0; y < height; y++) {
        const sy = Math.min(Math.max((y + 0.5) * sh / height - 0.5, 0), sh - 1);
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
        for (let x = 0; x < width; x++) {
            const sx = Math.min(Math.max((x + 0.5) * sw / width - 0.5, 0), sw - 1);
            const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
            const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
            const i00 = (y0 * sw + x0) * channels, i10 = (y0 * sw + x1) * channels;
            const i01 = (y1 * sw + x0) * channels, i11 = (y1 * sw + x1) * channels;
            const o = (y * width + x) * channels;
            for (let c = 0; c < channels; c++)
                dst[o + c] = clampSample(round(src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11), maxval);
        }
    }

    if (alpha) unpremultiplyTile(dst, dst, width, channels, maxval, 0, height);
    return out;
}
