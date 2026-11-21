// A lossless raster: integer samples with the channel order the format stores them in. Unlike Image's RGBA bitmap,
// nothing is scaled, premultiplied or narrowed to 8 bits here: 16-bit PNG/PNM samples stay 16-bit, and a sample of
// `maxval` stays exactly `maxval`.
//
// Channel orders are: 1 = Gray, 2 = Gray + Alpha, 3 = RGB, 4 = RGBA. Alpha is whatever the format says it is
// (`alpha`, straight by default); the operators preserve that tag instead of guessing.

/** The number of samples of a pixel */
export type RasterChannels = 1 | 2 | 3 | 4;

/** 8-bit or 16-bit samples (all samples of a raster have the same width) */
export type RasterData = Uint8Array | Uint16Array;

/** How a raster's alpha channel is encoded */
export type RasterAlpha = 'straight' | 'premultiplied';

/** A lossless integer raster (see the module comment) */
export interface Raster {
    /** The width in samples */
    readonly width: number;
    /** The height in rows */
    readonly height: number;
    /** The number of samples per pixel, 1 to 4 (see the channel order above) */
    readonly channels: RasterChannels;
    /** The largest sample value: 255 for 8-bit samples, 65535 for 16-bit ones */
    readonly maxval: number;
    /** The samples, row by row: `width * height * channels` of them */
    readonly data: RasterData;
    /** Whether alpha is straight or premultiplied, if there is an alpha channel */
    readonly alpha?: RasterAlpha;
}

/** The bytes one sample takes: 1 up to a maxval of 255, 2 above it */
export function sampleBytesOf(maxval: number): 1 | 2 {
    return maxval < 256 ? 1 : 2;
}

/**
 * Throws a RangeError naming the field if a maximum sample value isn't an integer from 1 to 65535
 * @param maxval The value to check
 * @param name The argument name used in the error
 */
export function checkMaxval(maxval: number, name = 'maxval'): number {
    if (!Number.isInteger(maxval) || maxval < 1 || maxval > 65535)
        throw new RangeError(`${name} must be an integer from 1 to 65535, not ${maxval}`);
    return maxval;
}

/**
 * Throws a RangeError naming the field if a raster's dimensions, channel count, sample width or data length don't fit
 * together. Every product is checked for overflow before it is used, so a damaged header can't make it allocate.
 * @param raster The raster to check
 * @param name The argument name used in errors
 */
export function checkRaster(raster: Raster, name = 'raster'): void {
    const { width, height, channels, maxval, data } = raster;
    if (!Number.isSafeInteger(width) || width < 1) throw new RangeError(`${name}.width must be a positive integer, not ${width}`);
    if (!Number.isSafeInteger(height) || height < 1) throw new RangeError(`${name}.height must be a positive integer, not ${height}`);
    if (channels !== 1 && channels !== 2 && channels !== 3 && channels !== 4) throw new RangeError(`${name}.channels must be 1, 2, 3 or 4, not ${String(channels)}`);
    checkMaxval(maxval, `${name}.maxval`);
    const bytes = sampleBytesOf(maxval);
    const expected = bytes === 1 ? Uint8Array : Uint16Array;
    if (!(data instanceof expected))
        throw new TypeError(`${name}.data must be a ${bytes === 1 ? 'Uint8Array' : 'Uint16Array'} for maxval ${maxval}`);
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels)) throw new RangeError(`${name}: width * height overflows`);
    const samples = pixels * channels;
    if (!Number.isSafeInteger(samples)) throw new RangeError(`${name}: width * height * channels overflows`);
    if (data.length !== samples) throw new RangeError(`${name}.data has ${data.length} samples, expected ${samples} (${width}x${height}x${channels})`);
}

/** Whether a raster has an alpha channel */
export function hasAlpha(raster: Raster): boolean {
    return (raster.channels & 1) === 0;
}

/**
 * Returns a raster with the same pixels and a different alpha tag (the data is shared, not copied)
 * @param raster The source raster
 * @param alpha The tag the result carries
 */
export function withAlpha(raster: Raster, alpha: RasterAlpha): Raster {
    return { width: raster.width, height: raster.height, channels: raster.channels, maxval: raster.maxval, data: raster.data, ...(hasAlpha(raster) ? { alpha } : {}) };
}
