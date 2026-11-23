// tests for the lossless color and geometry operators
const assert = require('assert');
const ops = require('../dist/lossless/ops.js');

const raster8 = (width, height, channels, data, maxval = 255) =>
    ({ width, height, channels, bitDepth: 8, maxval, data: Uint8Array.from(data) });
const raster16 = (width, height, channels, data, maxval = 65535) =>
    ({ width, height, channels, bitDepth: 16, maxval, data: Uint16Array.from(data) });

// reference implementations, written independently of the module's
const refSrgbToLinear = (v, max) => {
    const c = v / max;
    return Math.min(max, Math.max(0, Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * max)));
};
const refLinearToSrgb = (v, max) => {
    const c = v / max;
    return Math.min(max, Math.max(0, Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * max)));
};
const refScale = (src, width, height) => {
    const { width: sw, height: sh, channels, maxval } = src;
    const out = new (src.data.constructor)(width * height * channels);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(Math.max((y + 0.5) * sh / height - 0.5, 0), sh - 1);
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
        for (let x = 0; x < width; x++) {
            const sx = Math.min(Math.max((x + 0.5) * sw / width - 0.5, 0), sw - 1);
            const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
            for (let c = 0; c < channels; c++) {
                const v = src.data[(y0 * sw + x0) * channels + c] * (1 - fx) * (1 - fy)
                    + src.data[(y0 * sw + x1) * channels + c] * fx * (1 - fy)
                    + src.data[(y1 * sw + x0) * channels + c] * (1 - fx) * fy
                    + src.data[(y1 * sw + x1) * channels + c] * fx * fy;
                out[(y * width + x) * channels + c] = Math.min(maxval, Math.max(0, Math.round(v)));
            }
        }
    }
    return out;
};

