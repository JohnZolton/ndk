import type { NDKRelay, NDKRelayConnectionStats } from ".";
import { NDKRelayStatus } from ".";
import { NDKEvent } from "../events/index.js";
import type { NDK } from "../ndk/index.js";
import type { NostrEvent } from "../events/index.js";
import type { NDKFilter } from "../subscription";
import { NDKKind } from "../events/kinds";
import { NDKRelaySubscription, type SubscriptionParams } from "./subscriptions";
import { matchFilters } from "nostr-tools";

const MAX_RECONNECT_ATTEMPTS = 5;

export type CountResolver = {
    resolve: (count: number) => void;
    reject: (err: Error) => void;
};

export type EventPublishResolver = {
    resolve: (reason: string) => void;
    reject: (err: Error) => void;
};

export class NDKRelayConnectivity {
    private ndkRelay: NDKRelay;
    private ws?: WebSocket;
    private _status: NDKRelayStatus;
    private timeoutMs?: number;
    private connectedAt?: number;
    private _connectionStats: NDKRelayConnectionStats = {
        attempts: 0,
        success: 0,
        durations: [],
    };
    private debug: debug.Debugger;
    private connectTimeout: ReturnType<typeof setTimeout> | undefined;
    private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    private ndk?: NDK;
    public openSubs: Map<string, NDKRelaySubscription> = new Map();
    private openCountRequests = new Map<string, CountResolver>();
    private openEventPublishes = new Map<string, EventPublishResolver>();
    private serial: number = 0;
    public baseEoseTimeout: number = 4_400;

    constructor(ndkRelay: NDKRelay, ndk?: NDK) {
        this.ndkRelay = ndkRelay;
        this._status = NDKRelayStatus.DISCONNECTED;
        this.debug = this.ndkRelay.debug.extend("connectivity");
        this.ndk = ndk;
    }

    /**
     * Connects to the NDK relay and handles the connection lifecycle.
     *
     * This method attempts to establish a WebSocket connection to the NDK relay specified in the `ndkRelay` object.
     * If the connection is successful, it updates the connection statistics, sets the connection status to `CONNECTED`,
     * and emits `connect` and `ready` events on the `ndkRelay` object.
     *
     * If the connection attempt fails, it handles the error by either initiating a reconnection attempt or emitting a
     * `delayed-connect` event on the `ndkRelay` object, depending on the `reconnect` parameter.
     *
     * @param timeoutMs - The timeout in milliseconds for the connection attempt. If not provided, the default timeout from the `ndkRelay` object is used.
     * @param reconnect - Indicates whether a reconnection should be attempted if the connection fails. Defaults to `true`.
     * @returns A Promise that resolves when the connection is established, or rejects if the connection fails.
     */
    public async connect(timeoutMs?: number, reconnect = true): Promise<void> {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }

        timeoutMs ??= this.timeoutMs;
        if (!this.timeoutMs && timeoutMs) this.timeoutMs = timeoutMs;

        this.connectTimeout = setTimeout(() => this.onConnectionError(reconnect), this.timeoutMs);

