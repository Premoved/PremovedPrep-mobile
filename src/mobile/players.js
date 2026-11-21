// Android counterpart of PremovedPrep-App/shell/local/players.js: the FIDE player list kept for working
// offline. Search opponent reads it when the server cannot be reached. The page asks for a newer one
// with every version check (update.service.ts); the app keeps the last one it has otherwise.
//
// The server's file is downloaded by the plugin (native code, as the API requests: no CORS), built into
// a database of its own by the desktop's builder in db/index.worker.ts, and read by the desktop's
// queries in db/databases.worker.ts. The list in use is named in the settings; a newer one is built
// beside it and replaces it only once whole.

import { coded } from './store.js';

const NO_LIST =
	'Search opponent needs the FIDE player list to work offline. It downloads automatically the next time you ' +
	'are online.';
const DOWNLOADING = 'The FIDE player list is still downloading. Search opponent will work offline when it finishes.';

// The download, in the app's cache until it is read.
const DOWNLOAD = 'players.gz';

export class Players {
	constructor(settings, worker, native, emit, createIndexWorker, fileSrc) {
		this.settings = settings;
		this.worker = worker;
		this.native = native;
		this.emit = emit;
		this.createIndexWorker = createIndexWorker;
		this.fileSrc = fileSrc;
		this.updating = null;
	}

	kept() {
		return this.settings.value.playerList ?? null;
	}

	/** The list kept, or null: { version, players, builtAt, updating }. */
	status() {
		const kept = this.kept();
		if (!kept) {
			return null;
		}
		return { version: kept.version, players: kept.players, builtAt: kept.builtAt, updating: this.updating !== null };
	}

	/** Starts fetching the server's list when it is newer than the one kept; returns at once. */
	update({ version, url, format } = {}) {
		if (typeof version !== 'string' || typeof url !== 'string' || !/^https:\/\//.test(url)) {
			return this.status();
		}
		if (this.updating === null && this.kept()?.version !== version) {
			this.updating = this.download(url, version, format).finally(() => {
				this.updating = null;
			});
		}
		return this.status();
	}

	async download(url, version, format) {
		const file = `/players-${version.replace(/[^A-Za-z0-9._-]/g, '_')}.sqlite`;
		const started = Date.now();
		try {
			const { path } = await this.native.download({ url, name: DOWNLOAD });
			const built = await runWorker(this.createIndexWorker, {
				op: 'players',
				url: this.fileSrc(path),
				file,
				version,
				format,
			});
			const old = this.kept();
			this.settings.update({
				playerList: { file, version: built.version, players: built.players, builtAt: new Date().toISOString() },
			});
			if (old && old.file !== file) {
				await this.worker.request({ op: 'remove', file: old.file }).catch(() => undefined);
			}
			console.info(
				`[players] list ${built.version}: ${built.players} players in ${Math.round((Date.now() - started) / 1000)} s`,
			);
			this.emit('players.changed', this.status());
		} catch (error) {
			console.warn(`[players] list ${version} not updated: ${error?.message ?? error}`);
			if (this.kept()?.file !== file) {
				await this.worker.request({ op: 'remove', file }).catch(() => undefined);
			}
		} finally {
			await this.native.downloadRemove({ name: DOWNLOAD }).catch(() => undefined);
		}
	}

	search(q, limit, channel) {
		return this.ask('search', { q, limit }, channel);
	}

	profile(fideId) {
		return this.ask('profile', { fideId });
	}

	identity(fideId) {
		return this.ask('identity', { fideId });
	}

	ask(method, args, channel) {
		const kept = this.kept();
		if (!kept) {
			return Promise.reject(coded('NOT_FOUND', this.updating === null ? NO_LIST : DOWNLOADING));
		}
		return this.worker.request({ op: 'players', method, file: kept.file, args }, { channel: channel ?? null });
	}
}

/**
 * One job in a worker of its own (db/index.worker.ts), started for it and ended after: building the player
 * list, an export. onProgress gets each { stage, done, total } it reports.
 */
export function runWorker(createWorker, message, onProgress = null) {
	const worker = createWorker();
	return new Promise((resolve, reject) => {
		worker.onmessage = ({ data }) => {
			if (data.type === 'progress') {
				onProgress?.(data);
				return;
			}
			if (data.type === 'result') {
				worker.terminate();
				if (data.ok) {
					resolve(data.value);
				} else {
					reject(coded(data.code ?? 'FAILED', data.message ?? 'The job failed.'));
				}
			}
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(coded('FAILED', `The worker stopped: ${event.message ?? 'unknown error'}`));
		};
		worker.postMessage({ ...message, seq: 1 });
	});
}
