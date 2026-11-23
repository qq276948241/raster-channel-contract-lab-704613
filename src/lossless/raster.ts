// lossless rasters: 8 or 16 bit samples, 1 to 4 channels (alpha, when present, is the last channel). Unlike the
// Image class (8 bit RGBA), 16 bit samples stay 16 bit: nothing is quantized silently

/** An error reading or writing a raster: names the field and the offset it was read at */
export class RasterError extends Error {
    /** The field the error is about ('width', 'maxval', 'pixels', ...), '' when there is none */
    readonly field: string;
    /** The offset in the input the field was read at, -1 when there is none */
    readonly offset: number;

    constructor(message: string, field = '', offset = -1) {
        super(field ? `${message} (${field} at offset ${offset})` : message);
        this.name = 'RasterError';
        this.field = field;
        this.offset = offset;
    }
}

/** A raster's samples: a Uint8Array at 8 bits, a Uint16Array (host byte order) at 16 */
export interface Raster {
    width: number;
    height: number;
    /** Samples per pixel, 1-4; with 2 or 4 channels the last one is alpha */
    channels: number;
    bitDepth: 8 | 16;
    /** The samples' full-scale value: 255 or 65535 for full-range data, less for narrower scales */
    maxval: number;
    data: Uint8Array | Uint16Array;
}

/** The most bytes one raster's samples may take; readers reject larger images before allocating anything */
export const MAX_RASTER_BYTES = 1 << 30;

const dimension = (name: string, value: number, offset: number): void => {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new RasterError(`invalid ${name} ${value}`, name, offset);
};

/**
 * The bytes width * height * channels samples take at the given bit depth. Every factor is checked before it is
 * multiplied, so the product can't overflow, and the total is checked against maxBytes: anything too large is
 * rejected before a buffer of its size is allocated
 */
export function checkedSampleBytes(width: number, height: number, channels: number, bitDepth: 8 | 16, maxBytes = MAX_RASTER_BYTES, offset = -1): number {
    dimension('width', width, offset);
    dimension('height', height, offset);
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 4)
        throw new RasterError(`invalid channel count ${channels}`, 'channels', offset);
    if (bitDepth !== 8 && bitDepth !== 16)
        throw new RasterError(`invalid bit depth ${bitDepth as number}`, 'bitDepth', offset);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new RasterError(`invalid byte limit ${maxBytes}`, 'maxBytes', offset);

    const bytesPerPixel = channels * (bitDepth >> 3);
    if (width > Math.floor(Number.MAX_SAFE_INTEGER / height))
        throw new RasterError(`dimensions ${width}x${height} overflow`, 'pixels', offset);
    const pixels = width * height;
    if (pixels > Math.floor(maxBytes / bytesPerPixel))
        throw new RasterError(`image too large: ${width}x${height}x${channels} ${bitDepth}-bit samples exceed the limit of ${maxBytes} bytes`, 'pixels', offset);
    return pixels * bytesPerPixel;
}

/** Throws unless the raster's data is exactly width * height * channels samples */
export function checkRaster(raster: Raster): number {
    const bytes = checkedSampleBytes(raster.width, raster.height, raster.channels, raster.bitDepth);
    if (raster.bitDepth === 8 ? !(raster.data instanceof Uint8Array) : !(raster.data instanceof Uint16Array))
        throw new RasterError(`a ${raster.bitDepth}-bit raster's data is a Uint${raster.bitDepth}Array`, 'data');
    if (raster.data.byteLength !== bytes)
        throw new RasterError(`raster data is ${raster.data.byteLength} bytes, ${bytes} expected`, 'data');
    const fullScale = raster.bitDepth === 16 ? 65535 : 255;
    if (!Number.isSafeInteger(raster.maxval) || raster.maxval < 1 || raster.maxval > fullScale)
        throw new RasterError(`invalid maxval ${raster.maxval}`, 'maxval');
    return bytes;
}

/** Whether the raster's last channel is alpha (2 or 4 channels) */
export const hasAlpha = (raster: Raster): boolean => raster.channels === 2 || raster.channels === 4;

/** A copy of the raster's samples (operators never mutate their input) */
export function copyData(raster: Raster): Uint8Array | Uint16Array {
    return raster.data.slice(0, checkedSampleBytes(raster.width, raster.height, raster.channels, raster.bitDepth) / (raster.bitDepth >> 3));
}

/** A raster like another one, with new (zero) samples */
export function blank(width: number, height: number, channels: number, bitDepth: 8 | 16, maxval?: number): Raster {
    const samples = checkedSampleBytes(width, height, channels, bitDepth) / (bitDepth >> 3);
    const data = bitDepth === 16 ? new Uint16Array(samples) : new Uint8Array(samples);
    return { width, height, channels, bitDepth, maxval: maxval ?? (bitDepth === 16 ? 65535 : 255), data };
}
