// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `demo:res/counter@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, encodeBytes, readBytes, invoke, resultValue } from "../wrpc";

const INSTANCE = "demo:res/counter@0.1.0";



function enc_1(v: Uint8Array): number[] {
    return encodeBytes(v);
}

function dec_2(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function counterNew(t: WrpcTransport, start: number): Promise<Uint8Array> {
    const resp = await invoke(t, INSTANCE, "counter", [...leb128(start)]);
    return dec_2(resultValue(resp), 0)[0];
}

export async function counterIncrement(t: WrpcTransport, self: Uint8Array, by: number): Promise<number> {
    const resp = await invoke(t, INSTANCE, "counter.increment", [...enc_1(self), ...leb128(by)]);
    return readLeb128(resultValue(resp), 0)[0];
}

export async function counterValue(t: WrpcTransport, self: Uint8Array): Promise<number> {
    const resp = await invoke(t, INSTANCE, "counter.value", [...enc_1(self)]);
    return readLeb128(resultValue(resp), 0)[0];
}

export async function counterFromValue(t: WrpcTransport, v: number): Promise<Uint8Array> {
    const resp = await invoke(t, INSTANCE, "counter.from-value", [...leb128(v)]);
    return dec_2(resultValue(resp), 0)[0];
}

export async function make(t: WrpcTransport, start: number): Promise<Uint8Array> {
    const resp = await invoke(t, INSTANCE, "make", [...leb128(start)]);
    return dec_2(resultValue(resp), 0)[0];
}
