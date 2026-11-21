// Geometry operators on lossless rasters: bilinear scaling and exact quarter turns.
//
// Both work on any channel count and bit depth, and preserve the channel order, the alpha tag and the bit depth. The
// input raster is never modified; every result is a new raster, so repeated calls cannot share a mutable cache.
//
// Bilinear sampling works in *premultiplied* space: interpolating straight alpha would pull translucent pixels' colour
// towards black (or, for `premultiplied` rasters, double-weight it). The result is un-premultiplied again, so a
// `straight` raster stays `straight` and a `premultiplied` one stays `premultiplied`.

import { Raster, RasterData, checkRaster, hasAlpha } from './raster.ts';
import { clampSample, roundHalfUp, unpremultiplyAlpha } from './color-ops.ts';

// weights are 16-bit fixed point, so the same inputs give the same output on every platform (no float rounding drift)
const FRACTION_BITS = 16;
const ONE = 1 << FRACTION_BITS;

/** Where one destination pixel's samples come from */
interface Tap {
    /** the source sample index of the top-left pixel */
    index: number;
    /** the sample step between horizontally adjacent source pixels */
    step: number;
    /** the sample step between vertically adjacent source pixels */
    stride: number;
    /** the four weights, summing to 65536 */
    w00: number; w10: number; w01: number; w11: number;
}

/**
 * The source coordinate of a destination position, "half-pixel" centre convention:
 * `src = (dst + 0.5) * srcSize / dstSize - 0.5`, in integer arithmetic. A position outside the source is clamped to the
 * nearest edge sample, so the border pixels repeat instead of reading outside the raster.
 */
function sourcePosition(dst: number, dstSize: number, srcSize: number): { index: number, weight: number } {
    // in halves: (2 dst + 1) * srcSize / dstSize - 1, over 2 * dstSize
    const numerator = (2 * dst + 1) * srcSize - dstSize;
    const denominator = 2 * dstSize;
    let cell = Math.floor(numerator / denominator);
    let fraction = numerator - cell * denominator;
    if (cell < 0) { cell = 0; fraction = 0; }
    else if (cell > srcSize - 1) { cell = srcSize - 1; fraction = 0; }
    const weight = Math.floor(fraction * ONE / denominator + 0.5);
    return { index: cell, weight: weight > ONE ? ONE : weight };
}

/** The taps of one destination row */
function rowTaps(dstWidth: number, dstHeight: number, srcWidth: number, srcHeight: number, y: number, channels: number, taps: Tap[]): void {
    const { index: iy, weight: wy } = sourcePosition(y, dstHeight, srcHeight);
    const iy1 = iy + 1 < srcHeight ? iy + 1 : iy;
    const stride = srcWidth * channels;
    const row0 = iy * stride, row1 = iy1 * stride;
    const rowDelta = row1 - row0;

    for (let x = 0; x < dstWidth; x++) {
        const { index: ix, weight: wx } = sourcePosition(x, dstWidth, srcWidth);
        const ix1 = ix + 1 < srcWidth ? ix + 1 : ix;
        const wx0 = ONE - wx;
        // (rounded half up, then the horizontal complements are exact differences so the four weights sum to ONE)
        const w11 = Math.floor(wx * wy / ONE + 0.5);
        const w01 = Math.floor(wx0 * wy / ONE + 0.5);
        const t = taps[x];
        t.index = row0 + ix * channels;
        t.step = (ix1 - ix) * channels;
        t.stride = rowDelta;
        t.w00 = ONE - wx - w01;
        t.w10 = wx - w11;
        t.w01 = w01;
        t.w11 = w11;
    }
}

// premultiplies a raster's samples into a new array (alpha is kept; a raster without alpha is just copied)
function premultipliedSamples(raster: Raster): RasterData {
    const { channels, maxval, data } = raster;
    const out: RasterData = data instanceof Uint8Array ? new Uint8Array(data.length) : new Uint16Array(data.length);
    out.set(data);
    if (!hasAlpha(raster)) return out;
    const a = channels - 1;
    for (let s = 0; s < data.length; s += channels) {
        const alpha = data[s + a];
        if (alpha === maxval) continue;
        for (let c = 0; c < a; c++) out[s + c] = roundHalfUp(data[s + c] * alpha / maxval);
    }
    return out;
}

/**
 * The rows `[first, last)` of a scaled image, written into `out` (a buffer of the full destination size, already
 * premultiplied when the raster has alpha). Shared by the synchronous and the chunked worker paths, so both produce
 * bit-identical rows for the same inputs
 * @internal
 */
