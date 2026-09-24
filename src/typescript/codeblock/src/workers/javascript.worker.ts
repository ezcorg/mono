/**
 * TypeScript/JavaScript LSP SharedWorker.
 *
 * Each language server is given a port to its editor's filesystem
 * (`vfsPort`), reached with `remoteVfs`.
 */

import * as Comlink from 'comlink';
import { remoteVfs } from '@joinezco/storage';
import { createLanguageServer } from '../lsps/typescript';
import { createConnection } from 'vscode-languageserver/browser';
import { BrowserMessageReader, BrowserMessageWriter } from '@volar/language-server/browser';

onconnect = async (event) => {
    const [port] = event.ports;

    const { port1: lspPort, port2: clientLspPort } = new MessageChannel();
    lspPort.start();

    const reader = new BrowserMessageReader(lspPort);
    const writer = new BrowserMessageWriter(lspPort);
    const connection = createConnection(reader, writer);
    connection.listen();

    const factory = async (config: { fsPort: MessagePort; libFiles?: Record<string, string> }) => {
        const { fsPort, libFiles } = config;
        const fs = remoteVfs(fsPort);
        await createLanguageServer({ fs, connection, libFiles });
        return Comlink.transfer(clientLspPort, [clientLspPort]);
    };

    Comlink.expose({ createLanguageServer: factory }, port);
}