(async () => {
    // linear/sRGB conversion: every 8 bit value against the reference, peaks exact
    const ramp = raster8(256, 1, 1, [...Array(256)].map((_, i) => i));
    const linear = ops.toLinearLight(ramp);
    const srgb = ops.toSrgb(ramp);
    for (let v = 0; v < 256; v++) {
        assert.strictEqual(linear.data[v], refSrgbToLinear(v, 255), `toLinear ${v}`);
        assert.strictEqual(srgb.data[v], refLinearToSrgb(v, 255), `toSrgb ${v}`);
    }
    assert.strictEqual(linear.data[0], 0);
    assert.strictEqual(linear.data[255], 255);
    assert.strictEqual(linear.data[128], 55);

    // 16 bit peaks and midtones
    const peaks = raster16(3, 1, 1, [0, 32768, 65535]);
    const linear16 = ops.toLinearLight(peaks);
    assert(linear16.data instanceof Uint16Array, '16 bit stays 16 bit');
    assert.strictEqual(linear16.data[0], 0);
    assert.strictEqual(linear16.data[2], 65535);
    assert.strictEqual(linear16.data[1], refSrgbToLinear(32768, 65535));
    assert.strictEqual(ops.toSrgb(peaks).data[1], refLinearToSrgb(32768, 65535));

    // alpha is not converted
    const rgba = raster8(1, 1, 4, [10, 128, 250, 7]);
    assert.strictEqual(ops.toLinearLight(rgba).data[3], 7);
    assert.strictEqual(ops.toSrgb(rgba).data[3], 7);

    // premultiplied alpha round trips, 8 and 16 bit
    const px = raster8(3, 1, 4, [200, 100, 50, 255, 255, 255, 255, 128, 10, 20, 30, 0]);
    const pre = ops.premultiply(px);
    assert.deepStrictEqual([...pre.data], [200, 100, 50, 255, 128, 128, 128, 128, 0, 0, 0, 0]);
    const back = ops.unpremultiply(pre);
    assert.deepStrictEqual([...back.data], [200, 100, 50, 255, 255, 255, 255, 128, 0, 0, 0, 0]);
    const pre16 = ops.premultiply(raster16(1, 1, 4, [65535, 0, 0, 32768]));
    assert.strictEqual(pre16.data[0], 32768);
    assert.strictEqual(ops.unpremultiply(pre16).data[0], 65535);
    // greyscale + alpha, and the round trip is within one rounding step
    const ga = raster8(64, 1, 2, [...Array(64)].flatMap(i => [i * 4, i * 4]));
    const round = ops.unpremultiply(ops.premultiply(ga));
    for (let i = 0; i < 64; i++) {
        if (ga.data[i * 2 + 1] === 0) assert.strictEqual(round.data[i * 2], 0);
        else assert(Math.abs(round.data[i * 2] - ga.data[i * 2]) <= 1, `round trip at ${i}`);
    }
    assert.throws(() => ops.premultiply(raster8(1, 1, 3, [1, 2, 3])), /alpha/);

    // greyscale histograms and percentiles
    const hist = ops.histogramGray(raster8(2, 2, 1, [0, 10, 10, 255]));
    assert.strictEqual(hist.length, 256);
    assert.deepStrictEqual([hist[0], hist[10], hist[255]], [1, 2, 1]);
    assert.strictEqual(ops.percentile(hist, 0), 0);
    assert.strictEqual(ops.percentile(hist, 50), 10);
    assert.strictEqual(ops.percentile(hist, 100), 255);
    // RGB luma (Rec. 601, rounded); alpha ignored
    const color = ops.histogramGray(raster8(1, 2, 4, [255, 0, 0, 9, 0, 0, 0, 200]));
    assert.strictEqual(color[76], 1);
    assert.strictEqual(color[0], 1);
    // 16 bit: the peak value has its own bin
    const hist16 = ops.histogramGray(raster16(1, 2, 1, [0, 65535]));
    assert.strictEqual(hist16.length, 65536);
    assert.strictEqual(hist16[65535], 1);
    assert.strictEqual(ops.percentile(hist16, 100), 65535);
    // NaN and Infinity percentiles are rejected, an empty histogram has no percentile
    assert.throws(() => ops.percentile(hist, NaN), RangeError);
    assert.throws(() => ops.percentile(hist, Infinity), RangeError);
    assert.throws(() => ops.percentile(hist, 101), RangeError);
    assert.throws(() => ops.percentile(new Uint32Array(256), 50), /empty/);

    // 90 degree rotations are exact, odd sizes included; negative turns go counterclockwise
    const odd = raster8(3, 2, 1, [1, 2, 3, 4, 5, 6]);
    const cw = ops.rotate90(odd);
    assert.deepStrictEqual([cw.width, cw.height], [2, 3]);
    assert.deepStrictEqual([...cw.data], [4, 1, 5, 2, 6, 3]);
    assert.deepStrictEqual([...ops.rotate90(odd, 4).data], [...odd.data]);
    assert.deepStrictEqual([...ops.rotate90(odd, -1).data], [...ops.rotate90(odd, 3).data]);
    // per channel, 16 bit
    const cw16 = ops.rotate90(raster16(2, 1, 2, [0, 65535, 256, 1]));
    assert.deepStrictEqual([...cw16.data], [0, 65535, 256, 1]);
    assert.throws(() => ops.rotate90(odd, NaN), RangeError);
    assert.throws(() => ops.rotate90(odd, 0.5), RangeError);

    // bilinear scaling against the reference implementation, odd and edge sizes
    const src = raster8(3, 3, 3, [...Array(27)].map((_, i) => (i * 37) & 0xff));
    for (const [w, h] of [[3, 3], [5, 2], [2, 5], [1, 1], [7, 7]])
        assert.deepStrictEqual([...ops.scaleBilinear(src, w, h).data], [...refScale(src, w, h)], `scale to ${w}x${h}`);
    // identity at the same size, edges included
    assert.deepStrictEqual([...ops.scaleBilinear(src, 3, 3).data], [...src.data]);
    // 16 bit peaks survive scaling
    const peak = raster16(2, 1, 1, [0, 65535]);
    assert.strictEqual(ops.scaleBilinear(peak, 4, 1).data[3], 65535);
    assert.strictEqual(ops.scaleBilinear(peak, 1, 1).data[0], 32768);
    // a fully transparent pixel contributes no color (premultiplied scaling)
    const fade = raster8(2, 1, 4, [0, 0, 0, 0, 255, 0, 0, 255]);
    const mid = ops.scaleBilinear(fade, 1, 1);
    assert.deepStrictEqual([...mid.data], [255, 0, 0, 128]);
    const transparent = ops.scaleBilinear(raster8(2, 2, 4, new Array(16).fill(0)), 1, 1);
    assert.deepStrictEqual([...transparent.data], [0, 0, 0, 0]);
    // invalid dimensions are rejected, NaN and Infinity included
    for (const bad of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => ops.scaleBilinear(src, bad, 2), /width/);

    // operators never mutate their input, and repeated runs share no mutable cache
    const input = raster8(4, 4, 4, [...Array(64)].map((_, i) => (i * 13 + 7) & 0xff));
    const snapshot = [...input.data];
    const first = ops.toLinearLight(input);
    first.data[0] = 255;
    const second = ops.toLinearLight(input);
    assert.notStrictEqual(first.data, second.data);
    assert.strictEqual(second.data[0], refSrgbToLinear(snapshot[0], 255));
    for (const run of [ops.toSrgb, ops.premultiply, ops.unpremultiply, ops.histogramGray, ops.rotate90, r => ops.scaleBilinear(r, 3, 5)]) {
        run(input);
        run(input);
    }
    assert.deepStrictEqual([...input.data], snapshot, 'input not mutated');

    console.log('lossless-ops: ok');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