        try {
            this.updateConnectionStats.attempt();
            if (this._status === NDKRelayStatus.DISCONNECTED)
                this._status = NDKRelayStatus.CONNECTING;
            else this._status = NDKRelayStatus.RECONNECTING;

            this.debug(`Connecting to ${this.ndkRelay.url}`);
            this.ws = new WebSocket(this.ndkRelay.url);
            this.ws.onopen = () => this.onConnect();
            this.ws.onclose = () => this.onDisconnect();
            this.ws.onmessage = (event: MessageEvent) => this.onMessage(event);
            this.ws.onerror = (error) => this.onError(error);
        } catch (e) {
            this.debug(`Failed to connect to ${this.ndkRelay.url}`, e);
            this._status = NDKRelayStatus.DISCONNECTED;
            if (reconnect) this.handleReconnection();
            else this.ndkRelay.emit("delayed-connect", 2 * 24 * 60 * 60 * 1000);
            throw e;
        }
    }

    /**
     * Disconnects the WebSocket connection to the NDK relay.
     * This method sets the connection status to `NDKRelayStatus.DISCONNECTING`,
     * attempts to close the WebSocket connection, and sets the status to
     * `NDKRelayStatus.DISCONNECTED` if the disconnect operation fails.
     */
    public disconnect(): void {
        this._status = NDKRelayStatus.DISCONNECTING;
        try {
            this.ws?.close();
        } catch (e) {
            this.debug("Failed to disconnect", e);
            this._status = NDKRelayStatus.DISCONNECTED;
        }
    }

    /**
     * Handles the error that occurred when attempting to connect to the NDK relay.
     * If `reconnect` is `true`, this method will initiate a reconnection attempt.
     * Otherwise, it will emit a `delayed-connect` event on the `ndkRelay` object,
     * indicating that a reconnection should be attempted after a delay.
     *
     * @param reconnect - Indicates whether a reconnection should be attempted.
     */
    onConnectionError(reconnect: boolean): void {
        this.debug(`Error connecting to ${this.ndkRelay.url}`);
        if (reconnect) {
            this.handleReconnection();
        }
    }

    /**
     * Handles the connection event when the WebSocket connection is established.
     * This method is called when the WebSocket connection is successfully opened.
     * It clears any existing connection and reconnection timeouts, updates the connection statistics,
     * sets the connection status to `CONNECTED`, and emits `connect` and `ready` events on the `ndkRelay` object.
     */
    private onConnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }
        this.updateConnectionStats.connected();
        this._status = NDKRelayStatus.CONNECTED;
        this.debug(`Connected to ${this.ndkRelay.url}`);
        this.ndkRelay.emit("connect");
        this.ndkRelay.emit("ready");
    }

    /**
     * Handles the disconnection event when the WebSocket connection is closed.
     * This method is called when the WebSocket connection is successfully closed.
     * It updates the connection statistics, sets the connection status to `DISCONNECTED`,
     * initiates a reconnection attempt if we didn't disconnect ourselves,
     * and emits a `disconnect` event on the `ndkRelay` object.
     */
    private onDisconnect() {
        this.updateConnectionStats.disconnected();

        if (this._status === NDKRelayStatus.CONNECTED) {
            this._status = NDKRelayStatus.DISCONNECTED;

            this.handleReconnection();
        }
        this.debug(`Disconnected from ${this.ndkRelay.url}`);
        this.ndkRelay.emit("disconnect");
    }

    /**
     * Handles incoming messages from the NDK relay WebSocket connection.
     * This method is called whenever a message is received from the relay.
     * It parses the message data and dispatches the appropriate handling logic based on the message type.
     *
     * @param event - The MessageEvent containing the received message data.
     */
    private onMessage(event: MessageEvent): void {
        this.debug(`Message received from ${this.ndkRelay.url}: ${event}`);
        try {
            const data = JSON.parse(event.data);
            this.debug(`Parsed message from ${this.ndkRelay.url}:`, data);

            switch (data[0]) {
                case "EVENT": {
                    const so = this.openSubs.get(data[1] as string) as NDKRelaySubscription;
                    const event = data[2] as Event;
                    if (matchFilters(so.filters, event as any)) {
                        so.onevent(event);
                    }
                    return;
                }
                case "COUNT": {
                    const id: string = data[1];
                    const payload = data[2] as { count: number };
                    const cr = this.openCountRequests.get(id) as CountResolver;
                    if (cr) {
                        cr.resolve(payload.count);
                        this.openCountRequests.delete(id);
                    }
                    return;
                }
                case "EOSE": {
                    const so = this.openSubs.get(data[1] as string);
                    if (!so) return;
                    so.receivedEose();
                    return;
                }
                case "OK": {
                    const id: string = data[1];
                    const ok: boolean = data[2];
                    const reason: string = data[3];
                    const ep = this.openEventPublishes.get(id) as EventPublishResolver;
                    if (ok) ep.resolve(reason);
                    else ep.reject(new Error(reason));
                    this.openEventPublishes.delete(id);
                    return;
                }
                case "CLOSED": {
                    const id: string = data[1];
                    const so = this.openSubs.get(id);
                    if (!so) return;
                    so.closed = true;
                    so.close(data[2] as string);
                    return;
                }
                case "NOTICE":
                    this.onNotice(data[1] as string);
                    return;
                case "AUTH": {
                    this.onAuthRequested(data[1] as string);
                    return;
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
            this.debug(`Error parsing message from ${this.ndkRelay.url}: ${error.message}`);
            return;
        }
    }

    /**
     * Handles an authentication request from the NDK relay.
     *
     * If an authentication policy is configured, it will be used to authenticate the connection.
     * Otherwise, the `auth` event will be emitted to allow the application to handle the authentication.
     *
     * @param challenge - The authentication challenge provided by the NDK relay.
     */
    private async onAuthRequested(challenge: string) {
        const authPolicy = this.ndkRelay.authPolicy ?? this.ndk?.relayAuthDefaultPolicy;

        this.debug("Relay requested authentication", {
            havePolicy: !!authPolicy,
        });

        if (authPolicy) {
            if (this._status !== NDKRelayStatus.AUTHENTICATING) {
                this._status = NDKRelayStatus.AUTHENTICATING;
                const res = await authPolicy(this.ndkRelay, challenge);
                this.debug("Authentication policy returned", !!res);

                if (res instanceof NDKEvent || res === true) {
                    if (res instanceof NDKEvent) {
                        await this.auth(res);
                    }

                    if (res === true) {
                        if (!this.ndk?.signer) {
                            throw new Error("No signer available for authentication");
                        } else if (this._status === NDKRelayStatus.AUTHENTICATING) {
                            this.debug("Authentication policy finished");
                            const event = new NDKEvent(this.ndk);
                            event.kind = NDKKind.ClientAuth;
                            event.tags = [
                                ["relay", this.ndkRelay.url],
                                ["challenge", challenge],
                            ];
                            await event.sign();
                            await this.auth(event);
                        }
                    }

                    this._status = NDKRelayStatus.CONNECTED;
                    this.ndkRelay.emit("authed");
                }
            }
        } else {
            this.ndkRelay.emit("auth", challenge);
        }
    }

    /**
     * Handles errors that occur on the WebSocket connection to the NDK relay.
     * @param error - The error or event that occurred.
     */
    private onError(error: Error | Event): void {
        this.debug(`WebSocket error on ${this.ndkRelay.url}:`, error);
    }

    /**
     * Gets the current status of the NDK relay connection.
     * @returns {NDKRelayStatus} The current status of the NDK relay connection.
     */
    get status(): NDKRelayStatus {
        return this._status;
    }

    /**
     * Checks if the NDK relay connection is currently available.
     * @returns {boolean} `true` if the relay connection is in the `CONNECTED` status, `false` otherwise.
     */
    public isAvailable(): boolean {
        return this._status === NDKRelayStatus.CONNECTED;
    }

    /**
     * Checks if the NDK relay connection is flapping, which means the connection is rapidly
     * disconnecting and reconnecting. This is determined by analyzing the durations of the
     * last three connection attempts. If the standard deviation of the durations is less
     * than 1000 milliseconds, the connection is considered to be flapping.
     *
     * @returns {boolean} `true` if the connection is flapping, `false` otherwise.
     */
    private isFlapping(): boolean {
        const durations = this._connectionStats.durations;
        if (durations.length % 3 !== 0) return false;

        const sum = durations.reduce((a, b) => a + b, 0);
        const avg = sum / durations.length;
        const variance =
            durations.map((x) => Math.pow(x - avg, 2)).reduce((a, b) => a + b, 0) /
            durations.length;
        const stdDev = Math.sqrt(variance);
        const isFlapping = stdDev < 1000;

        return isFlapping;
    }

    /**
     * Handles a notice received from the NDK relay.
     * If the notice indicates the relay is complaining (e.g. "too many" or "maximum"),
     * the method disconnects from the relay and attempts to reconnect after a 2-second delay.
     * A debug message is logged with the relay URL and the notice text.
     * The "notice" event is emitted on the ndkRelay instance with the notice text.
     *
     * @param notice - The notice text received from the NDK relay.
     */
    private async onNotice(notice: string) {
        // This is a prototype; if the relay seems to be complaining
        // remove it from relay set selection for a minute.
        if (notice.includes("oo many") || notice.includes("aximum")) {
            this.disconnect();

            // fixme
            setTimeout(() => this.connect(), 2000);
            this.debug(this.ndkRelay.url, "Relay complaining?", notice);
            // this.complaining = true;
            // setTimeout(() => {
            //     this.complaining = false;
            //     console.log(this.relay.url, 'Reactivate relay');
            // }, 60000);
        }

        this.ndkRelay.emit("notice", notice);
    }

    /**
     * Attempts to reconnect to the NDK relay after a connection is lost.
     * This function is called recursively to handle multiple reconnection attempts.
     * It checks if the relay is flapping and emits a "flapping" event if so.
     * It then calculates a delay before the next reconnection attempt based on the number of previous attempts.
     * The function sets a timeout to execute the next reconnection attempt after the calculated delay.
     * If the maximum number of reconnection attempts is reached, a debug message is logged.
     *
     * @param attempt - The current attempt number (default is 0).
     */
    private handleReconnection(attempt = 0): void {
        if (this.reconnectTimeout) return;
        this.debug("Attempting to reconnect", { attempt });

        if (this.isFlapping()) {
            this.ndkRelay.emit("flapping", this._connectionStats);
            this._status = NDKRelayStatus.FLAPPING;
            return;
        }

        const reconnectDelay = this.connectedAt
            ? Math.max(0, 60000 - (Date.now() - this.connectedAt))
            : 5000 * (this._connectionStats.attempts + 1);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this._status = NDKRelayStatus.RECONNECTING;
            // this.debug(`Reconnection attempt #${attempt}`);
            this.connect()
                .then(() => {
                    this.debug("Reconnected");
                })
                .catch((err) => {
                    // this.debug("Reconnect failed", err);

                    if (attempt < MAX_RECONNECT_ATTEMPTS) {
                        setTimeout(
                            () => {
                                this.handleReconnection(attempt + 1);
                            },
                            (1000 * (attempt + 1)) ^ 4
                        );
                    } else {
                        this.debug("Reconnect failed");
                    }
                });
        }, reconnectDelay);

        this.ndkRelay.emit("delayed-connect", reconnectDelay);

        this.debug("Reconnecting in", reconnectDelay);
        this._connectionStats.nextReconnectAt = Date.now() + reconnectDelay;
    }

    /**
     * Sends a message to the NDK relay if the connection is in the CONNECTED state and the WebSocket is open.
     * If the connection is not in the CONNECTED state or the WebSocket is not open, logs a debug message and throws an error.
     *
     * @param message - The message to send to the NDK relay.
     * @throws {Error} If attempting to send on a closed relay connection.
     */
    public async send(message: string) {
        if (this._status === NDKRelayStatus.CONNECTED && this.ws?.readyState === WebSocket.OPEN) {
            this.ws?.send(message);
        } else {
            this.debug(`Not connected to ${this.ndkRelay.url}, not sending message ${message}`);
            throw new Error("Attempting to send on a closed relay connection");
        }
    }

    /**
     * Authenticates the NDK event by sending it to the NDK relay and returning a promise that resolves with the result.
     *
     * @param event - The NDK event to authenticate.
     * @returns A promise that resolves with the authentication result.
     */
    private async auth(event: NDKEvent): Promise<string> {
        const ret = new Promise<string>((resolve, reject) => {
            this.openEventPublishes.set(event.id, { resolve, reject });
        });
        this.send('["AUTH",' + JSON.stringify(event) + "]");
        return ret;
    }

    /**
     * Publishes an NDK event to the relay and returns a promise that resolves with the result.
     *
     * @param event - The NDK event to publish.
     * @returns A promise that resolves with the result of the event publication.
     * @throws {Error} If attempting to publish on a closed relay connection.
     */
    public async publish(event: NostrEvent): Promise<string> {
        const ret = new Promise<string>((resolve, reject) => {
            this.openEventPublishes.set(event.id!, { resolve, reject });
        });
        this.send('["EVENT",' + JSON.stringify(event) + "]");
        return ret;
    }

    /**
     * Counts the number of events that match the provided filters.
     *
     * @param filters - The filters to apply to the count request.
     * @param params - An optional object containing a custom id for the count request.
     * @returns A promise that resolves with the number of matching events.
     * @throws {Error} If attempting to send the count request on a closed relay connection.
     */
    public async count(filters: NDKFilter[], params: { id?: string | null }): Promise<number> {
        this.serial++;
        const id = params?.id || "count:" + this.serial;
        const ret = new Promise<number>((resolve, reject) => {
            this.openCountRequests.set(id, { resolve, reject });
        });
        this.send('["COUNT","' + id + '",' + JSON.stringify(filters).substring(1));
        return ret;
    }

    /**
     * Subscribes to the NDK relay with the provided filters and parameters.
     *
     * @param filters - The filters to apply to the subscription.
     * @param params - The subscription parameters, including an optional custom id.
     * @returns A new NDKRelaySubscription instance.
     */
    public subscribe(
        filters: NDKFilter[],
        params: Partial<SubscriptionParams>
    ): NDKRelaySubscription {
        const subscription = this.prepareSubscription(filters, params);
        subscription.fire();
        return subscription;
    }

    /**
     * Prepares a new subscription to the NDK relay.
     *
     * @param filters - The filters to apply to the subscription.
     * @param params - The subscription parameters, including an optional custom id.
     * @returns A new NDKRelaySubscription instance.
     */
    public prepareSubscription(
        filters: NDKFilter[],
        params: Partial<SubscriptionParams> & { id?: string }
    ): NDKRelaySubscription {
        this.serial++;
        const id = params.id || "sub:" + this.serial;
        const subscription = new NDKRelaySubscription(this, id, filters, params);
        this.openSubs.set(id, subscription);
        return subscription;
    }

    /**
     * Utility functions to update the connection stats.
     */
    private updateConnectionStats = {
        connected: () => {
            this._connectionStats.success++;
            this._connectionStats.connectedAt = Date.now();
        },

        disconnected: () => {
            if (this._connectionStats.connectedAt) {
                this._connectionStats.durations.push(
                    Date.now() - this._connectionStats.connectedAt
                );

                if (this._connectionStats.durations.length > 100) {
                    this._connectionStats.durations.shift();
                }
            }
            this._connectionStats.connectedAt = undefined;
        },

        attempt: () => {
            this._connectionStats.attempts++;
        },
    };

    /** Returns the connection stats. */
    get connectionStats(): NDKRelayConnectionStats {
        return this._connectionStats;
    }

    /** Returns the relay URL */
    get url(): WebSocket["url"] {
        return this.ndkRelay.url;
    }
}
