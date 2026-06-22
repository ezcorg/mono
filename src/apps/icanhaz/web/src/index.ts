// Browser NoCap client (scaffold).
//
// Wires a markdown-editor codeblock to a remote `runtime` (your machine's
// `icanhazd`) over wRPC. It implements the backend-agnostic `Runtime` interface
// the editor consumes, so `icanhaz` is just one of several possible backends
// (in-browser WASM, a local companion, a peer, …).
//
// Intended shape:
//
//   const session = await connect("wss://mac.<tailnet>.ts.net");   // via Tailscale
//   const grant   = await session.request(
//     { terminal: { jailed: false } },
//     "open a shell",                                              // the consent prompt
//   );
//   const term = await grant.claimTerminal();
//   term.stdout.pipeTo(xterm.writable);                            // live PTY ⇄ xterm.js
//   xterm.readable.pipeTo(term.stdin);
//   term.resize(cols, rows);
//
// Open work (see README "Status"):
//   - a browser-side wRPC transport over WSS (WebTransport later)
//   - jco-generated bindings for the `client` world (../wit)
//   - the P2→P3 async migration lives in this binding layer

export {};
