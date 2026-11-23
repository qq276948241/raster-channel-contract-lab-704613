// Large-image operators on worker threads: a raster's rows are split into tiles, the tiles run on a pool of
// node:worker_threads workers (the module in worker.ts), and the results are assembled here. Progress is monotonic
// (tiles only complete), an aborted task publishes nothing more, workers are reused across tasks, and concurrent
// tasks never share an output buffer. Without worker threads everything runs locally, in the same tiles

import { Raster, RasterError, checkRaster } from './raster.ts';
import { runTile } from './ops.ts';
import { availableThreads, shared } from '../util/threads.ts';

// (see util/threads.ts for why these are declared locally)
declare const URL: new (url: string, base: string) => URL;
interface URL {
    readonly href: string;
}
type Meta = ImportMeta & { url: string };
declare function setTimeout(callback: () => void, ms: number): unknown;

interface NodeWorker {
    on(event: 'message' | 'error', listener: (value: unknown) => void): void;
    postMessage(message: unknown): void;
    terminate(): Promise<number>;
    unref(): void;
}

interface Globals {
    process?: { getBuiltinModule?: (id: string) => unknown };
}

/** The subset of AbortSignal the pool needs (a native AbortSignal satisfies it) */
export interface AbortSignalLike {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}

/** Raster operators that run tiled (histogram reduces to a Uint32Array instead) */
export type RasterOp = 'to-linear' | 'to-srgb' | 'premultiply' | 'unpremultiply';

export interface TileRunOptions {
    /** Aborts the task: it rejects with an AbortError and publishes no further progress or result */
    signal?: AbortSignalLike;
    /** Called with (done, total) as tiles complete; done grows monotonically */
    onProgress?: (done: number, total: number) => void;
    /** Rows per tile; the default gives every worker a few tiles */
    rowsPerTile?: number;
}

interface TileRequest {
    id: number;
    op: string;
    width: number;
    channels: number;
    maxval: number;
    y0: number;
    y1: number;
    input: Uint8Array | Uint16Array;
    output?: Uint8Array | Uint16Array;
}

interface TileReply {
    id: number;
    y0: number;
    y1: number;
    histogram?: Uint32Array;
    error?: { message: string, stage: string, tileX: number, tileY: number };
}

interface Pending {
    id: number;
    op: string;
    tiles: [number, number][];
    next: number;
    done: number;
    input: Uint8Array | Uint16Array;
    output: Uint8Array | Uint16Array | null;
    histogram: Uint32Array | null;
    meta: { width: number, height: number, channels: number, bitDepth: 8 | 16, maxval: number };
    resolve: (value: Raster | Uint32Array) => void;
    reject: (error: Error) => void;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignalLike;
    onAbort?: () => void;
}

/** An error with this name rejects tasks aborted through their signal */
export function abortError(): Error {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

// a worker's failure becomes an Error carrying the stage (the operator) and the tile's coordinates
const tileError = (e: unknown, op: string, y0: number): Error =>
    Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: op, tileX: 0, tileY: y0 });

function startWorker(): NodeWorker | null {
    try {
        const wt = (globalThis as unknown as Globals).process?.getBuiltinModule?.('node:worker_threads') as { Worker: new (url: URL) => NodeWorker } | undefined;
        if (!wt) return null;
        const url = (import.meta as Meta).url;
        const worker = new wt.Worker(new URL(url.endsWith('.ts') ? './worker.ts' : './worker.js', url));
        // an idle pool doesn't keep the process alive
        worker.unref();
        return worker;
    } catch {
        return null;
    }
}

/** A pool of worker threads running tiled raster operators (see run) */
export class RasterPool {
    private workers: NodeWorker[] = [];
    private idle: NodeWorker[] = [];
    private active = new Map<number, Pending>();
    private nextId = 0;
    private closed = false;

    /** size 0 runs everything on this thread; the default is up to 4 worker threads */
    constructor(size?: number) {
        const n = size ?? Math.min(4, availableThreads());
        for (let i = 0; i < n; i++) {
            const worker = startWorker();
            if (!worker) break;
            worker.on('message', (m: unknown) => this.reply(worker, m as TileReply));
            worker.on('error', () => this.failAll());
            this.workers.push(worker);
            this.idle.push(worker);
        }
    }

    /** The number of worker threads (0: tasks run on this thread) */
    get size(): number {
        return this.workers.length;
    }

