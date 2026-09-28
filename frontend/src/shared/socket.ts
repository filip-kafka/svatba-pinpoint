/**
 * WebSocket that keeps itself alive. Phones lock their screens, switch Wi-Fi
 * to mobile data, and drop connections all the time at events - reconnecting
 * quickly and quietly is the most important thing this file does.
 */

import type { ServerMessage } from "./types";

type Status = "connecting" | "open" | "closed";

export class LiveSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private pingTimer: number | undefined;
  private retryTimer: number | undefined;
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly handlers: {
      onMessage: (msg: ServerMessage) => void;
      onOpen?: () => void;
      onStatus?: (s: Status) => void;
      /** Return true to stop reconnecting (e.g. bad credentials). */
      onClose?: (ev: CloseEvent) => boolean | void;
    },
  ) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.isOpen()) this.reconnectNow();
    });
    window.addEventListener("online", () => this.reconnectNow());
    this.connect();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(payload: unknown): boolean {
    if (!this.isOpen()) return false;
    this.ws!.send(JSON.stringify(payload));
    return true;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retry = 0;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.ws?.close();
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${this.path}`);
    this.ws = ws;
    this.handlers.onStatus?.("connecting");

    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onStatus?.("open");
      this.handlers.onOpen?.();
      clearInterval(this.pingTimer);
      // Keeps idle connections alive through proxies and mobile NAT.
      this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 20_000);
    };
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data as string) as ServerMessage);
      } catch (err) {
        console.error("Bad message", err);
      }
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return; // superseded by a newer connection
      this.handlers.onStatus?.("closed");
      if (this.handlers.onClose?.(ev) === true) {
        this.stopped = true;
        return;
      }
      const delay = Math.min(8000, 400 * 2 ** this.retry++) + Math.random() * 300;
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }
}

/** Tracks the offset between this device's clock and the server's. */
export class ServerClock {
  private offsetMs = 0;

  sync(serverNowSeconds: number): void {
    this.offsetMs = serverNowSeconds * 1000 - Date.now();
  }

  /** Seconds left until `endsAt` (server epoch seconds), never negative. */
  remaining(endsAt: number | null): number {
    if (endsAt == null) return 0;
    return Math.max(0, (endsAt * 1000 - (Date.now() + this.offsetMs)) / 1000);
  }
}
