import { COMMAND_PROTOCOL } from "./protocol.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_FRAME = 12 * 1024 * 1024;
const MAX_SEQUENCE = 0xffffffff;
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const nonce = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const bytes = (value) => Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));

function base64(value) {
  let result = "";
  for (let start = 0; start < value.length; start += 16384) result += String.fromCharCode(...value.subarray(start, start + 16384));
  return btoa(result);
}

function unbase64(value) {
  if (typeof value !== "string" || value.length > MAX_FRAME) throw new Error("Encrypted frame exceeds its limit.");
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function iv(sequence) {
  const result = new Uint8Array(12);
  new DataView(result.buffer).setUint32(8, sequence);
  return result;
}

async function proof(secret, label, transcript, received) {
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const data = encoder.encode(JSON.stringify(["browser-mcp-proof", label, transcript]));
  if (received !== undefined) {
    return typeof received === "string" && /^[a-f0-9]{64}$/.test(received) &&
      crypto.subtle.verify("HMAC", key, bytes(received), data);
  }
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

async function keys(secret, transcript) {
  const material = await crypto.subtle.importKey("raw", bytes(secret), "HKDF", false, ["deriveKey"]);
  const derive = (direction) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256",
    salt: encoder.encode(transcript), info: encoder.encode(`browser-mcp-aes-gcm:${direction}`) },
  material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { client: await derive("client-to-server"), server: await derive("server-to-client") };
}

function validHello(hello) {
  return hello?.type === "hello" && hello.protocol === COMMAND_PROTOCOL &&
    ["agent", "extension"].includes(hello.role) && /^[a-z0-9][a-z0-9-]{0,39}$/.test(hello.profileId) &&
    typeof hello.identity === "string" && /^[a-f0-9-]{36}$/.test(hello.identity) &&
    typeof hello.clientNonce === "string" && /^[a-f0-9]{64}$/.test(hello.clientNonce);
}

// The same authenticated channel is used by Node and Chrome. Reusable secrets
// never leave their process. Even a live relay cannot read or alter payloads.
export class SecurePeer {
  constructor(socket, { credentials, lookup, onready, onmessage, onclose, onerror } = {}) {
    this.socket = socket;
    this.server = Boolean(lookup);
    this.lookup = lookup;
    this.credentials = credentials;
    this.onready = onready;
    this.onmessage = onmessage;
    this.onclose = onclose;
    this.onerror = onerror;
    this.stage = this.server ? "hello" : "challenge";
    this.sent = 0;
    this.received = 0;
    this.pending = 0;
    this.input = Promise.resolve();
    this.output = Promise.resolve();
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Some server callers use callbacks rather than awaiting ready.
    void this.ready.catch(() => {});
    this.timer = setTimeout(() => this.fail(new Error("Secure bridge authentication timed out.")), 8000);
    socket.addEventListener("message", (event) => {
      if (this.closed) return;
      const size = typeof event.data === "string" ? event.data.length : event.data.size ?? event.data.length;
      if (!Number.isFinite(size) || size > MAX_FRAME || (!this.authenticated && size > 4096)) {
        this.fail(new Error("Secure frame exceeds its limit.")); return;
      }
      if (++this.pending > 64) { this.fail(new Error("Too many pending secure messages.")); return; }
      this.input = this.input.then(async () => {
        if (this.closed) return;
        const data = typeof event.data === "string" ? event.data : event.data.toString();
        if (data.length > MAX_FRAME || (!this.authenticated && data.length > 4096)) throw new Error("Secure frame exceeds its limit.");
        await this.receive(JSON.parse(data));
      }).catch((error) => this.fail(error)).finally(() => { this.pending--; });
    });
    socket.addEventListener("close", (event) => {
      this.closed = true;
      clearTimeout(this.timer);
      this.rejectReady(new Error(event.reason || "Secure bridge disconnected."));
      this.onclose?.(event);
    });
    socket.addEventListener("error", () => this.fail(new Error("Secure bridge connection failed.")));
    if (!this.server) {
      const open = () => {
        if (this.closed) return;
        this.hello = { type: "hello", protocol: COMMAND_PROTOCOL, role: credentials.role,
          profileId: credentials.profileId, identity: credentials.identity, clientNonce: nonce() };
        try { this.raw(this.hello); } catch (error) { this.fail(error); }
      };
      if (socket.readyState === 1) open(); else socket.addEventListener("open", open, { once: true });
    }
  }

  raw(message) {
    if (this.closed || this.socket.readyState !== 1) throw new Error("Secure bridge disconnected.");
    this.socket.send(JSON.stringify(message));
  }

  async establish(secret, hello, serverNonce) {
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid local pairing credentials.");
    this.transcript = JSON.stringify(["profile-browser-mcp", COMMAND_PROTOCOL, hello.role,
      hello.profileId, hello.identity, hello.clientNonce, serverNonce]);
    this.secret = secret;
    this.channelKeys = await keys(secret, this.transcript);
  }

  async receive(message) {
    if (this.stage === "hello") {
      if (!validHello(message)) throw new Error("Reload the extension and reconnect agents to update the secure protocol.");
      this.hello = message;
      this.metadata = await this.lookup(message);
      const serverNonce = nonce();
      await this.establish(this.metadata.secret, message, serverNonce);
      this.stage = "auth";
      this.raw({ type: "challenge", protocol: COMMAND_PROTOCOL, serverNonce,
        proof: await proof(this.secret, "server", this.transcript) });
      return;
    }
    if (this.stage === "challenge") {
      if (message?.type !== "challenge" || message.protocol !== COMMAND_PROTOCOL ||
          typeof message.serverNonce !== "string" || !/^[a-f0-9]{64}$/.test(message.serverNonce)) {
        throw new Error("Bridge did not provide secure authentication. Stop any older bridge and reconnect.");
      }
      await this.establish(this.credentials.secret, this.hello, message.serverNonce);
      if (typeof message.proof !== "string" || !await proof(this.secret, "server", this.transcript, message.proof)) {
        throw new Error("Bridge identity verification failed.");
      }
      this.stage = "ack";
      this.raw({ type: "auth", proof: await proof(this.secret, "client", this.transcript) });
      this.secret = undefined;
      return;
    }
    if (this.stage === "auth") {
      if (message?.type !== "auth" || typeof message.proof !== "string" || !await proof(this.secret, "client", this.transcript, message.proof)) {
        throw new Error("Client identity verification failed.");
      }
      this.secret = undefined;
      if (this.closed) return;
      this.authenticated = true;
      this.stage = "open";
      await this.send({ type: "authenticated" });
      await this.onready?.(this, this.metadata, this.hello);
      this.complete();
      return;
    }
    const payload = await this.decrypt(message);
    if (this.closed) return;
    if (this.stage === "ack") {
      if (payload?.type !== "authenticated") throw new Error("Missing authenticated bridge acknowledgement.");
      this.authenticated = true;
      this.stage = "open";
      await this.onready?.(this);
      this.complete();
      return;
    }
    if (this.stage !== "open") throw new Error("Invalid secure channel state.");
    await this.onmessage?.(payload);
  }

  complete() { clearTimeout(this.timer); this.resolveReady(this); }

  send(payload) {
    const operation = this.output.then(async () => {
      if (!this.authenticated || this.closed) throw new Error("Secure bridge is not authenticated.");
      const sequence = ++this.sent;
      if (sequence > MAX_SEQUENCE) throw new Error("Secure channel sequence exhausted; reconnect.");
      const plaintext = encoder.encode(JSON.stringify(payload));
      if (plaintext.length > MAX_MESSAGE) throw new Error("Secure message exceeds 8 MiB.");
      const direction = this.server ? "server" : "client";
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(sequence),
        additionalData: encoder.encode(`${this.transcript}:${direction}:${sequence}`), tagLength: 128 },
      this.channelKeys[direction], plaintext);
      this.raw({ type: "sealed", seq: sequence, data: base64(new Uint8Array(ciphertext)) });
    });
    this.output = operation.catch((error) => this.fail(error));
    return operation;
  }

  async decrypt(message) {
    if (message?.type !== "sealed" || !Number.isSafeInteger(message.seq) ||
        message.seq !== this.received + 1 || message.seq > MAX_SEQUENCE) throw new Error("Invalid secure message sequence.");
    const direction = this.server ? "client" : "server";
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(message.seq),
      additionalData: encoder.encode(`${this.transcript}:${direction}:${message.seq}`), tagLength: 128 },
    this.channelKeys[direction], unbase64(message.data));
    if (plaintext.byteLength > MAX_MESSAGE) throw new Error("Secure message exceeds 8 MiB.");
    this.received = message.seq;
    return JSON.parse(decoder.decode(plaintext));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.rejectReady(error);
    this.onerror?.(error);
    this.socket.close(4003, "Secure authentication or message validation failed; reload and reconnect");
  }

  close() { this.socket.close(1000, "Disconnected"); }
}
