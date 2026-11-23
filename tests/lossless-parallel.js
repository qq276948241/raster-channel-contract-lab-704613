// tests for the tiled worker pool: chunked execution, monotonic progress, cancellation, worker reuse,
// concurrency, error stages and resource cleanup
const assert = require('assert');
const ops = require('../dist/lossless/ops.js');
const { RasterPool } = require('../dist/lossless/parallel.js');

const gradient = (width, height, channels = 4) => ({
    width,
    height,
    channels,
    bitDepth: 8,
    maxval: 255,
    data: Uint8Array.from({ length: width * height * channels }, (_, i) => (i * 7 + (i >> 8)) & 0xff),
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const image = gradient(96, 64);

    // local mode (no workers): the same results as the direct operators
    const local = new RasterPool(0);
    assert.strictEqual(local.size, 0);
    const localLinear = await local.run('to-linear', image, { rowsPerTile: 7 });
    assert.deepStrictEqual([...localLinear.data], [...ops.toLinearLight(image).data]);
    const localHist = await local.run('histogram', image, { rowsPerTile: 7 });
    assert.deepStrictEqual([...localHist], [...ops.histogramGray(image)]);
    // a pre-aborted signal rejects before anything runs
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(local.run('to-linear', image, { signal: preAborted.signal }), e => e.name === 'AbortError');
    // invalid rasters reject with the validate stage
    await assert.rejects(local.run('to-linear', { ...image, data: new Uint8Array(3) }), e => e.stage === 'validate');
    // unknown operators carry the stage and the tile's coordinates
    await assert.rejects(local.run('no-such-op', image, { rowsPerTile: 7 }),
        e => e.stage === 'no-such-op' && e.tileX === 0 && e.tileY === 0);
    await local.close();

    const pool = new RasterPool();
    assert(pool.size > 0, 'worker threads unavailable');

    // chunked execution on workers: the result matches the direct operator exactly, per channel
    const progress = [];
    const linear = await pool.run('to-linear', image, { rowsPerTile: 4, onProgress: (done, total) => progress.push([done, total]) });
    assert.deepStrictEqual([...linear.data], [...ops.toLinearLight(image).data]);
    assert(linear.data instanceof Uint8Array);

    // progress is monotonic and ends at the total
    assert(progress.length > 1, 'the task ran in chunks');
    for (let i = 1; i < progress.length; i++) assert(progress[i][0] > progress[i - 1][0], 'progress is monotonic');
    assert.deepStrictEqual(progress[progress.length - 1], [16, 16]);

    // histograms reduce over the tiles
    const hist = await pool.run('histogram', image, { rowsPerTile: 4 });
    assert.deepStrictEqual([...hist], [...ops.histogramGray(image)]);

    // the same workers are reusable: sequential tasks on one pool
    const srgb = await pool.run('to-srgb', image, { rowsPerTile: 4 });
    assert.deepStrictEqual([...srgb.data], [...ops.toSrgb(image).data]);

    // two concurrent tasks don't write into each other's output
    const other = gradient(48, 48);
    const [a, b] = await Promise.all([
        pool.run('to-linear', image, { rowsPerTile: 3 }),
        pool.run('premultiply', other, { rowsPerTile: 3 }),
    ]);
    assert.notStrictEqual(a.data.buffer, b.data.buffer);
    assert.deepStrictEqual([...a.data], [...ops.toLinearLight(image).data]);
    assert.deepStrictEqual([...b.data], [...ops.premultiply(other).data]);

    // worker errors carry the stage and the tile's coordinates
    await assert.rejects(pool.run('bogus-op', image, { rowsPerTile: 4 }),
        e => e.stage === 'bogus-op' && e.tileX === 0 && typeof e.tileY === 'number');

    // cancellation: an aborted task rejects with an AbortError and publishes nothing more
    const big = gradient(512, 512);
    const controller = new AbortController();
    const seen = [];
    let settled = null;
    const task = pool.run('to-linear', big, {
        rowsPerTile: 2,
        signal: controller.signal,
        onProgress: (done, total) => {
            seen.push(done);
            if (done === 2) controller.abort();
        },
    });
    task.then(() => settled = 'resolved', e => settled = e.name);
    await assert.rejects(task, e => e.name === 'AbortError');
    await sleep(50);
    const countAtAbort = seen.length;
    await sleep(100);
    assert.strictEqual(seen.length, countAtAbort, 'no progress after the abort');
    assert.strictEqual(settled, 'AbortError', 'settled once, as aborted');

    // the pool is still usable afterwards (its workers survived the cancelled task)
    const after = await pool.run('to-srgb', image, { rowsPerTile: 4 });
    assert.deepStrictEqual([...after.data], [...ops.toSrgb(image).data]);

    // closing the pool releases its workers; it rejects further tasks
    await pool.close();
    await assert.rejects(pool.run('to-linear', image), /closed/);

    console.log('lossless-parallel: ok');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
