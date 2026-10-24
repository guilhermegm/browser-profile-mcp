import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { SecurePeer } from '../extension/secure-channel.js';
import { until } from './helpers.mjs';

async function peers(t, wrongSecret = false) {
  const secret = randomBytes(32).toString('hex');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const accepted = []; const messages = []; const errors = [];
  let remote;
  server.on('connection', (socket) => {
    accepted.push(socket);
    remote = new SecurePeer(socket, { lookup: () => ({ secret }), onmessage: (message) => { messages.push(message); }, onerror: (error) => { errors.push(error); } });
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const client = new SecurePeer(socket, { credentials: { role: 'agent', profileId: 'work', identity: randomUUID(), secret: wrongSecret ? randomBytes(32).toString('hex') : secret } });
  t.after(async () => { socket.terminate(); for (const peer of accepted) peer.terminate(); await new Promise((resolve) => server.close(resolve)); });
  return { client, socket, messages, errors, secret, remote: () => remote };
}

test('mutually authenticated peers encrypt and deliver application messages', { timeout: 5000 }, async (t) => {
  const p = await peers(t); const frames = [];
  const send = p.socket.send.bind(p.socket);
  p.socket.send = (data, ...args) => { frames.push(String(data)); return send(data, ...args); };
  await p.client.ready;
  await p.client.send({ text: 'private fixture page text' });
  await until(() => p.messages.length);
  assert.deepEqual(p.messages, [{ text: 'private fixture page text' }]);
  const wire = frames.join('\n');
  assert.ok(!wire.includes(p.secret));
  assert.ok(!wire.includes('private fixture page text'));
});

test('incorrect secrets fail before application messages are accepted', { timeout: 5000 }, async (t) => {
  const p = await peers(t, true);
  await assert.rejects(p.client.ready, /verification failed|validation failed|disconnected/);
  assert.deepEqual(p.messages, []);
});

test('replayed encrypted frames are rejected instead of executing twice', { timeout: 5000 }, async (t) => {
  const p = await peers(t); await p.client.ready;
  let frame;
  const send = p.socket.send.bind(p.socket);
  p.socket.send = (data, ...args) => { if (JSON.parse(data).type === 'sealed') frame = String(data); return send(data, ...args); };
  await p.client.send({ action: 'fixture' });
  await until(() => p.messages.length === 1);
  send(frame);
  await until(() => p.errors.length);
  assert.match(p.errors[0].message, /sequence/);
  assert.equal(p.messages.length, 1);
});

test('modified ciphertext fails authentication without exposing an application payload', { timeout: 5000 }, async (t) => {
  const p = await peers(t); await p.client.ready;
  const send = p.socket.send.bind(p.socket);
  p.socket.send = (data, ...args) => {
    const frame = JSON.parse(data);
    if (frame.type === 'sealed') frame.data = (frame.data[0] === 'A' ? 'B' : 'A') + frame.data.slice(1);
    return send(JSON.stringify(frame), ...args);
  };
  await p.client.send({ action: 'must not execute' });
  await until(() => p.errors.length);
  assert.equal(p.messages.length, 0);
});