export function scaleRows(src: RasterData, srcWidth: number, srcHeight: number, channels: number, maxval: number, dstWidth: number, dstHeight: number, first: number, last: number, out: RasterData): void {
    const taps: Tap[] = new Array<Tap>(dstWidth);
    for (let i = 0; i < dstWidth; i++) taps[i] = { index: 0, step: channels, stride: 0, w00: ONE, w10: 0, w01: 0, w11: 0 };

    for (let y = first; y < last; y++) {
        rowTaps(dstWidth, dstHeight, srcWidth, srcHeight, y, channels, taps);
        let o = y * dstWidth * channels;
        for (let x = 0; x < dstWidth; x++, o += channels) {
            const t = taps[x], i = t.index;
            for (let c = 0; c < channels; c++) {
                const s00 = src[i + c], s10 = src[i + t.step + c], s01 = src[i + t.stride + c], s11 = src[i + t.stride + t.step + c];
                // each term is at most maxval * 65536 (2^16 * 2^16 = 2^32), and their sum stays exact in a double
                const sum = s00 * t.w00 + s10 * t.w10 + s01 * t.w01 + s11 * t.w11;
                out[o + c] = clampSample(Math.floor(sum / ONE + 0.5), maxval);
            }
        }
    }
}

/**
 * Scales a raster to the given size with bilinear sampling (fixed point interpolation, rounded half up). The channel
 * order, bit depth and alpha tag are preserved; an alpha channel is interpolated in premultiplied space (transparent
 * pixels' colour does not bleed into opaque neighbours). Odd sizes and the 1x1 case are exact: a 1xN or Nx1 source
 * repeats its row or column. Returns a new raster; the input is not modified
 * @param raster The source raster
 * @param width The destination width in pixels (a positive integer)
 * @param height The destination height in rows (a positive integer)
 */
export function scaleBilinear(raster: Raster, width: number, height: number): Raster {
    checkRaster(raster);
    if (!Number.isSafeInteger(width) || width < 1) throw new RangeError(`width must be a positive integer, not ${width}`);
    if (!Number.isSafeInteger(height) || height < 1) throw new RangeError(`height must be a positive integer, not ${height}`);
    const { channels, maxval, data } = raster;
    if (!Number.isSafeInteger(width * height * channels)) throw new RangeError('The destination size overflows');

    const out: RasterData = data instanceof Uint8Array ? new Uint8Array(width * height * channels) : new Uint16Array(width * height * channels);
    const alpha = hasAlpha(raster);
    const src = alpha ? premultipliedSamples(raster) : data;

    scaleRows(src, raster.width, raster.height, channels, maxval, width, height, 0, height, out);

    if (!alpha) return { width, height, channels, maxval, data: out };
    // un-premultiply the result, keeping the source's alpha tag
    const straight = unpremultiplyAlpha({ width, height, channels, maxval, data: out, alpha: 'premultiplied' });
    return { width, height, channels, maxval, data: straight.data, alpha: raster.alpha };
}

/**
 * Rotates a raster by a multiple of 90 degrees counterclockwise. 0 returns a copy, 1 is 90 degrees counterclockwise, 2
 * is 180 degrees and 3 is 270 degrees counterclockwise (90 clockwise). The channel order, bit depth and alpha tag are
 * preserved exactly (no interpolation); a 1xN or Nx1 raster transposes correctly. Returns a new raster; the input is
 * not modified
 * @param raster The source raster
 * @param turns The number of counterclockwise quarter turns (0 to 3; other integers are taken modulo 4)
 */
export function rotate90(raster: Raster, turns: number): Raster {
    checkRaster(raster);
    if (!Number.isInteger(turns)) throw new RangeError(`turns must be an integer, not ${turns}`);
    const t = ((turns % 4) + 4) % 4;
    const { width, height, channels, maxval, data } = raster;
    const out: RasterData = data instanceof Uint8Array ? new Uint8Array(data.length) : new Uint16Array(data.length);
    const alphaTag = hasAlpha(raster) ? { alpha: raster.alpha } : {};
    const same = (w: number, h: number): Raster => ({ width: w, height: h, channels, maxval, data: out, ...alphaTag });

    if (t === 0) {
        out.set(data);
        return same(width, height);
    }

    if (t === 2) {
        const samples = width * height * channels;
        for (let s = 0; s < samples; s += channels) {
            const from = samples - channels - s;
            for (let c = 0; c < channels; c++) out[s + c] = data[from + c];
        }
        return same(width, height);
    }

    // 90 and 270 degrees swap the axes; destination (ox, oy) reads source (sx, sy)
    const outWidth = height, outHeight = width;
    for (let oy = 0; oy < outHeight; oy++) {
        for (let ox = 0; ox < outWidth; ox++) {
            const sx = t === 1 ? width - 1 - oy : oy;
            const sy = t === 1 ? ox : height - 1 - ox;
            const si = (sy * width + sx) * channels, di = (oy * outWidth + ox) * channels;
            for (let c = 0; c < channels; c++) out[di + c] = data[si + c];
        }
    }
    return same(outWidth, outHeight);
}
