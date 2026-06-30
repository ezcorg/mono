import { describe, it, expect } from "vitest";
import { leb128, readLeb128, readLeb128Big, sleb128, readSleb128Big, readU8, readS8, encChar, readChar } from "./wrpc";

// The primitive wire encodings, aligned with wrpc-transport's `value.rs` (the
// reference codec). These cover the cases the old reverse-engineered codec got
// wrong; none need a daemon.
describe("wRPC primitive codec", () => {
    it("u64 LEB128 round-trips past 2^53 (the old 32-bit codec corrupted this)", () => {
        const v = (1n << 50n) + 12345n;
        const bytes = new Uint8Array(leb128(v));
        expect(readLeb128Big(bytes, 0)[0]).toBe(v);
    });

    it("signed LEB128 round-trips a large negative s64", () => {
        const v = -(1n << 40n) - 7n;
        const bytes = new Uint8Array(sleb128(v));
        expect(readSleb128Big(bytes, 0)[0]).toBe(v);
    });

    it("u8/s8 ≥ 128 is a single raw byte, not multi-byte LEB128", () => {
        expect(readU8(new Uint8Array([200]), 0)).toEqual([200, 1]);
        expect(readS8(new Uint8Array([200]), 0)).toEqual([-56, 1]); // 200 − 256
    });

    it("char is raw UTF-8 (multi-byte scalars survive)", () => {
        const bytes = new Uint8Array(encChar("€")); // U+20AC → 3 UTF-8 bytes
        expect(bytes.length).toBe(3);
        expect(readChar(bytes, 0)).toEqual(["€", 3]);
    });

    it("small unsigned values keep the canonical 1-byte form", () => {
        expect(leb128(5)).toEqual([5]);
        expect(readLeb128(new Uint8Array([5]), 0)).toEqual([5, 1]);
    });
});
