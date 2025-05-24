import { test } from '@playwright/test';
import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from '../rpc/serde';

Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler);
Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler);

declare global {
  interface Window {
    // fs: typeof fs;
  }
}

test.describe('workers/fs', async () => {
  test('should initialize from existing buffer', async ({ page }) => {
    page.on('worker', worker => {
      console.log('Worker created: ' + worker.url());
      // @ts-expect-error
      worker.on('console', msg => {
        console.log(`Worker console message: ${msg}`);
      });
      worker.on('close', worker => console.log('Worker destroyed: ' + worker.url()));
    });
    page.on('console', msg => console.log(msg.text()));
    page.on('console', msg => {
      if (msg.type() === 'error')
        console.log(`Error text: "${msg.text()}"`);
    });
    await page.goto('http://localhost:5173');
    await page.addScriptTag({ url: 'https://unpkg.com/comlink/dist/umd/comlink.js' });
    // const content = await page.evaluate(async (workerUrl) => {
    //   const { asyncGeneratorTransferHandler, watchOptionsTransferHandler } = await import('../../src/rpc/serde.js');
    //   Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler)
    //   Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler)

    //   console.log('before worker??')
    //   console.log(window.location.origin, 'before worker');
    //   const worker = new SharedWorker(workerUrl, { type: 'module' });
    //   console.log({ port: worker.port })
    //   console.log('worker started');
    //   worker.port.start();
    //   const { mount } = Comlink.wrap<FsMountOptions>(worker.port);
    //   const { fs } = await mount({ fsBuffer: new ArrayBuffer(0x100000) });
    //   // window.fs = await fs;
    //   await fs.writeFile('/example.ts', 'console.log("Hello, world!")');
    //   return await fs.readFile('/example.ts', { encoding: 'utf-8' });
    // }, workerUrl);

    // const fileContent = await page.evaluate(async (proxy) => {
    //   return proxy.readFile('/some/path', 'utf-8');
    // }, fsProxy);

    // expect(fileContent).toBe('expected content');
  });

});
