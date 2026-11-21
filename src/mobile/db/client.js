// The page's side of databases.worker.ts: one request at a time, as the worker has one connection.
// A request sent with a channel replaces an earlier one on that channel that has not started yet,
// with the desktop's SUPERSEDED answer (query-pool.js).

export class DatabaseWorker {
	constructor(createWorker) {
		this.createWorker = createWorker;
		this.worker = null;
		this.seq = 0;
		this.waiting = [];
		this.running = null;
	}

	start() {
		if (!this.worker) {
			this.worker = this.createWorker();
			this.worker.onmessage = ({ data }) => this.answered(data);
			this.worker.onerror = (event) => {
				const job = this.running;
				this.running = null;
				job?.reject(coded('FAILED', `The database worker stopped: ${event.message ?? 'unknown error'}`));
				this.next();
			};
		}
		return this.worker;
	}

	// onProgress: called with each { done, total } the worker reports before it answers (an import).
	request(message, { channel = null, transfer = [], onProgress = null } = {}) {
		return new Promise((resolve, reject) => {
			if (channel) {
				for (const job of this.waiting.filter((one) => one.channel === channel)) {
					job.reject(coded('SUPERSEDED', 'A newer request replaced this one.'));
				}
				this.waiting = this.waiting.filter((one) => one.channel !== channel);
			}
			this.waiting.push({ message, channel, transfer, onProgress, resolve, reject });
			this.next();
		});
	}

	next() {
		if (this.running || this.waiting.length === 0) {
			return;
		}
		const job = this.waiting.shift();
		job.seq = ++this.seq;
		this.running = job;
		this.start().postMessage({ ...job.message, seq: job.seq }, job.transfer);
	}

	answered(data) {
		const job = this.running;
		if (!job || data.seq !== job.seq) {
			return;
		}
		if (data.type === 'progress') {
			job.onProgress?.({ done: data.done, total: data.total });
			return;
		}
		this.running = null;
		if (data.ok) {
			job.resolve(data.value);
		} else {
			job.reject(coded(data.code ?? 'FAILED', data.message ?? 'The query failed'));
		}
		this.next();
	}
}

function coded(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}
