import * as Comlink from 'comlink';
import { createLanguageServer } from '../lsps/typescript';
import { createConnection } from 'vscode-languageserver/browser';
import { BrowserMessageReader, BrowserMessageWriter } from '@volar/language-server/browser';
import { VfsInterface } from '../types';

// TODO: get rid of this
// instead, create language specific workers (with a smarter client)
// i.e typescript.worker.ts / rust.worker.ts / ...
onconnect = async (event) => {
    const [port] = event.ports;
    console.debug('LSP worker connected on port: ', port);
    const reader = new BrowserMessageReader(port);
    const writer = new BrowserMessageWriter(port);
    const connection = createConnection(reader, writer);
    connection.listen();

    const proxy = async ({ fs }: { fs: VfsInterface }) => {
        console.log('creating language server')
        await createLanguageServer({ fs, connection });
    }
    Comlink.expose({ createLanguageServer: proxy }, port);
}
