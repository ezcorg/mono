import { transferHandlers, proxy } from 'comlink';
import type { TransferHandler } from 'comlink';

const proxyTransferHandler = transferHandlers.get('proxy')!;

// Allows us to use watch as a normal async generator
export const asyncGeneratorTransferHandler: TransferHandler<
    AsyncGenerator<unknown>, unknown
> = {
    canHandle(obj: any): obj is AsyncGenerator<unknown> {
        return (
            obj &&
            typeof obj === 'object' &&
            typeof obj.next === 'function' &&
            (typeof obj[Symbol.iterator] === 'function' ||
                typeof obj[Symbol.asyncIterator] === 'function')
        );
    },
    serialize(obj) {
        return proxyTransferHandler.serialize(proxy(obj));
    },
    async *deserialize(obj) {
        const iterator = proxyTransferHandler.deserialize(
            obj
        ) as AsyncIterator<unknown>;

        while (true) {
            const { value, done } = await iterator.next();

            if (done) {
                break;
            }

            yield value;
        }
    },
};

// Allows aborting watches across workers (like when our current file changes).
export const watchOptionsTransferHandler: TransferHandler<
    { signal: AbortSignal; encoding?: string; recursive?: boolean },
    { port: MessagePort; encoding?: string; recursive?: boolean }
> = {
    canHandle: (obj: any): obj is { signal: AbortSignal; encoding?: string; recursive?: boolean } => {
        return obj && typeof obj === "object" && obj.signal instanceof AbortSignal;
    },
    serialize: (options) => {
        const { signal, ...rest } = options;
        const { port1, port2 } = new MessageChannel();

        signal.addEventListener(
            "abort",
            () => {
                port1.postMessage({});
                port1.close();
            },
            { once: true }
        );

        return [{ port: port2, ...rest }, [port2]];
    },
    deserialize: (data) => {
        const { port, ...rest } = data;
        const controller = new AbortController();

        port.onmessage = () => {
            controller.abort();
            port.close();
        };

        return { signal: controller.signal, ...rest };
    },
};

