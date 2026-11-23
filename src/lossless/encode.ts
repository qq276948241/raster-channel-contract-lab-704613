// Writing rasters as Netpbm files: streamed to a temporary file in small chunks (see encodeChunks), renamed into
// place when complete; the temporary file is removed when anything fails, so a failed write never leaves a partial
// image at the target path. node:fs is used through feature detection, like node:zlib in codecs/zlib.ts

import { RasterError } from './raster.ts';
import type { Raster } from './raster.ts';
import { encodeChunks } from './netpbm.ts';

interface Globals {
    process?: { getBuiltinModule?: (id: string) => unknown };
}

interface Fs {
    openSync(path: string, flags: string): number;
    writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
    closeSync(fd: number): void;
    renameSync(from: string, to: string): void;
    unlinkSync(path: string): void;
}

function fs(): Fs | null {
    try {
        return ((globalThis as unknown as Globals).process?.getBuiltinModule?.('node:fs') as Fs | undefined) ?? null;
    } catch {
        return null;
    }
}

let tempCounter = 0;

/**
 * Writes a raster as a Netpbm file (its format follows the raster: P5/P6, PAM with alpha, 8 or 16 bit). The chunks
 * go to a temporary file next to the target, renamed over it at the end; on any failure the temporary file is
 * closed and removed
 */
export async function writeNetpbmFile(raster: Raster, path: string): Promise<void> {
    const f = fs();
    if (!f) throw new RasterError('Netpbm: writing files needs node:fs');

    const random = Math.floor(Math.random() * 0xffffffff).toString(36);
    const temporary = `${path}.tmp-${(tempCounter = tempCounter + 1).toString(36)}-${random}`;
    let fd = -1;
    try {
        fd = f.openSync(temporary, 'w');
        for (const chunk of encodeChunks(raster)) {
            // a write may be short: loop until the chunk is out
            for (let o = 0; o < chunk.length;) o += f.writeSync(fd, chunk, o, chunk.length - o, null);
        }
        f.closeSync(fd);
        fd = -1;
        f.renameSync(temporary, path);
    } catch (e) {
        if (fd !== -1) {
            try { f.closeSync(fd); } catch { /* the original error matters */ }
        }
        try { f.unlinkSync(temporary); } catch { /* it may never have been created */ }
        throw e;
    }
}
