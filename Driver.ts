import { Duplex } from 'stream';

// ============================================================
// Types
// ============================================================

export interface PendingCommand<TResponse = unknown> {
    resolve: (value: TResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Returned by extractPacket(): the extracted raw packet and how many bytes to consume */
export interface ExtractResult {
    /** Raw packet bytes (not yet parsed) */
    packet: Buffer;
    /** Total bytes to consume from receiveBuffer (garbage bytes skipped + packet length) */
    consumed: number;
}

// ============================================================
// Constants
// ============================================================

export const DEFAULT_TIMEOUT = 5000;

// ============================================================
// Driver — generic abstract base class
// ============================================================

/**
 * Abstract base for device drivers that communicate over a Duplex stream
 * (TCP socket, serial port, etc.) using a request/response protocol.
 *
 * @typeParam TArgs  — tuple type describing `buildCommandPacket` parameters.
 *                     `sendCommand` inherits the same signature automatically.
 * @typeParam TResponse — the parsed response type returned by `sendCommand`.
 *
 * Subclasses implement three protocol-specific methods:
 *   - `buildCommandPacket`  — serialise a command into a wire-format Buffer
 *   - `extractPacket`       — find & extract one complete packet from the
 *                              receive buffer (may clear garbage)
 *   - `parseResponsePacket` — deserialise a raw packet into a typed response
 *
 * The base class owns the whole send / receive pipeline:
 *   sendCommand → buildCommandPacket → setTimeout → pending → write
 *   onData → concat → extractPacket → parseResponsePacket → handleResponse → clearTimeout → resolve
 *
 * @example
 * ```typescript
 * class MyDevice extends Driver<[cmd: number, payload?: Buffer], MyResp> {
 *     protected buildCommandPacket(cmd: number, payload?: Buffer): Buffer { ... }
 *     // sendCommand(cmd, payload?) is now fully typed — no casting needed
 * }
 * ```
 */
export abstract class Driver<TArgs extends unknown[] = unknown[], TResponse = unknown> {
    // ---- State ----

    protected stream: Duplex | null = null;
    protected receiveBuffer: Buffer = Buffer.alloc(0);
    protected pending: PendingCommand<TResponse> | null = null;
    protected timeout: number;

    // Cached listener references so we can remove them on detach
    private _onData: ((chunk: Buffer) => void) | null = null;
    private _onClose: (() => void) | null = null;
    private _onError: ((err: Error) => void) | null = null;

    // ---- Constructor ----

    /**
     * @param stream   Optional already-connected Duplex.  If omitted the
     *                 subclass manages connection externally and calls
     *                 `attachStream` when ready.
     * @param timeout  Command timeout in ms (default 5000)
     */
    constructor(stream?: Duplex, timeout: number = DEFAULT_TIMEOUT) {
        this.timeout = timeout;
        if (stream) {
            this.attachStream(stream);
        }
    }

    // ============================================================
    // Stream lifecycle (protected — subclass calls when appropriate)
    // ============================================================

    /**
     * Attach the driver to a connected Duplex stream.
     * Clears any previous connection and receive buffer.
     */
    protected attachStream(stream: Duplex): void {
        this.detachStream();
        this.receiveBuffer = Buffer.alloc(0);

        this._onData = (chunk: Buffer) => this._onStreamData(chunk);
        this._onClose = () => this._onStreamClose();
        this._onError = (err: Error) => this._onStreamError(err);

        stream.on('data', this._onData);
        stream.on('close', this._onClose);
        stream.on('error', this._onError);

        this.stream = stream;
    }

    /**
     * Detach from the current stream: remove listeners, reject any pending
     * command, and (if still open) destroy the stream.
     */
    protected detachStream(): void {
        // Reject pending before touching the stream so any synchronous
        // side-effects from destroy() don't race with our cleanup.
        this._rejectPending(new Error('Disconnected'));

        if (this.stream) {
            const s = this.stream;
            this.stream = null;

            if (this._onData) s.removeListener('data', this._onData);
            if (this._onClose) s.removeListener('close', this._onClose);
            if (this._onError) s.removeListener('error', this._onError);

            if (!s.destroyed) {
                s.destroy();
            }
        }
    }

    // ============================================================
    // Abstract methods — implement per protocol
    // ============================================================

    /**
     * Build a wire-format command packet from command arguments.
     * Called by `sendCommand` — both share the same parameter types via `TArgs`.
     */
    protected abstract buildCommandPacket(...args: TArgs): Buffer;

    /**
     * Parse a raw response packet into a typed response object.
     * Throw on parse / CRC / integrity failure — the base class will skip the
     * offending byte and try to re-sync.
     */
    protected abstract parseResponsePacket(packet: Buffer): TResponse;

    /**
     * Try to extract one complete packet from the front of receiveBuffer.
     *
     * Must NOT consume bytes from receiveBuffer itself — instead return the
     * packet and a `consumed` count.  The base class advances the buffer.
     *
     * Return null when:
     *   - the buffer is too small to contain a complete packet (wait for more data)
     *   - no valid start marker was found **and the buffer was cleared** (set
     *     `this.receiveBuffer = Buffer.alloc(0)`) to avoid an infinite loop
     *
     * @returns `ExtractResult` with the raw packet and bytes-to-consume, or null
     */
    protected abstract extractPacket(): ExtractResult | null;

    // ============================================================
    // Core pipeline — send a command and wait for the response
    // ============================================================

    /**
     * Send a command and wait for a matching response.
     *
     * Calls `buildCommandPacket(...args)` to serialise, then writes the packet,
     * starts a timeout timer, and returns a Promise that resolves when
     * `handleResponse` fires or rejects on timeout / write error.
     *
     * Only one command may be in-flight at a time.
     */
    protected sendCommand(...args: TArgs): Promise<TResponse> {
        return new Promise((resolve, reject) => {
            if (!this.stream || this.stream.destroyed) {
                return reject(new Error('Not connected'));
            }
            if (this.pending) {
                return reject(new Error('Command already in progress'));
            }

            const packet = this.buildCommandPacket(...args);

            const timer = setTimeout(() => {
                this.pending = null;
                reject(new Error(`Command timeout (${this.timeout}ms)`));
            }, this.timeout);

            this.pending = { resolve, reject, timer };

            this.stream.write(packet, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending = null;
                    reject(err);
                }
            });
        });
    }

