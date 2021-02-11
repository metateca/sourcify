import Logger from "bunyan";
import { StatusCodes } from "http-status-codes";
import nodeFetch from 'node-fetch';
import { IGateway, SimpleGateway } from "./gateway";
import { SourceAddress, FetchedFileCallback } from "./util";

const STARTING_INDEX = 0;

type Subscription = {
    sourceAddress: SourceAddress;
    subscribers: Array<FetchedFileCallback>;
}

declare interface SubscriptionMap {
    [hash: string]: Subscription
}

declare interface TimestampMap {
    [hash: string]: Date
}

export default class SourceFetcher {
    private subscriptions: SubscriptionMap = {};
    private timestamps: TimestampMap = {};
    private logger = new Logger({ name: "SourceFetcher" });

    private fetchTimeout: number; // when to terminate a request
    private fetchPause: number; // how much time to wait between to requests
    private cleanupTime: number;

    private gateways: IGateway[] = [
        new SimpleGateway("ipfs", process.env.IPFS_URL || "https://ipfs.infura.io:5001/api/v0/cat?arg="),
        new SimpleGateway(["bzzr0", "bzzr1"], "https://swarm-gateways.net/bzz-raw:/"),
        new SimpleGateway(["bzzr0", "bzzr1"], "https://gateway.ethswarm.org/bzz/")
    ];

    constructor() {
        this.fetchTimeout = parseInt(process.env.MONITOR_FETCH_TIMEOUT) || (5 * 60 * 1000);
        this.fetchPause = parseInt(process.env.MONITOR_FETCH_PAUSE) || (1 * 1000);
        this.cleanupTime = parseInt(process.env.MONITOR_CLEANUP_PERIOD) || (30 * 60 * 1000);
        this.fetch([], 0);
    }

    private fetch = (sourceHashes: string[], index: number): void => {
        if (index >= sourceHashes.length) {
            this.logger.info({ loc: "[SOURCE_FETCHER]", filesPending: sourceHashes.length }, "New round of file fetching");
            const newSourceHashes = Object.keys(this.subscriptions);
            setTimeout(this.fetch, this.fetchPause, newSourceHashes, STARTING_INDEX);
            return;
        }

        const sourceHash = sourceHashes[index];
        if (!(index in this.subscriptions)) {
            return;
        }

        if (this.shouldCleanup(sourceHash)) {
            this.cleanup(sourceHash);
            setTimeout(this.fetch, this.fetchPause, sourceHashes, index + 1);
            return;
        }

        const subscription = this.subscriptions[sourceHash];
        const gateway = this.findGateway(subscription.sourceAddress);
        const fetchUrl = gateway.createUrl(subscription.sourceAddress.id);
        nodeFetch(fetchUrl, { timeout: this.fetchTimeout }).then(resp => {
            resp.text().then(text => {
                if (resp.status === StatusCodes.OK) {
                    this.notifySubscribers(sourceHash, text);

                } else {
                    this.logger.error({
                        loc: "[SOURCE_FETCHER:FETCH_FAILED]",
                        status: resp.status,
                        statusText: resp.statusText,
                        sourceHash
                    }, text);
                }
            });

        }).catch(err => this.logger.error(
            { loc: "[SOURCE_FETCHER]", fetchUrl }, err.message
        ));

        setTimeout(this.fetch, this.fetchPause, sourceHashes, index+1);
    }

    private findGateway(sourceAddress: SourceAddress) {
        for (const gateway of this.gateways) {
            if (gateway.worksWith(sourceAddress.origin)) {
                return gateway;
            }
        }

        throw new Error(`Gateway not found for ${sourceAddress.origin}`);
    }

    private notifySubscribers(id: string, file: string) {
        if (!(id in this.subscriptions)) {
            return;
        }

        const subscription = this.subscriptions[id];
        this.cleanup(id);

        this.logger.info({
            loc: "[SOURCE_FETCHER:NOTIFY]",
            id,
            subscribers: subscription.subscribers.length
        }, "Fetching successful");

        subscription.subscribers.forEach(callback => callback(file));
    }

    subscribe(sourceAddress: SourceAddress, callback: FetchedFileCallback): void {
        const sourceHash = sourceAddress.getUniqueIdentifier();
        if (!(sourceHash in this.subscriptions)) {
            this.subscriptions[sourceHash] = { sourceAddress, subscribers: [] };
        }

        this.timestamps[sourceHash] = new Date();
        this.subscriptions[sourceHash].subscribers.push(callback);
    }

    private cleanup(sourceHash: string) {
        this.logger.info({ loc: "[SOURCE_FETCHER:CLEANUP]", sourceHash });
        delete this.timestamps[sourceHash];
        delete this.subscriptions[sourceHash];
    }

    private shouldCleanup(sourceHash: string) {
        const timestamp = this.timestamps[sourceHash];
        return timestamp && (timestamp.getTime() + this.cleanupTime < Date.now());
    }
}