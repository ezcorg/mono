import type { Transport } from "@codemirror/lsp-client"

/// Creates a Transport adapter that bridges a MessagePort (which
/// sends/receives JSON objects) to lsp-client's Transport interface
/// (which sends/receives JSON strings).
export function messagePortTransport(port: MessagePort): Transport {
    let handlers: ((value: string) => void)[] = []

    port.addEventListener("message", (ev: MessageEvent) => {
        let msg = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data)
        for (let handler of handlers) handler(msg)
    })

    return {
        send(message: string) {
            port.postMessage(JSON.parse(message))
        },
        subscribe(handler: (value: string) => void) {
            handlers.push(handler)
        },
        unsubscribe(handler: (value: string) => void) {
            handlers = handlers.filter(h => h !== handler)
        }
    }
}
