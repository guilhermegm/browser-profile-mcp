import { SecurePeer } from "./extension/secure-channel.js";

// MCP JSON-RPC stays inside the authenticated encrypted channel. The bridge's
// public health endpoint is never an authority check or a bearer-token sink.
export class SecureMcpTransport {
  constructor(socket, credentials, peer) {
    this.socket = socket;
    this.credentials = credentials;
    this.peer = peer;
  }

  async start() {
    if (this.started) throw new Error("MCP transport already started.");
    this.started = true;
    const callbacks = {
      onmessage: (message) => { this.onmessage?.(message); },
      onerror: (error) => this.onerror?.(error),
      onclose: () => this.onclose?.(),
    };
    if (this.peer) Object.assign(this.peer, callbacks);
    else this.peer = new SecurePeer(this.socket, { credentials: this.credentials, ...callbacks });
    // Server peers are already authenticated in the onready callback; awaiting
    // their ready promise here would deadlock that callback's mcp.connect().
    if (this.credentials) await this.peer.ready;
  }

  async send(message) { await this.peer.send(message); }
  async close() { this.peer?.close(); }
}
