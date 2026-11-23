// the module a RasterPool's workers run (see parallel.ts): tile tasks posted to it, their results posted back.
// Tiles of cancelled tasks are dropped; errors go back with the stage (the operator) and the tile's coordinates

import { runTile } from './ops.ts';

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

interface Port {
    post(message: unknown): void;
}

interface Globals {
    process?: { getBuiltinModule?: (id: string) => unknown };
    postMessage?: (message: unknown) => void;
    onmessage?: ((event: { data: unknown }) => void) | null;
}

const globals = globalThis as unknown as Globals;

// cancelled task ids (bounded: a stale entry only means a late tile runs and its reply is dropped)
const cancelled = new Set<number>();

function handle(port: Port, m: TileRequest | { cancel: number }): void {
    if ('cancel' in m) {
        cancelled.add(m.cancel);
        if (cancelled.size > 256) cancelled.clear();
        return;
    }
    if (cancelled.has(m.id)) return;
    try {
        const histogram = runTile(m.op, m.input, m.output, m.width, m.channels, m.maxval, m.y0, m.y1);
        port.post({ id: m.id, y0: m.y0, y1: m.y1, histogram: histogram ?? undefined });
    } catch (e) {
        port.post({
            id: m.id,
            y0: m.y0,
            y1: m.y1,
            error: { message: String((e as Error).message ?? e), stage: m.op, tileX: 0, tileY: m.y0 },
        });
    }
}

if (typeof globals.postMessage === 'function' && 'onmessage' in globals) {
    const port = { post: (m: unknown) => (globals.postMessage as (m: unknown) => void)(m) };
    globals.onmessage = e => handle(port, e.data as TileRequest);
} else {
    const { parentPort } = globals.process?.getBuiltinModule?.('node:worker_threads') as { parentPort: { on(e: 'message', l: (m: unknown) => void): void, postMessage(m: unknown): void } };
    const port = { post: (m: unknown) => parentPort.postMessage(m) };
    parentPort.on('message', m => handle(port, m as TileRequest));
}
