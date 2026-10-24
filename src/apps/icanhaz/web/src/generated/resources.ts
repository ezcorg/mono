// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/resources@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, encodeBytes, readBool, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/resources@0.1.0";



function enc_89(v: Uint8Array): number[] {
    return encodeBytes(v);
}



export async function drop(t: WrpcTransport, handle: Uint8Array): Promise<boolean> {
    const resp = await invoke(t, INSTANCE, "drop", [...enc_89(handle)]);
    return readBool(resultValue(resp), 0)[0];
}
