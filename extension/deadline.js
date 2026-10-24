export class CommandStopped extends Error {
  constructor(message) { super(message); this.name = "CommandStopped"; }
}

// The clock and abort listener live in the extension worker, outside the page.
// Late protocol resolutions are observed but cannot resume the caller's action.
export function bounded(operation, { signal, timeoutMs, label = "Browser command" }) {
  if (signal?.aborted) return Promise.reject(signal.reason || new CommandStopped("Command cancelled."));
  if (timeoutMs <= 0) return Promise.reject(new CommandStopped(`${label} exceeded its deadline.`));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason || new CommandStopped("Command cancelled."));
    const timer = setTimeout(() => finish(new CommandStopped(`${label} exceeded its deadline.`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { Promise.resolve(operation()).then((value) => finish(null, value), (error) => finish(error)); }
    catch (error) { finish(error); }
  });
}
