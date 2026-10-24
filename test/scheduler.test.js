import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandScheduler } from '../extension/scheduler.js';
import { bounded, CommandStopped } from '../extension/deadline.js';

function gate() { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; }

test('same-tab jobs stay ordered while an independent tab can run', async () => {
  const scheduler = new CommandScheduler(); const hold = gate(); const events = [];
  const first = scheduler.run('tab:1', async () => { events.push('first'); await hold.promise; events.push('first finished'); });
  const second = scheduler.run('tab:1', () => { events.push('second'); });
  await scheduler.run('tab:2', () => { events.push('other tab'); });
  assert.deepEqual(events, ['first', 'other tab']);
  hold.release(); await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other tab', 'first finished', 'second']);
});

test('a global barrier waits for earlier tabs and prevents later tabs from overtaking it', async () => {
  const scheduler = new CommandScheduler(); const before = gate(); const barrier = gate(); const events = [];
  const one = scheduler.run('tab:1', () => before.promise);
  const global = scheduler.run('global', async () => { events.push('global'); await barrier.promise; });
  const after = scheduler.run('tab:2', () => { events.push('after'); });
  await scheduler.run('metadata', () => { events.push('metadata'); });
  assert.deepEqual(events, ['metadata']);
  before.release(); await one;
  assert.deepEqual(events, ['metadata', 'global']);
  barrier.release(); await Promise.all([global, after]);
  assert.deepEqual(events, ['metadata', 'global', 'after']);
});

test('cancelled and expired queued jobs never execute later', async () => {
  const scheduler = new CommandScheduler(); const hold = gate(); let ran = false;
  const first = scheduler.run('tab:1', () => hold.promise);
  const controller = new AbortController();
  const cancelled = scheduler.run('tab:1', () => { ran = true; }, { signal: controller.signal });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(cancelled, /test cancellation/);
  await assert.rejects(scheduler.run('tab:1', () => { ran = true; }, { waitMs: 15 }), /No action started/);
  hold.release(); await first;
  await scheduler.run('tab:1', () => {});
  assert.equal(ran, false);
});

test('queue limits and closure reject work before it starts', async () => {
  const scheduler = new CommandScheduler({ limit: 1 }); const hold = gate();
  const first = scheduler.run('tab:1', () => hold.promise);
  await assert.rejects(scheduler.run('tab:2', () => {}), /queue is full/);
  scheduler.close();
  await assert.rejects(scheduler.run('metadata', () => {}), /connection closed/);
  hold.release(); await first;
});

test('worker deadlines reject a stalled operation and ignore its late result', async () => {
  const hold = gate();
  await assert.rejects(bounded(() => hold.promise, { timeoutMs: 15, label: 'stalled browser' }), CommandStopped);
  hold.release('late result');
  const controller = new AbortController(); controller.abort(new CommandStopped('cancelled'));
  let ran = false;
  await assert.rejects(bounded(() => { ran = true; }, { signal: controller.signal, timeoutMs: 100 }), /cancelled/);
  assert.equal(ran, false);
});
