import EventEmitter from "eventemitter3";
import type { NostrEvent } from "../../events/index.js";
import type { NDK } from "../../ndk/index.js";
import { NDKUser } from "../../user/index.js";
import type { NDKSigner } from "../index.js";
import { NDKPrivateKeySigner } from "../private-key/index.js";
import type { NDKRpcResponse } from "./rpc.js";
import { NDKNostrRpc } from "./rpc.js";

/**
 * This NDKSigner implements NIP-46, which allows remote signing of events.
 * This class is meant to be used client-side, paired with the NDKNip46Backend or a NIP-46 backend (like Nostr-Connect)
 *
 * @emits authUrl -- Emitted when the user should take an action in certain URL.
 *                   When a client receives this event, it should direct the user
 *                   to go to that URL to authorize the application.
 */
export class NDKNip46Signer extends EventEmitter implements NDKSigner {
    private ndk: NDK;
    public remoteUser: NDKUser;
    public remotePubkey: string | undefined;
    public token: string | undefined;
    public localSigner: NDKSigner;
    private nip05?: string;
    private rpc: NDKNostrRpc;
    private debug: debug.Debugger;

    /**
     * @param ndk - The NDK instance to use
     * @param token - connection token, in the form "npub#otp"
     * @param localSigner - The signer that will be used to request events to be signed
     */
    public constructor(ndk: NDK, token: string, localSigner?: NDKSigner);

    /**
     * @param ndk - The NDK instance to use
     * @param remoteNpub - The npub that wants to be published as
     * @param localSigner - The signer that will be used to request events to be signed
     */
    public constructor(ndk: NDK, remoteNpub: string, localSigner?: NDKSigner);

    /**
     * @param ndk - The NDK instance to use
     * @param remoteNip05 - The nip05 that wants to be published as
     * @param localSigner - The signer that will be used to request events to be signed
     */
    public constructor(ndk: NDK, remoteNip05: string, localSigner?: NDKSigner);

    /**
     * @param ndk - The NDK instance to use
     * @param remotePubkey - The public key of the npub that wants to be published as
     * @param localSigner - The signer that will be used to request events to be signed
     */
    public constructor(ndk: NDK, remotePubkey: string, localSigner?: NDKSigner);

    /**
     * @param ndk - The NDK instance to use
     * @param tokenOrRemoteUser - The public key, or a connection token, of the npub that wants to be published as
     * @param localSigner - The signer that will be used to request events to be signed
     */
    public constructor(ndk: NDK, tokenOrRemoteUser: string, localSigner?: NDKSigner) {
        super();

        let remotePubkey: string | undefined;
        let token: string | undefined;

        if (tokenOrRemoteUser.includes("#")) {
            const parts = tokenOrRemoteUser.split("#");
            remotePubkey = new NDKUser({ npub: parts[0] }).pubkey;
            token = parts[1];
        } else if (tokenOrRemoteUser.startsWith("npub")) {
            remotePubkey = new NDKUser({
                npub: tokenOrRemoteUser,
            }).pubkey;
        } else if (tokenOrRemoteUser.match(/\./)) {
            this.nip05 = tokenOrRemoteUser;
        } else {
            remotePubkey = tokenOrRemoteUser;
        }

        this.ndk = ndk;
        if (remotePubkey) this.remotePubkey = remotePubkey;
        this.token = token;
        this.debug = ndk.debug.extend("nip46:signer");

        this.remoteUser = new NDKUser({ pubkey: remotePubkey });

        if (!localSigner) {
            this.localSigner = NDKPrivateKeySigner.generate();
        } else {
            this.localSigner = localSigner;
        }

        this.rpc = new NDKNostrRpc(ndk, this.localSigner, this.debug);
        this.rpc.on("authUrl", (...props) => this.emit("authUrl", ...props));
    }

    /**
     * Get the user that is being published as
     */
    public async user(): Promise<NDKUser> {
        return this.remoteUser;
    }

    public async blockUntilReady(): Promise<NDKUser> {
        const localUser = await this.localSigner.user();
        const remoteUser = this.ndk.getUser({ pubkey: this.remotePubkey });

        if (this.nip05 && !this.remotePubkey) {
            const remoteUser = NDKUser.fromNip05(this.nip05).then((user) => {
                if (user) {
                    this.remoteUser = user;
                    this.remotePubkey = user.pubkey;
                }
            });
        }

        if (!this.remotePubkey) {
            throw new Error("Remote pubkey not set");
        }

        // Generates subscription, single subscription for the lifetime of our connection
        await this.rpc.subscribe({
            kinds: [24133 as number],
            "#p": [localUser.pubkey],
        });

        return new Promise((resolve, reject) => {
            // There is a race condition between the subscription and sending the request;
            // introducing a small delay here to give a clear priority to the subscription
            // to happen first
            setTimeout(() => {
                const connectParams = [localUser.pubkey];

                if (this.token) {
                    connectParams.push(this.token);
                }

                this.rpc.sendRequest(
                    this.remotePubkey!,
                    "connect",
                    connectParams,
                    24133,
                    (response: NDKRpcResponse) => {
                        if (response.result === "ack") {
                            resolve(remoteUser);
                        } else {
                            reject(response.error);
                        }
                    }
                );
            }, 100);
        });
    }

    public async encrypt(recipient: NDKUser, value: string): Promise<string> {
        this.debug("asking for encryption");

        const promise = new Promise<string>((resolve, reject) => {
            this.rpc.sendRequest(
                this.remotePubkey!,
                "nip04_encrypt",
                [recipient.pubkey, value],
                24133,
                (response: NDKRpcResponse) => {
                    if (!response.error) {
                        resolve(response.result);
                    } else {
                        reject(response.error);
                    }
                }
            );
        });

        return promise;
    }

    public async decrypt(sender: NDKUser, value: string): Promise<string> {
        this.debug("asking for decryption");

        const promise = new Promise<string>((resolve, reject) => {
            this.rpc.sendRequest(
                this.remotePubkey!,
                "nip04_decrypt",
                [sender.pubkey, value],
                24133,
                (response: NDKRpcResponse) => {
                    if (!response.error) {
                        const value = JSON.parse(response.result);
                        resolve(value[0]);
                    } else {
                        reject(response.error);
                    }
                }
            );
        });

        return promise;
    }

    public async sign(event: NostrEvent): Promise<string> {
        this.debug("asking for a signature");

        const promise = new Promise<string>((resolve, reject) => {
            this.rpc.sendRequest(
                this.remotePubkey!,
                "sign_event",
                [JSON.stringify(event)],
                24133,
                (response: NDKRpcResponse) => {
                    this.debug("got a response", response);
                    if (!response.error) {
                        const json = JSON.parse(response.result);
                        resolve(json.sig);
                    } else {
                        reject(response.error);
                    }
                }
            );
        });

        return promise;
    }
}
