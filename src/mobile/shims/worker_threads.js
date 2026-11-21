// node:worker_threads for the bundled desktop modules, on Android.
//
// parentPort: the desktop's indexer (index-worker.js) is run here as a library, called by
// db/index.worker.ts, and talks to its parent through parentPort. Its messages (progress, log) go to
// the sink that worker sets. (At import the indexer also sees a parent and starts a run without
// data; that run fails at once and its message goes nowhere, as no sink is set yet.)
//
// Worker: the indexer's replay workers run as Web Workers started from this worker, from
// replay-worker.js, which tools/prepare.mjs bundles from the desktop's. Their workerData travels in
// the address, as a module there reads it as soon as it loads. Count workers are not started on
// Android (INDEX_COUNTERS is 0 in shims/process-global.js).

// On globalThis: the indexer's bundle has its own copy of this module (see shims/fs.js).
const shared = (globalThis.__premovedParent ??= { sink: null });

export function setParentSink(handler) {
	shared.sink = handler;
}

export const parentPort = {
	postMessage(message) {
		shared.sink?.(message);
	},
	on() {},
};

export const workerData = null;
export const isMainThread = true;

const STARTABLE = new Set(['replay-worker.js']);

export class Worker {
	constructor(script, options = {}) {
		const name = String(script).split(/[\\/]/).pop();
		if (!STARTABLE.has(name)) {
			throw new Error(`${name} cannot be started in the Android app`);
		}
		this.listeners = new Map();
		const data = encodeURIComponent(JSON.stringify(options.workerData ?? null));
		this.worker = new globalThis.Worker(`/${name}?data=${data}`);
		this.worker.onmessage = (event) => this.emit('message', event.data);
		this.worker.onerror = (event) => {
			event.preventDefault?.();
			this.emit('error', new Error(event.message || `${name} failed`));
		};
	}

	on(event, handler) {
		const handlers = this.listeners.get(event) ?? [];
		handlers.push(handler);
		this.listeners.set(event, handlers);
		return this;
	}

	emit(event, value) {
		for (const handler of this.listeners.get(event) ?? []) {
			handler(value);
		}
	}

	postMessage(message, transfer) {
		this.worker.postMessage(message, transfer ?? []);
	}

	terminate() {
		this.worker.terminate();
		return Promise.resolve(0);
	}
}

export default { parentPort, workerData, isMainThread, Worker, setParentSink };
