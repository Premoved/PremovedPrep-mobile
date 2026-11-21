// node:worker_threads inside a replay worker (replay-worker.js, a Web Worker started by
// shims/worker_threads.js): its parent is the worker that started it, its workerData came in the address.

const data = new URL(self.location.href).searchParams.get('data');

export const workerData = data ? JSON.parse(data) : null;
export const isMainThread = false;

export const parentPort = {
	on(event, handler) {
		if (event === 'message') {
			self.addEventListener('message', (message) => handler(message.data));
		}
	},
	postMessage(message, transfer) {
		self.postMessage(message, transfer ?? []);
	},
};

export default { parentPort, workerData, isMainThread };