    /** Runs a histogram over the raster's rows, the tiles' histograms summed */
    run(op: 'histogram', raster: Raster, options?: TileRunOptions): Promise<Uint32Array>;
    /** Runs a raster operator tiled over the rows */
    run(op: RasterOp, raster: Raster, options?: TileRunOptions): Promise<Raster>;
    run(op: string, raster: Raster, options?: TileRunOptions): Promise<Raster | Uint32Array>;
    async run(op: string, raster: Raster, options: TileRunOptions = {}): Promise<Raster | Uint32Array> {
        if (this.closed) throw new RasterError('RasterPool: closed');
        try {
            checkRaster(raster);
        } catch (e) {
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: 'validate' });
        }
        if (options.signal?.aborted) throw abortError();
        const rowsPerTile = options.rowsPerTile ?? Math.max(1, Math.ceil(raster.height / Math.max(1, this.workers.length * 4)));
        if (!Number.isSafeInteger(rowsPerTile) || rowsPerTile < 1) throw new RasterError(`invalid rowsPerTile ${rowsPerTile}`, 'rowsPerTile');

        const tiles: [number, number][] = [];
        for (let y = 0; y < raster.height; y += rowsPerTile) tiles.push([y, Math.min(y + rowsPerTile, raster.height)]);

        // every task gets its own input and output buffers: concurrent tasks can't write into each other
        const histogram = op === 'histogram';
        const input = this.workers.length ? shared(raster.data) : raster.data;
        const output = histogram ? null : this.workers.length
            ? shared(raster.bitDepth === 16 ? new Uint16Array(input.length) : new Uint8Array(input.length))
            : raster.bitDepth === 16 ? new Uint16Array(input.length) : new Uint8Array(input.length);

        return new Promise<Raster | Uint32Array>((resolve, reject) => {
            const pending: Pending = {
                id: ++this.nextId,
                op,
                tiles,
                next: 0,
                done: 0,
                input,
                output,
                histogram: histogram ? new Uint32Array(raster.maxval + 1) : null,
                meta: { width: raster.width, height: raster.height, channels: raster.channels, bitDepth: raster.bitDepth, maxval: raster.maxval },
                resolve,
                reject,
                onProgress: options.onProgress,
                signal: options.signal,
            };
            if (options.signal) {
                const signal = options.signal;
                const onAbort = (): void => {
                    // nothing is published for the task any more: late replies find no pending task
                    this.active.delete(pending.id);
                    for (const worker of this.workers) worker.postMessage({ cancel: pending.id });
                    reject(abortError());
                };
                signal.addEventListener('abort', onAbort, { once: true });
                pending.onAbort = onAbort;
            }
            this.active.set(pending.id, pending);
            if (this.workers.length) this.pump();
            else void this.runLocal(pending);
        });
    }

    /** Stops the workers (rejecting what runs); the pool can't be used afterwards */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const error = new RasterError('RasterPool: closed');
        for (const pending of this.active.values()) {
            pending.signal?.removeEventListener('abort', pending.onAbort as () => void);
            pending.reject(error);
        }
        this.active.clear();
        await Promise.all(this.workers.map(w => w.terminate()));
        this.workers = [];
        this.idle = [];
    }

    // hands tiles to idle workers until both run out
    private pump(): void {
        while (this.idle.length) {
            let task: Pending | undefined;
            for (const pending of this.active.values()) {
                if (pending.next < pending.tiles.length) {
                    task = pending;
                    break;
                }
            }
            if (!task) return;
            const worker = this.idle.pop() as NodeWorker;
            const [y0, y1] = task.tiles[task.next++];
            const request: TileRequest = {
                id: task.id,
                op: task.op,
                width: task.meta.width,
                channels: task.meta.channels,
                maxval: task.meta.maxval,
                y0,
                y1,
                input: task.input,
                output: task.output ?? undefined,
            };
            worker.postMessage(request);
        }
    }

    private reply(worker: NodeWorker, m: TileReply): void {
        this.idle.push(worker);
        const pending = this.active.get(m.id);
        if (pending) {
            if (m.error) {
                this.active.delete(m.id);
                pending.signal?.removeEventListener('abort', pending.onAbort as () => void);
                pending.reject(Object.assign(new Error(m.error.message), { stage: m.error.stage, tileX: m.error.tileX, tileY: m.error.tileY }));
            } else {
                if (m.histogram && pending.histogram)
                    for (let i = 0; i < pending.histogram.length; i++) pending.histogram[i] += m.histogram[i];
                pending.done++;
                pending.onProgress?.(pending.done, pending.tiles.length);
                if (pending.done === pending.tiles.length && this.active.delete(m.id)) {
                    pending.signal?.removeEventListener('abort', pending.onAbort as () => void);
                    pending.resolve(pending.histogram ?? { ...pending.meta, data: pending.output as Uint8Array | Uint16Array });
                }
            }
        }
        this.pump();
    }

    // without workers the same tiles run here, yielding between them so aborts and other tasks get a chance
    private async runLocal(pending: Pending): Promise<void> {
        let yielded = Date.now();
        while (pending.next < pending.tiles.length) {
            if (!this.active.has(pending.id)) return;
            const [y0, y1] = pending.tiles[pending.next++];
            try {
                const partial = runTile(pending.op, pending.input, pending.output ?? undefined, pending.meta.width, pending.meta.channels, pending.meta.maxval, y0, y1);
                if (partial && pending.histogram)
                    for (let i = 0; i < pending.histogram.length; i++) pending.histogram[i] += partial[i];
            } catch (e) {
                this.active.delete(pending.id);
                pending.signal?.removeEventListener('abort', pending.onAbort as () => void);
                pending.reject(tileError(e, pending.op, y0));
                return;
            }
            pending.done++;
            pending.onProgress?.(pending.done, pending.tiles.length);
            if (Date.now() - yielded > 12) {
                yielded = Date.now();
                await new Promise(resolve => setTimeout(resolve as () => void, 0));
            }
        }
        if (this.active.delete(pending.id)) {
            pending.signal?.removeEventListener('abort', pending.onAbort as () => void);
            pending.resolve(pending.histogram ?? { ...pending.meta, data: pending.output as Uint8Array | Uint16Array });
        }
    }

    // a crashed worker rejects everything running; the pool is done
    private failAll(): void {
        this.closed = true;
        const error = new RasterError('RasterPool: a worker failed');
        for (const pending of this.active.values()) pending.reject(error);
        this.active.clear();
        for (const worker of this.workers) void worker.terminate();
        this.workers = [];
        this.idle = [];
    }
}
