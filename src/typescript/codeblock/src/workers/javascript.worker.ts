import * as Comlink from 'comlink';
import { createLanguageServer } from '../lsps/typescript';
import { createConnection } from 'vscode-languageserver/browser';
import { BrowserMessageReader, BrowserMessageWriter } from '@volar/language-server/browser';
import { VfsInterface } from '../types';

onconnect = async (event) => {
    const [port] = event.ports;

    // Use a MessageChannel to separate Comlink RPC from LSP protocol.
    // Both Comlink and BrowserMessageReader listen on the same port's
    // 'message' event, so Comlink messages get misinterpreted as LSP messages.
    const { port1: lspPort, port2: clientLspPort } = new MessageChannel();
    lspPort.start();

    const reader = new BrowserMessageReader(lspPort);
    const writer = new BrowserMessageWriter(lspPort);
    const connection = createConnection(reader, writer);
    connection.listen();

    const proxy = async (fsProxy: VfsInterface, libFiles?: Record<string, string>) => {
        await createLanguageServer({ fs: fsProxy, connection, libFiles });
        // Return the LSP port for the client to use (separate from Comlink port)
        return Comlink.transfer(clientLspPort, [clientLspPort]);
    }
    Comlink.expose({ createLanguageServer: proxy }, port);
}
