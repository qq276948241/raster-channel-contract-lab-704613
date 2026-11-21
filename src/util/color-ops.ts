// Colour operators on lossless rasters: the sRGB transfer function, straight <-> premultiplied alpha, and greyscale
// histograms with percentiles.
//
// Rounding is fixed everywhere (it never depends on the platform): intermediates are IEEE-754 doubles, and the one
// rounding step to integer samples is `floor(x + 0.5)` (round half up; samples are never negative by then). The
// scalar transfer functions are exact inverses of each other, NaN stays NaN, and infinite values pass through.

import { Raster, checkRaster, hasAlpha } from './raster.ts';

/** Rounds a non-negative number to the nearest integer, halves up (the one rounding rule of the operators) */
export function roundHalfUp(value: number): number {
    return Math.floor(value + 0.5);
}

/** Clamps an integer sample to 0..maxval (NaN becomes 0) */
export function clampSample(value: number, maxval: number): number {
    if (!(value > 0)) return 0;
    return value >= maxval ? maxval : value;
}

const LINEAR_THRESHOLD = 0.04045;
const SRGB_THRESHOLD = 0.0031308;
const LINEAR_SLOPE = 12.92;
const SRGB_A = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_EXPONENT = 2.4;

/**
 * Converts an sRGB value (0..1) to linear light. Values below 0 use the linear segment with their sign (extended
 * sRGB), so the function is odd around zero; NaN returns NaN and the infinities pass through
 * @param value The sRGB value, 0 (black) to 1 (white) for display values
 */
export function srgbToLinear(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (value <= LINEAR_THRESHOLD) return value / LINEAR_SLOPE;
    return Math.pow((value + SRGB_A) / SRGB_SCALE, SRGB_EXPONENT);
}

/**
 * Converts a linear light value (0..1) to sRGB. Negative values use the linear segment with their sign, so this is the
 * exact inverse of {@link srgbToLinear} on the linear segment; NaN returns NaN
 * @param value The linear value, 0 (black) to 1 (white)
 */
export function linearToSRGB(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (value <= SRGB_THRESHOLD) return value * LINEAR_SLOPE;
    return SRGB_SCALE * Math.pow(value, 1 / SRGB_EXPONENT) - SRGB_A;
}

// the direction of a raster transfer: to linear light, or back to sRGB
type Transfer = 'to-linear' | 'to-srgb';

function transfer(raster: Raster, direction: Transfer): Raster {
    checkRaster(raster);
    const { width, height, channels, maxval, data } = raster;
    const out = data instanceof Uint8Array ? new Uint8Array(data.length) : new Uint16Array(data.length);
    const transform = direction === 'to-linear' ? srgbToLinear : linearToSRGB;
    // the colour channels; alpha (the last one of 2 or 4 channels) is not a display value and stays as it is
    const colour = channels === 2 ? 1 : channels === 4 ? 3 : channels;

    for (let p = 0, s = 0; p < width * height; p++, s += channels) {
        for (let c = 0; c < colour; c++) {
            const value = transform(data[s + c] / maxval);
            out[s + c] = Number.isNaN(value) ? 0 : clampSample(roundHalfUp(value * maxval), maxval);
        }
        if (channels > colour) out[s + colour] = data[s + colour];
    }

    return { width, height, channels, maxval, data: out, ...(hasAlpha(raster) ? { alpha: raster.alpha } : {}) };
}

/**
 * Converts an sRGB raster's colour channels to linear light. The alpha channel, the channel order, the bit depth and
 * the sample values' range are kept; the result is a new raster, the input is not modified
 * @param raster The sRGB raster
 */
export function srgbRasterToLinear(raster: Raster): Raster {
    return transfer(raster, 'to-linear');
}

/**
 * Converts a linear light raster's colour channels to sRGB. The inverse of {@link srgbRasterToLinear} up to the 8-bit
 * (or 16-bit) quantisation of one round trip
 * @param raster The linear light raster
 */
export function linearRasterToSRGB(raster: Raster): Raster {
    return transfer(raster, 'to-srgb');
}

/** Whether a raster's alpha channel is explicit (channels 2 or 4) */
export { hasAlpha };

/**
 * Multiplies the colour channels by alpha, for 8-bit and 16-bit samples alike: `round(colour * alpha / maxval)`,
 * halves up. Alpha itself is kept. A raster without an alpha channel is returned as an unchanged copy (its alpha is
 * implicitly opaque)
 * @param raster A raster with straight (or already premultiplied) alpha
 */
export function premultiplyAlpha(raster: Raster): Raster {
    checkRaster(raster);
    const { width, height, channels, maxval, data } = raster;
    const out = data instanceof Uint8Array ? new Uint8Array(data.length) : new Uint16Array(data.length);
    out.set(data);

    if (!hasAlpha(raster)) return { width, height, channels, maxval, data: out };

    const colour = channels - 1;
    for (let s = 0; s < data.length; s += channels) {
        const alpha = data[s + colour];
        if (alpha === maxval) continue;
        for (let c = 0; c < colour; c++) out[s + c] = roundHalfUp(data[s + c] * alpha / maxval);
    }

    return { width, height, channels, maxval, data: out, alpha: 'premultiplied' };
}

/**
 * Divides the colour channels by alpha, the inverse of {@link premultiplyAlpha} up to rounding:
 * `round(colour * maxval / alpha)`, clamped to maxval. Fully transparent pixels (alpha 0) become transparent black in
 * every colour channel (the colour is unrecoverable, so it is defined as 0 instead of dividing by zero). A raster
 * without an alpha channel is returned as an unchanged copy
 * @param raster A raster with premultiplied alpha
 */
