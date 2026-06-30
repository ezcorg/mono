/**
 * Node proof of the *streaming* wRPC client: opens an interactive terminal over
 * wRPC streams (a stdin sub-channel + a stdout sub-channel multiplexed on a
 * WebSocket via the Conn-frame codec), types a command, and checks the shell
 * echoes it back. Node ≥22's `WebSocket` is the same one the browser uses, so
 * this exercises the exact streaming path the browser will run.
 *
 *   node --experimental-strip-types test-terminal.ts
 */
import { connect, openTerminal } from "./src/wrpc.ts";

const url = process.env.ICANHAZ_TERM_URL ?? "ws://127.0.0.1:7777";

async function main() {
    const t = await connect({ ws: url }); // Node → WebSocket
    const term = await openTerminal(t, { cols: 80, rows: 24 });
    const dec = new TextDecoder();
    let out = "";
    term.onOutput((b) => {
        out += dec.decode(b);
    });

    const done = new Promise<void>((resolve) => {
        term.onExit(() => resolve());
        setTimeout(resolve, 12000); // fallback so the test can't hang
    });

    // Let the login shell finish its (noisy) startup before typing, the way a
    // human would. Then type a command and exit; the shell echoes the marker.
    await new Promise((r) => setTimeout(r, 2000));
    term.write("echo wrpc-stream-works\n");
    await new Promise((r) => setTimeout(r, 300));
    term.resize(100, 40); // reshape the tty mid-session (cols=100, rows=40)
    await new Promise((r) => setTimeout(r, 300));
    term.write("stty size\n"); // prints "rows cols" → "40 100" once the resize lands
    await new Promise((r) => setTimeout(r, 500));
    term.write("exit\n");

    await done;
    t.close();

    const clean = out.replace(/\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
    const marker = out.includes("wrpc-stream-works");
    const resized = out.includes("40 100");
    const ok = marker && resized;
    console.log("--- shell output ---");
    console.log(clean.trim());
    console.log("--------------------");
    console.log(
        ok
            ? "PASS — wRPC streams: shell echoed the marker + resize took effect (stty size = 40 100)."
            : `FAIL — marker:${marker} resized:${resized}`,
    );
    process.exit(ok ? 0 : 1);
}
main().catch((e) => {
    console.error("test error:", e);
    process.exit(1);
});
