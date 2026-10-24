// Shared by the bridge and extension. A global job is a FIFO barrier; metadata
// reads bypass the page queues. Each page job holds its tab through cleanup.
export class CommandScheduler {
  constructor({ concurrency = 4, limit = 32 } = {}) {
    this.concurrency = concurrency;
    this.limit = limit;
    this.queue = [];
    this.running = new Set();
    this.tabs = new Set();
    this.metadata = 0;
    this.global = false;
    this.closed = false;
  }

  run(lane, operation, { signal, waitMs = 20_000, internal = false } = {}) {
    if (this.closed) return Promise.reject(new Error("Browser connection closed. No action started."));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("Command cancelled before it started."));
    if (!internal && this.queue.length + this.running.size + this.metadata >= this.limit) {
      return Promise.reject(new Error("Browser command queue is full. No action started; try again shortly."));
    }
    return new Promise((resolve, reject) => {
      const job = { lane, operation, resolve, reject, signal, started: false };
      const cancel = (error) => {
        if (job.started) return;
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        job.cleanup();
        reject(error);
        this.pump();
      };
      const abort = () => cancel(signal.reason || new Error("Command cancelled before it started. No action ran."));
      job.cleanup = () => { clearTimeout(job.timer); signal?.removeEventListener("abort", abort); };
      job.timer = setTimeout(() => cancel(new Error("Browser command queue is busy. No action started; try again shortly.")), waitMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (lane === "metadata") this.start(job);
      else { this.queue.push(job); this.pump(); }
    });
  }

  pump() {
    if (this.closed || this.global) return;
    while (this.running.size < this.concurrency && this.queue.length) {
      const barrier = this.queue.findIndex((job) => job.lane === "global");
      if (barrier === 0) {
        if (!this.running.size) this.start(this.queue.shift());
        return;
      }
      const end = barrier < 0 ? this.queue.length : barrier;
      const index = this.queue.findIndex((job, i) => i < end && !this.tabs.has(job.lane));
      if (index < 0) return;
      this.start(this.queue.splice(index, 1)[0]);
    }
  }

  start(job) {
    job.started = true;
    job.cleanup();
    const metadata = job.lane === "metadata";
    if (metadata) this.metadata++;
    else {
      this.running.add(job);
      if (job.lane === "global") this.global = true;
      else this.tabs.add(job.lane);
    }
    void (async () => {
      try {
        if (job.signal?.aborted) throw job.signal.reason || new Error("Command cancelled before it started.");
        job.resolve(await job.operation());
      } catch (error) { job.reject(error); }
      finally {
        if (metadata) this.metadata--;
        else {
          this.running.delete(job);
          if (job.lane === "global") this.global = false;
          else this.tabs.delete(job.lane);
        }
        this.pump();
      }
    })();
  }

  close(error = new Error("Browser connection closed. No action started.")) {
    this.closed = true;
    for (const job of this.queue.splice(0)) { job.cleanup(); job.reject(error); }
  }
}
