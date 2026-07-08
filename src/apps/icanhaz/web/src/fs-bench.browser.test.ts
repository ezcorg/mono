import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";

// The WebSocket transport multiplexes every invocation over ONE persistent socket (the stream-mux
// in wrpc.ts), so an fs op pays no per-call handshake. This guards that win: measure a bare WS
// handshake, then readFile/writeFile/stat — each op must cost far less than a single handshake.
// Before the mux every op opened a fresh socket and paid ~3 handshakes, which dominated fs latency
// (measured ~37ms/op, worst on Firefox); with the mux each op is sub-millisecond.
import { WS } from "./test-ws";

describe("fs perf", () => {
    it("reuses one socket — an fs op costs far less than a fresh WS handshake", async () => {
        // Bare WS handshake (open→close), averaged.
        const H = 10;
        const h0 = performance.now();
        for (let i = 0; i < H; i++) {
            await new Promise<void>((res, rej) => {
                const ws = new WebSocket(WS);
                ws.onopen = () => { ws.close(); res(); };
                ws.onerror = () => rej(new Error("ws error"));
            });
        }
        const handshakeMs = (performance.now() - h0) / H;

        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "bench");
        const fs = await wrpcFilesystem(t, grant);
        await fs.writeFile("bench.txt", "x".repeat(400));

        const N = 20;
        const r0 = performance.now();
        for (let i = 0; i < N; i++) await fs.readFile("bench.txt");
        const readAvgMs = (performance.now() - r0) / N;

        const w0 = performance.now();
        for (let i = 0; i < N; i++) await fs.writeFile("bench.txt", "y".repeat(400));
        const writeAvgMs = (performance.now() - w0) / N;

        const s0 = performance.now();
        for (let i = 0; i < N; i++) await fs.stat("bench.txt");
        const statAvgMs = (performance.now() - s0) / N;

        t.close();

        const r = (n: number) => Math.round(n * 10) / 10;
        console.log("[fs-bench]", {
            handshakeMs: r(handshakeMs),
            statAvgMs: r(statAvgMs),
            readAvgMs: r(readAvgMs),
            writeAvgMs: r(writeAvgMs),
        });

        // The mux reuses one socket, so no op pays a handshake. Each must beat a single fresh
        // WS handshake by a wide margin (in practice ~50×; before the mux each op cost ~3×).
        expect(statAvgMs).toBeLessThan(handshakeMs);
        expect(readAvgMs).toBeLessThan(handshakeMs);
        expect(writeAvgMs).toBeLessThan(handshakeMs);
    }, 60000);
});