    // ============================================================
    // Receive pipeline
    // ============================================================

    /** Called on each 'data' event — appends chunk and attempts extraction */
    private _onStreamData(chunk: Buffer): void {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this._tryExtractLoop();
    }

    /**
     * Core extraction loop.
     *
     *   1. extractPacket() — find & carve out one raw packet
     *   2. parseResponsePacket() — deserialise
     *   3. handleResponse() — deliver to the pending promise
     *
     * On parse failure the offending header byte is skipped (not the whole
     * packet) so the loop can re-sync on the next valid marker.
     */
    private _tryExtractLoop(): void {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const result = this.extractPacket();
            if (!result) break; // need more data (or garbage was cleared)

            const { packet, consumed } = result;
            try {
                const response = this.parseResponsePacket(packet);
                // Success — consume the bytes we were told to
                this.receiveBuffer = this.receiveBuffer.subarray(consumed);
                this.handleResponse(response);
            } catch (err: unknown) {
                // Bad packet — skip ONE byte (the false header) and retry.
                // We do NOT consume `consumed` bytes because the rest of the
                // "packet" may contain valid data once we re-sync.
                this.receiveBuffer = this.receiveBuffer.subarray(1);
                if (this.pending) {
                    this._rejectPending(err as Error);
                }
            }
        }
    }

    /**
     * Deliver a parsed response to the pending command (if any).
     * Override in subclass to additionally handle unsolicited / async messages.
     */
    protected handleResponse(response: TResponse): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            const p = this.pending;
            this.pending = null;
            p.resolve(response);
        }
    }

    // ---- Stream event handlers ----

    private _onStreamClose(): void {
        this._rejectPending(new Error('Connection closed'));
        this.stream = null;
    }

    private _onStreamError(err: Error): void {
        this._rejectPending(err);
    }

    private _rejectPending(err: Error): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            const p = this.pending;
            this.pending = null;
            p.reject(err);
        }
    }

    // ============================================================
    // Public helpers
    // ============================================================

    /** Whether the underlying stream is connected and not destroyed */
    isConnected(): boolean {
        return this.stream !== null && !this.stream.destroyed;
    }

    /** Disconnect from the device (detach + destroy stream) */
    disconnect(): void {
        this.detachStream();
    }

    /**
     * Raw send — write arbitrary data without waiting for a response.
     * Useful for fire-and-forget commands or debugging.
     */
    send(data: Buffer | number[]): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.stream || this.stream.destroyed) {
                return reject(new Error('Not connected'));
            }
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.stream.write(buf, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

export default Driver;
