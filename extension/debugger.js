import { bounded, CommandStopped } from "./deadline.js";

const alreadyDetached = (error) => /not attached|no tab with|target.*closed|invalid tab id|no target with/i.test(error.message);

export class DebuggerSessions {
  constructor(check, invalidate) { this.check = check; this.invalidate = invalidate; this.states = new Map(); }

  state(tabId) {
    if (!this.states.has(tabId)) this.states.set(tabId,
      { generation: 0, phase: "idle", domains: new Set(), initializingDomains: false });
    return this.states.get(tabId);
  }

  attachedTabs() { return [...this.states].filter(([, state]) => state.phase === "attached").map(([id]) => id); }
  isAttached(tabId) { return this.states.get(tabId)?.phase === "attached"; }
  owns(tabId, context) {
    const state = this.states.get(tabId);
    return state?.phase === "attached" && context.generations.get(tabId) === state.generation;
  }
  initializing(tabId) {
    const state = this.states.get(tabId);
    return state?.phase === "attaching" || state?.initializingDomains;
  }

  forget(tabId) {
    const state = this.states.get(tabId);
    const wasAttached = state && state.phase !== "idle";
    if (state) {
      state.generation++;
      state.phase = "idle";
      state.domains.clear();
      state.pendingAttach = undefined;
      state.recovery = undefined;
    }
    this.invalidate(tabId);
    return Boolean(wasAttached);
  }

  async attach(tabId, context) {
    this.check(context);
    const state = this.state(tabId);
    context.tabs.add(tabId);
    if (state.phase === "attached") { context.generations.set(tabId, state.generation); return; }
    if (state.phase !== "idle") {
      throw new Error("This tab is still recovering from a stopped command. No action started; wait or reload the extension.");
    }
    const generation = ++state.generation;
    context.generations.set(tabId, generation);
    state.phase = "attaching";
    const pending = { promise: chrome.debugger.attach({ tabId }, "1.3") };
    state.pendingAttach = pending;
    try {
      await bounded(() => pending.promise, { signal: context.signal,
        timeoutMs: Math.min(10_000, context.deadline - Date.now()), label: "Debugger attachment" });
      this.check(context);
      if (state.generation !== generation) throw new CommandStopped("Debugger attachment changed during the command.");
      state.phase = "attached";
      state.pendingAttach = undefined;
    } catch (error) {
      if (error instanceof CommandStopped || context.signal.aborted) {
        context.recoverTabs.add(tabId);
        context.controller.abort(error);
      }
      else if (state.generation === generation) {
        state.phase = "idle"; state.pendingAttach = undefined;
      }
      if (error instanceof CommandStopped || context.signal.aborted) throw error;
      throw new Error(`Cannot control this tab: ${error.message}. Close any competing DevTools/debugger first.`);
    }
  }

  async command(tabId, method, params, context, timeoutMs = 10_000) {
    this.check(context);
    const state = this.state(tabId);
    if (state.phase !== "attached") throw new CommandStopped("The tab's debugger is no longer attached.");
    const generation = state.generation;
    context.tabs.add(tabId);
    try {
      const result = await bounded(() => chrome.debugger.sendCommand({ tabId }, method, params || {}), {
        signal: context.signal, timeoutMs: Math.min(timeoutMs, context.deadline - Date.now()), label: method,
      });
      this.check(context);
      if (state.generation !== generation || state.phase !== "attached") throw new CommandStopped("Debugger attachment changed during the command.");
      return result;
    } catch (error) {
      if (error instanceof CommandStopped || context.signal.aborted) {
        context.recoverTabs.add(tabId);
        context.controller.abort(error);
      }
      throw error;
    }
  }

  async enable(tabId, domains, context) {
    const state = this.state(tabId);
    const missing = domains.filter((domain) => !state.domains.has(domain));
    if (!missing.length) return;
    state.initializingDomains = true;
    try {
      const results = await Promise.allSettled(missing.map(async (domain) => {
        await this.command(tabId, `${domain}.enable`, {}, context);
        state.domains.add(domain);
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    } finally { state.initializingDomains = false; }
  }

  async release(tabId, { preserveRefs = false } = {}) {
    const state = this.states.get(tabId);
    if (!state || state.phase === "idle") return true;
    if (!preserveRefs) this.invalidate(tabId);
    if (!state.recovery) {
      const generation = state.generation;
      const pendingAttach = state.pendingAttach;
      const recovery = {};
      state.recovery = recovery;
      state.phase = "detaching";
      recovery.promise = (async () => {
        // A late attach must finish before detach is sent. Quarantine prevents a
        // newer command from attaching until this generation is known detached.
        if (pendingAttach) await pendingAttach.promise.catch(() => {});
        if (state.generation !== generation) return;
        try { await chrome.debugger.detach({ tabId }); }
        catch (error) { if (!alreadyDetached(error)) throw error; }
        if (state.generation === generation && state.recovery === recovery) {
          state.phase = "idle"; state.domains.clear(); state.pendingAttach = undefined; state.recovery = undefined;
        }
      })().catch((error) => {
        if (state.generation === generation && state.recovery === recovery) {
          state.phase = "quarantined"; state.recovery = undefined;
          this.invalidate(tabId);
        }
        recovery.error = error;
      });
    }
    const recovery = state.recovery;
    try {
      await bounded(() => recovery.promise, { timeoutMs: 1500, label: "Debugger cleanup" });
      return state.phase === "idle";
    } catch {
      if (state.recovery === recovery) state.phase = "quarantined";
      this.invalidate(tabId);
      return false;
    }
  }
}
