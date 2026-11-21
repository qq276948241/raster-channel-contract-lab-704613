// Strict binary reading for the lossless codecs: a cursor that only moves forward, every read range-checked before it
// happens, and errors that name the field they were reading and the offset they were at.
//
// The reader is deliberately small and format-agnostic. The Netpbm and TIFF-like decoders build their header parsing on
// top of it, which keeps every bounds check in one place (and one tested place).

/** An error in binary data: which field failed, and where the reader was (and how far the data goes) */
export class BinaryError extends RangeError {
    /** The field being read (a header tag, a sample, ...) */
    readonly field: string;
    /** The offset the read started at */
    readonly offset: number;
    /** The length of the data that was available */
    readonly length: number;

    constructor(message: string, field: string, offset: number, length: number) {
        super(`${message} (field "${field}" at offset ${offset}, ${length} bytes available)`);
        this.name = 'BinaryError';
        this.field = field;
        this.offset = offset;
        this.length = length;
    }
}

/**
 * A forward-only, bounds-checked cursor over a byte array
 *
 * Every read checks the complete range it needs *before* touching memory, so a truncated file throws a
 * {@link BinaryError} naming the field and offset instead of reading undefined bytes (or crashing on a range error
 * from a typed array). Integers are unsigned; `bigEndian` says how multi-byte ones are laid out.
 */
export class BinaryReader {
    private readonly bytes: Uint8Array;
    private readonly view: DataView;
    private offsetValue = 0;
    readonly bigEndian: boolean;

    constructor(data: Uint8Array | ArrayBuffer | DataView, bigEndian = true) {
        if (data instanceof DataView) {
            this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            this.view = data;
        } else if (data instanceof ArrayBuffer) {
            this.bytes = new Uint8Array(data);
            this.view = new DataView(data);
        } else {
            this.bytes = data;
            this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        }
        this.bigEndian = bigEndian;
    }

    /** The byte array being read */
    get data(): Uint8Array {
        return this.bytes;
    }

    /** The number of bytes */
    get length(): number {
        return this.bytes.length;
    }

    /** The current offset */
    get offset(): number {
        return this.offsetValue;
    }

    /** The bytes left from the current offset */
    get remaining(): number {
        return this.bytes.length - this.offsetValue;
    }

    /** The number of bytes read so far (the same as {@link offset}) */
    get position(): number {
        return this.offsetValue;
    }

    /** Whether the cursor is at the end */
    get done(): boolean {
        return this.offsetValue >= this.bytes.length;
    }

    /** Throws a {@link BinaryError} for the field, unless `count` more bytes are available */
    require(count: number, field: string): void {
        if (!Number.isSafeInteger(count) || count < 0)
            throw new BinaryError(`Invalid length ${count}`, field, this.offsetValue, this.bytes.length);
        if (this.offsetValue + count > this.bytes.length)
            throw new BinaryError(`Truncated ${field}: needs ${count} bytes`, field, this.offsetValue, this.bytes.length);
    }

    /** Throws a {@link BinaryError} for the field, unless `offset` and `count` more bytes lie within the data */
    requireAt(offset: number, count: number, field: string): void {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0 || offset + count > this.bytes.length)
            throw new BinaryError(`Truncated ${field}: needs ${count} bytes at ${offset}`, field, offset, this.bytes.length);
    }

    /** Moves the cursor forward, throwing if that would pass the end */
    skip(count: number, field = 'data'): void {
        this.require(count, field);
        this.offsetValue += count;
    }

    /** Moves the cursor to an absolute offset (which must be within the data) */
    seek(offset: number, field = 'data'): void {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.bytes.length)
            throw new BinaryError(`Invalid offset ${offset}`, field, offset, this.bytes.length);
        this.offsetValue = offset;
    }

    /** The byte at an absolute offset */
    byteAt(offset: number, field = 'byte'): number {
        this.requireAt(offset, 1, field);
        return this.bytes[offset];
    }

    /** The next byte */
    u8(field = 'byte'): number {
        this.require(1, field);
        return this.bytes[this.offsetValue++];
    }

    /** The next big or little endian 16-bit integer */
    u16(field = 'uint16', bigEndian = this.bigEndian): number {
        this.require(2, field);
        const value = this.view.getUint16(this.offsetValue, !bigEndian);
        this.offsetValue += 2;
        return value;
    }

    /** The next big or little endian 32-bit integer */
    u32(field = 'uint32', bigEndian = this.bigEndian): number {
        this.require(4, field);
        const value = this.view.getUint32(this.offsetValue, !bigEndian);
        this.offsetValue += 4;
        return value;
    }

    /** The next 32-bit float */
    f32(field = 'float32', bigEndian = this.bigEndian): number {
        this.require(4, field);
        const value = this.view.getFloat32(this.offsetValue, !bigEndian);
        this.offsetValue += 4;
        return value;
    }

    /** The next `count` bytes as a view (no copy) */
    bytes_(count: number, field = 'bytes'): Uint8Array {
        this.require(count, field);
        const out = this.bytes.subarray(this.offsetValue, this.offsetValue + count);
        this.offsetValue += count;
        return out;
    }

    /** The next `count` bytes as a copy */
    copy(count: number, field = 'bytes'): Uint8Array {
        return this.bytes_(count, field).slice();
    }

    /** Reads an unsigned integer of `size` bytes (1, 2, 4) */
    uint(size: 1 | 2 | 4, field = 'uint', bigEndian = this.bigEndian): number {
        return size === 1 ? this.u8(field) : size === 2 ? this.u16(field, bigEndian) : this.u32(field, bigEndian);
    }
}

