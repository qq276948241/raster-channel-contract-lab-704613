// TIFF-like tiled rasters: a descriptor names the image and tile geometry, the samples' layout within a tile (a row
// stride, so rows may be padded) and where each tile's bytes are. Every offset and size is checked before the
// raster is allocated; tiles past the right and bottom edges are clipped

import { Raster, RasterError, MAX_RASTER_BYTES, checkedSampleBytes } from './raster.ts';

/** Where one tile's bytes are (tiles are row-major over the grid) */
export interface TileLocation {
    offset: number;
    /** Defaults to the bytes the tile's rows take at the descriptor's row stride */
    byteCount?: number;
}

/** A TIFF-like tile layout: the image is a grid of tileWidth x tileHeight tiles, each row rowStride bytes apart */
export interface TileDescriptor {
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    channels: number;
    bitDepth: 8 | 16;
    maxval?: number;
    /** Bytes between the starts of consecutive rows within a tile (at least a row's samples) */
    rowStride: number;
    tiles: readonly TileLocation[];
}

/**
 * Assembles a tiled buffer into a contiguous raster. The descriptor and every tile's range are validated before
 * the raster is allocated; errors name the field and, for tile data, the offset
 */
export function readTiles(d: Uint8Array, t: TileDescriptor, maxBytes = MAX_RASTER_BYTES): Raster {
    const bitDepth = t.bitDepth;
    if (bitDepth !== 8 && bitDepth !== 16) throw new RasterError(`invalid bit depth ${bitDepth as number}`, 'bitDepth');
    const sampleBytes = bitDepth >> 3;
    for (const [name, value] of [['tileWidth', t.tileWidth], ['tileHeight', t.tileHeight], ['rowStride', t.rowStride]] as const)
        if (!Number.isSafeInteger(value) || value < 1) throw new RasterError(`invalid ${name} ${value}`, name);

    // the raster's size (and limit) is checked before the tiles are looked at: nothing is allocated for rejects
    checkedSampleBytes(t.width, t.height, t.channels, bitDepth, maxBytes);

    const rowSamples = t.tileWidth * t.channels;
    if (rowSamples > Math.floor(Number.MAX_SAFE_INTEGER / sampleBytes))
        throw new RasterError(`tile width ${t.tileWidth} overflows`, 'tileWidth');
    const minStride = rowSamples * sampleBytes;
    if (t.rowStride < minStride)
        throw new RasterError(`row stride ${t.rowStride} is less than a row's ${minStride} bytes`, 'rowStride');

    const across = Math.ceil(t.width / t.tileWidth);
    const down = Math.ceil(t.height / t.tileHeight);
    if (t.tiles.length !== across * down)
        throw new RasterError(`${t.tiles.length} tiles for a ${across}x${down} grid`, 'tiles');

    // every tile's range is validated before anything is allocated or copied
    const ranges: { offset: number, rows: number }[] = [];
    for (let i = 0; i < t.tiles.length; i++) {
        const tile = t.tiles[i];
        const rows = Math.min(t.tileHeight, t.height - (i / across | 0) * t.tileHeight);
        // the last row needs only its samples, the ones before it the full stride
        const needed = (rows - 1) * t.rowStride + minStride;
        if (!Number.isSafeInteger(tile.offset) || tile.offset < 0)
            throw new RasterError(`invalid tile offset ${tile.offset}`, 'tiles', tile.offset);
        const count = tile.byteCount ?? needed;
        if (!Number.isSafeInteger(count) || count < needed)
            throw new RasterError(`tile ${i} has ${count} of ${needed} bytes`, 'tiles', tile.offset);
        if (tile.offset > d.length - count)
            throw new RasterError(`tile ${i} at offset ${tile.offset} is past the data's end (${d.length} bytes)`, 'tiles', tile.offset);
        ranges.push({ offset: tile.offset, rows });
    }

    const raster: Raster = {
        width: t.width,
        height: t.height,
        channels: t.channels,
        bitDepth,
        maxval: t.maxval ?? (bitDepth === 16 ? 65535 : 255),
        data: bitDepth === 16 ? new Uint16Array(t.width * t.height * t.channels) : new Uint8Array(t.width * t.height * t.channels),
    };

    for (let i = 0; i < ranges.length; i++) {
        const tx = i % across, ty = i / across | 0;
        const visible = Math.min(t.tileWidth, t.width - tx * t.tileWidth) * t.channels;
        for (let row = 0; row < ranges[i].rows; row++) {
            const from = ranges[i].offset + row * t.rowStride;
            const to = ((ty * t.tileHeight + row) * t.width + tx * t.tileWidth) * t.channels;
            if (bitDepth === 8) {
                (raster.data as Uint8Array).set(d.subarray(from, from + visible), to);
            } else {
                const out = raster.data as Uint16Array;
                for (let s = 0; s < visible; s++) out[to + s] = d[from + s * 2] << 8 | d[from + s * 2 + 1];
            }
        }
    }
    return raster;
}
