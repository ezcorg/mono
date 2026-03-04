import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import { getNotifications } from "@open-rpc/client-js/src/Request";
import type { JSONRPCRequestData, IJSONRPCData } from "@open-rpc/client-js/src/Request";

export default class MessagePortTransport extends Transport {
    public postMessageID: string;

    constructor(public port: MessagePort) {
        super();
        this.postMessageID = `post-message-transport-${Math.random()}`;
    }

    private messageHandler = (ev: MessageEvent) => {
        this.transportRequestManager.resolveResponse(JSON.stringify(ev.data));
    };

    public connect(): Promise<void> {
        return new Promise(async (resolve) => {
            this.port.addEventListener("message", this.messageHandler);
            resolve();
        });
    }

    public async sendData(data: JSONRPCRequestData): Promise<any> {
        const prom = this.transportRequestManager.addRequest(data, null);
        const notifications = getNotifications(data);
        if (this.port) {
            this.port.postMessage((data as IJSONRPCData).request);
            this.transportRequestManager.settlePendingRequest(notifications);
        }
        return prom;
    }

    public close(): void { }
}