/**
 * A writer for small binary payloads with the same bounds discipline: it grows geometrically (bounded by `limit`) and
 * throws a {@link BinaryError} naming the field before it would exceed its limit
 */
export class BinaryWriter {
    private buffer: Uint8Array;
    private view: DataView;
    private offsetValue = 0;
    readonly limit: number;

    constructor(limit = 1 << 20) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`The buffer limit must be a positive integer, not ${limit}`);
        this.limit = limit;
        this.buffer = new Uint8Array(Math.min(limit, 256));
        this.view = new DataView(this.buffer.buffer);
    }

    /** The bytes written so far (a view, not a copy) */
    get bytes(): Uint8Array {
        return this.buffer.subarray(0, this.offsetValue);
    }

    /** The number of bytes written */
    get length(): number {
        return this.offsetValue;
    }

    private ensure(count: number, field: string): void {
        const needed = this.offsetValue + count;
        if (!Number.isSafeInteger(needed) || needed > this.limit)
            throw new BinaryError(`Exceeds the buffer limit of ${this.limit} bytes`, field, this.offsetValue, this.buffer.length);
        if (needed <= this.buffer.length) return;

        let size = this.buffer.length || 1;
        while (size < needed) size = Math.min(this.limit, size * 2);
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(0, this.offsetValue));
        this.buffer = grown;
        this.view = new DataView(grown.buffer);
    }

    /** Appends a byte */
    u8(value: number, field = 'byte'): this {
        this.ensure(1, field);
        this.buffer[this.offsetValue++] = value & 0xff;
        return this;
    }

    /** Appends a big or little endian 16-bit integer */
    u16(value: number, field = 'uint16', bigEndian = true): this {
        this.ensure(2, field);
        this.view.setUint16(this.offsetValue, value & 0xffff, !bigEndian);
        this.offsetValue += 2;
        return this;
    }

    /** Appends a big or little endian 32-bit integer */
    u32(value: number, field = 'uint32', bigEndian = true): this {
        this.ensure(4, field);
        this.view.setUint32(this.offsetValue, value >>> 0, !bigEndian);
        this.offsetValue += 4;
        return this;
    }

    /** Appends a 32-bit float */
    f32(value: number, field = 'float32', bigEndian = true): this {
        this.ensure(4, field);
        this.view.setFloat32(this.offsetValue, value, !bigEndian);
        this.offsetValue += 4;
        return this;
    }

    /** Appends bytes */
    write(bytes: ArrayLike<number>, field = 'bytes'): this {
        this.ensure(bytes.length, field);
        this.buffer.set(bytes, this.offsetValue);
        this.offsetValue += bytes.length;
        return this;
    }

    /** Appends ASCII text (a byte per character) */
    ascii(text: string, field = 'text'): this {
        this.ensure(text.length, field);
        for (let i = 0; i < text.length; i++) this.buffer[this.offsetValue++] = text.charCodeAt(i) & 0x7f;
        return this;
    }

    /** A copy of the bytes written */
    toUint8Array(): Uint8Array {
        return this.buffer.slice(0, this.offsetValue);
    }
}
