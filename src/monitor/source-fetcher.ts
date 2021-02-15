import { CheckedContract } from "@ethereum-sourcify/core";
import Logger from "bunyan";
import { StatusCodes } from "http-status-codes";
import nodeFetch from 'node-fetch';
import { IGateway, SimpleGateway } from "./gateway";
import PendingContract from "./pending-contract";
import { SourceAddress, FetchedFileCallback } from "./util";

const STARTING_INDEX = 0;
const NO_PAUSE = 0;

class Subscription {
    sourceAddress: SourceAddress;
    fetchUrl: string;
    beingProcessed = false;
    subscribers: Array<FetchedFileCallback> = [];

    constructor(sourceAddress: SourceAddress, fetchUrl: string) {
        this.sourceAddress = sourceAddress;
        this.fetchUrl = fetchUrl;
    }
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
    private fileCounter = 0;
    private subscriptionCounter = 0;

    private fetchTimeout: number; // when to terminate a request
    private fetchPause: number; // how much time to wait between two requests
    private cleanupTime: number;

    private gateways: IGateway[] = [
        new SimpleGateway("ipfs", process.env.IPFS_URL || "https://ipfs.infura.io:5001/api/v0/cat?arg="),
        new SimpleGateway(["bzzr0", "bzzr1"], "https://swarm-gateways.net/bzz-raw:/"),
        // new SimpleGateway(["bzzr0", "bzzr1"], "https://gateway.ethswarm.org/bzz/") probably does not work
    ];

    constructor() {
        this.fetchTimeout = parseInt(process.env.MONITOR_FETCH_TIMEOUT) || (5 * 60 * 1000);
        this.fetchPause = parseInt(process.env.MONITOR_FETCH_PAUSE) || (1 * 1000);
        this.cleanupTime = parseInt(process.env.MONITOR_CLEANUP_PERIOD) || (30 * 60 * 1000);
        this.fetch([], 0);
    }

    private fetch = (sourceHashes: string[], index: number): void => {
        if (index >= sourceHashes.length) {
            const newSourceHashes = Object.keys(this.subscriptions);
            setTimeout(this.fetch, NO_PAUSE, newSourceHashes, STARTING_INDEX);
            return;
        }

        const sourceHash = sourceHashes[index];
        const subscription = this.subscriptions[sourceHash];
        let nextFast = false;

        if (!(sourceHash in this.subscriptions) || subscription.beingProcessed) {
            nextFast = true;
        
        } else if (this.shouldCleanup(sourceHash)) {
            this.cleanup(sourceHash);
            nextFast = true;
        }

        if (nextFast) {
            setTimeout(this.fetch, NO_PAUSE, sourceHashes, index + 1);
            return;
        }

        subscription.beingProcessed = true;
        const fetchUrl = subscription.fetchUrl;
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
        )).finally(() => {
            subscription.beingProcessed = false;
        });

        setTimeout(this.fetch, this.fetchPause, sourceHashes, index + 1);
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
        const gateway = this.findGateway(sourceAddress);
        const fetchUrl = gateway.createUrl(sourceAddress.id);
        
        if (!(sourceHash in this.subscriptions)) {
            this.subscriptions[sourceHash] = new Subscription(sourceAddress, fetchUrl);
            this.fileCounter++;
        }
        
        this.timestamps[sourceHash] = new Date();
        this.subscriptions[sourceHash].subscribers.push(callback);

        this.subscriptionCounter++;
        this.logger.info({ loc: "[SOURCE_FETCHER:NEW_SUBSCRIPTION]", filesPending: this.fileCounter, subscriptions: this.subscriptionCounter });
    }

    private cleanup(sourceHash: string) {
        delete this.timestamps[sourceHash];
        const subscribers = Object.keys(this.subscriptions[sourceHash].subscribers);
        const subscriptionsDelta = subscribers.length;
        delete this.subscriptions[sourceHash];

        this.fileCounter--;
        this.subscriptionCounter -= subscriptionsDelta;
        this.logger.info({ loc: "[SOURCE_FETCHER:CLEANUP]", sourceHash, filesPending: this.fileCounter, subscriptions: this.subscriptionCounter });
    }

    private shouldCleanup(sourceHash: string) {
        const timestamp = this.timestamps[sourceHash];
        return timestamp && (timestamp.getTime() + this.cleanupTime < Date.now());
    }

    assemble(metadataAddress: SourceAddress, callback: (contract: CheckedContract) => void) {
        const contract = new PendingContract(this, callback);
        contract.assemble(metadataAddress);
    }
}