export function unpremultiplyAlpha(raster: Raster): Raster {
    checkRaster(raster);
    const { width, height, channels, maxval, data } = raster;
    const out = data instanceof Uint8Array ? new Uint8Array(data.length) : new Uint16Array(data.length);
    out.set(data);

    if (!hasAlpha(raster)) return { width, height, channels, maxval, data: out };

    const colour = channels - 1;
    for (let s = 0; s < data.length; s += channels) {
        const alpha = data[s + colour];
        if (alpha === maxval || alpha === 0) {
            if (alpha === 0) for (let c = 0; c < colour; c++) out[s + c] = 0;
            continue;
        }
        for (let c = 0; c < colour; c++) out[s + c] = clampSample(roundHalfUp(data[s + c] * maxval / alpha), maxval);
    }

    return { width, height, channels, maxval, data: out, alpha: 'straight' };
}

// the BT.601 luma weights, as integers summing to 1000 (so luminance is exact integer arithmetic)
const LUMA_R = 299, LUMA_G = 587, LUMA_B = 114, LUMA_TOTAL = 1000;

/**
 * The greyscale value of a pixel: the only colour channel of a grey raster, or the BT.601 luma of RGB(A) samples:
 * `round((299 r + 587 g + 114 b) / 1000)`, exact integer arithmetic (halves up). Alpha is ignored
 */
export function grayscaleValue(raster: Raster, pixel: number): number {
    const { channels, data } = raster;
    const s = pixel * channels;
    if (channels < 3) return data[s];
    const luma = LUMA_R * data[s] + LUMA_G * data[s + 1] + LUMA_B * data[s + 2];
    // (the sum is below 2^53 for 16-bit samples: no precision loss)
    return Math.floor((luma + LUMA_TOTAL / 2) / LUMA_TOTAL);
}

/**
 * A greyscale histogram: the number of pixels at each value from 0 to maxval (the array has maxval + 1 entries). For
 * grey rasters that is the sample itself; for RGB(A) rasters each pixel counts once at its BT.601 luma (see
 * {@link grayscaleValue}). Fully transparent pixels are counted like any other (their colour may be black)
 * @param raster The raster to measure
 */
export function grayscaleHistogram(raster: Raster): Uint32Array {
    checkRaster(raster);
    const { width, height, channels, maxval, data } = raster;
    const histogram = new Uint32Array(maxval + 1);
    const pixels = width * height;

    if (channels < 3) {
        for (let p = 0, s = 0; p < pixels; p++, s += channels) histogram[data[s]]++;
        return histogram;
    }

    // the BT.601 luma of every pixel, rounded half up with exact integer arithmetic (like grayscaleValue)
    for (let p = 0, s = 0; p < pixels; p++, s += channels) {
        const luma = LUMA_R * data[s] + LUMA_G * data[s + 1] + LUMA_B * data[s + 2];
        histogram[Math.floor((luma + LUMA_TOTAL / 2) / LUMA_TOTAL)]++;
    }
    return histogram;
}

/**
 * A per-channel histogram: the number of pixels with each value of the channel, from 0 to maxval
 * @param raster The raster to measure
 * @param channel The channel index (0 is grey or red, 3 is alpha)
 */
export function channelHistogram(raster: Raster, channel = 0): Uint32Array {
    checkRaster(raster);
    if (!Number.isInteger(channel) || channel < 0 || channel >= raster.channels)
        throw new RangeError(`channel must be an integer from 0 to ${raster.channels - 1}, not ${channel}`);
    const { width, height, channels, maxval, data } = raster;
    const histogram = new Uint32Array(maxval + 1);
    for (let p = 0, s = channel; p < width * height; p++, s += channels) histogram[data[s]]++;
    return histogram;
}

/**
 * The value at a percentile of a histogram: the smallest value whose cumulative count is at least
 * `ceil(percentile / 100 * total)` (nearest-rank). A percentile of 0 is the smallest non-empty value, 100 the largest.
 * Throws a RangeError for a percentile outside 0..100 or a histogram without pixels
 * @param histogram Counts per value (as from {@link grayscaleHistogram})
 * @param percentile The percentile, 0 to 100
 */
export function histogramPercentile(histogram: ArrayLike<number>, percentile: number): number {
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100)
        throw new RangeError(`percentile must be a number from 0 to 100, not ${percentile}`);
    let total = 0;
    for (let i = 0; i < histogram.length; i++) total += histogram[i];
    if (!(total > 0)) throw new RangeError('Cannot take a percentile of an empty histogram');

    const smallest = (): number => {
        for (let i = 0; i < histogram.length; i++) if (histogram[i]) return i;
        return 0;
    };
    const largest = (): number => {
        for (let i = histogram.length - 1; i >= 0; i--) if (histogram[i]) return i;
        return 0;
    };
    if (percentile <= 0) return smallest();
    if (percentile >= 100) return largest();

    // (ceil keeps the rank in 1..total, so the answer is the last value of a non-empty bin)
    const rank = Math.ceil(percentile * total / 100);
    let cumulative = 0;
    for (let i = 0; i < histogram.length; i++) {
        cumulative += histogram[i];
        if (cumulative >= rank) return i;
    }
    // (unreachable for counts summing to total, but the largest value is the right answer if a caller passes odd data)
    return histogram.length - 1;
}

/**
 * Several percentiles of a histogram at once, in the order given (see {@link histogramPercentile})
 * @param histogram Counts per value
 * @param percentiles The percentiles, each 0 to 100
 */
export function histogramPercentiles(histogram: ArrayLike<number>, percentiles: readonly number[]): number[] {
    return percentiles.map(percentile => histogramPercentile(histogram, percentile));
}
