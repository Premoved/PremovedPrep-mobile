// Android counterpart of PremovedPrep-App/shell/local/database.js: the same settings entries, cards,
// answers and events, for databases kept in the app's private storage (OPFS).
//
// Queries go to db/databases.worker.ts, one at a time. Indexing (a PGN into a search database, a
// search database's positions) runs the desktop's own indexer in db/index.worker.ts, one worker per
// run: Stop ends that worker, and Resume carries on from what was committed, as on the desktop.
// A file is written by one worker at a time: the query worker lets go of a database before a run
// writes it, and a search database is not queried while its positions are being counted (they read it).
//
// What differs from the desktop, by necessity:
// - A picked PGN is copied into the app's storage first (the picked file may not be readable again),
//   and the copy is removed once every game is in: as on the desktop, the database keeps each game's
//   text and does not need its PGN. So Rebuild works only while the copies are still there.
// - Export (.ppdb) saves through the system's save dialog, in pieces (the file can be larger than memory).

import { coded } from './store.js';
import { runWorker } from './players.js';
import {
	DEFAULT_MAX_PLY,
	INDEX_VERSION,
	POSITIONS_VERSION,
	SEARCH_PER_PGN_BYTE,
	POSITIONS_PER_PGN_BYTE,
} from './core/database-constants.js';

const NOT_YET = 'Not in the Android version yet.';

const LOCATION = 'App storage';

// The copies of the picked PGNs, in the app's storage (db/index.worker.ts writes them).
const PGN_FOLDER = 'premovedprep-pgn';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export class Databases {
	constructor(settings, worker, native, emit, createIndexWorker) {
		this.settings = settings;
		this.worker = worker;
		this.native = native;
		this.emit = emit;
		this.createIndexWorker = createIndexWorker;
		this.copying = new Set();
		// id (search or position database) → its run: { stop }.
		this.building = new Map();
		this.progress = new Map();
		// Runs stopped on purpose (Stop, Remove): their end is not a failure.
		this.stopped = new Set();
		// Search databases whose positions are being counted: the run reads their file.
		this.reading = new Set();
		this.awake = false;
		this.forgetImports();
	}

	// An import cut short (the app closed while copying) leaves an entry that never became ready.
	forgetImports() {
		const left = this.entries().filter((entry) => entry.importing === true);
		if (left.length === 0) {
			return;
		}
		this.settings.update({ databases: this.entries().filter((entry) => entry.importing !== true) });
		for (const entry of left) {
			void this.worker.request({ op: 'remove', file: entry.index }).catch(() => undefined);
		}
	}

	entries() {
		return this.settings.value.databases ?? [];
	}

	entry(id) {
		return this.entries().find((entry) => entry.id === id) ?? null;
	}

	positionEntries() {
		return this.settings.value.positionDatabases ?? [];
	}

	positionEntry(id) {
		return this.positionEntries().find((entry) => entry.id === id) ?? null;
	}

	positionsFor(databaseId) {
		return this.positionEntries().find((entry) => entry.databaseId === databaseId) ?? null;
	}

	positionFile(entry) {
		return entry.combined ? (this.entry(entry.databaseId)?.index ?? entry.index) : entry.index;
	}

	writePositions(id, patch) {
		this.settings.update({
			positionDatabases: this.positionEntries().map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
		});
	}

	async sizeOf(file) {
		return this.worker.request({ op: 'size', file }).catch(() => 0);
	}

	// The screen stays on while a database is indexed, counted or copied: Android would otherwise
	// stop the app part way once the screen goes off.
	keepAwake() {
		const busy = this.building.size + this.copying.size > 0;
		if (busy === this.awake) {
			return;
		}
		this.awake = busy;
		void this.native.keepAwake({ on: busy }).catch(() => undefined);
	}

	async list() {
		const cards = [];
		for (const entry of this.entries()) {
			const running = this.copying.has(entry.id) || this.building.has(entry.id);
			cards.push({
				...card(entry, await this.sizeOf(entry.index), running),
				running,
				progress: this.progress.get(entry.id) ?? null,
			});
		}
		return cards;
	}

	async positionsList() {
		const cards = [];
		for (const entry of this.positionEntries()) {
			const search = this.entry(entry.databaseId);
			const running = this.building.has(entry.id);
			cards.push({
				id: entry.id,
				databaseId: entry.databaseId,
				name: search?.name ?? entry.name ?? '',
				location: `${LOCATION}${this.positionFile(entry)}`,
				combined: entry.combined === true,
				bytes: entry.combined ? null : await this.sizeOf(entry.index),
				positions: entry.positions ?? 0,
				newGames: entry.ready === true ? Math.max(0, (search?.topId ?? 0) - (entry.upTo ?? 0)) : 0,
				outdated: entry.outdated === true,
				ready: entry.ready === true,
				paused: entry.ready !== true && !running,
				failure: running ? null : (entry.failure ?? null),
				running,
				progress: this.progress.get(entry.id) ?? null,
				updatedAt: entry.updatedAt,
			});
		}
		return cards;
	}

	// Asked once: whether a database can be read by two workers at once (databases.worker.ts).
	sharedReading() {
		this.shared ??= this.worker.request({ op: 'shared' }).catch(() => false);
		return this.shared;
	}

	notYet() {
		throw coded('FAILED', NOT_YET);
	}

	// ------------------------------------------------------------------ indexing a PGN

	// Throws, with the reason, when the storage has no room for this much.
	async roomFor(bytes) {
		const { bytes: free } = await this.native.freeSpace().catch(() => ({ bytes: Infinity }));
		if (free < bytes) {
			throw coded(
				'FAILED',
				`Not enough free space: this needs about ${gigabytes(bytes)} GB, and ${gigabytes(free)} GB are free.`,
			);
		}
	}

	// A new search database from a picked PGN: listed at once, indexed in the background.
	async add(file) {
		pgnOnly(file);
		// The copy of the PGN, then the database next to it.
		await this.roomFor(file.size * (1 + SEARCH_PER_PGN_BYTE));
		const id = this.settings.takeDatabaseId();
		const name = file.name.replace(/\.pgn$/i, '').trim() || `Database ${id}`;
		const taken = new Set(
			[...this.entries(), ...this.positionEntries()].map((entry) => String(entry.index).toLowerCase()),
		);
		const index = fileNameFor(name, taken);
		const source = { path: pgnPath(id, 1), bytes: file.size, name: file.name };
		this.settings.update({
			databases: [
				...this.entries(),
				{
					id,
					name,
					sources: [source],
					index,
					failure: null,
					games: 0,
					positions: 0,
					maxPly: DEFAULT_MAX_PLY,
					indexedSources: 0,
					version: INDEX_VERSION,
					ready: false,
					updatedAt: new Date().toISOString(),
				},
			],
		});
		this.emit('db.changed', {});
		void this.run(id, true, [{ path: source.path, file }]).catch(() => undefined);
	}

	// Another PGN into a database: only its games are read.
	async append(id, file) {
		const entry = this.entry(id);
		if (!entry) {
			throw coded('NOT_FOUND', `No database with id ${id}`);
		}
		if (entry.version !== INDEX_VERSION) {
			throw coded('FAILED', 'This database was made by an older version: import a new export of it.');
		}
		this.notWhileBusy(id);
		pgnOnly(file);
		await this.roomFor(file.size * (1 + SEARCH_PER_PGN_BYTE));
		const sources = sourcesOf(entry);
		const source = { path: pgnPath(id, sources.length + 1), bytes: file.size, name: file.name };
		this.write(id, { sources: [...sources, source], ready: false });
		this.emit('db.changed', {});
		void this.run(id, false, [{ path: source.path, file }]).catch(() => undefined);
	}

	resume(id) {
		if (!this.entry(id)) {
			throw coded('NOT_FOUND', `No database with id ${id}`);
		}
		this.notWhileBusy(id);
		void this.run(id, false).catch(() => undefined);
	}

	// From nothing: possible while the copies of its PGNs are still in the app (a run that never finished).
	async rebuild(id) {
		const entry = this.entry(id);
		if (!entry) {
			throw coded('NOT_FOUND', `No database with id ${id}`);
		}
		this.notWhileBusy(id);
		const sources = sourcesOf(entry);
		for (const source of sources) {
			if (!(await pgnKept(source.path))) {
				throw coded(
					'FAILED',
					'Its PGN files are no longer kept in the app (the database holds the games). To index them again, add them as a new database.',
				);
			}
		}
		if (sources.length === 0) {
			throw coded('FAILED', 'This database was imported: it has no PGN to index again.');
		}
		// Its games get new ids: positions built from the old ones would point at the wrong games.
		const positions = this.positionsFor(id);
		if (positions) {
			await this.removePositions(positions.id);
		}
		this.write(id, { ready: false, version: INDEX_VERSION });
		this.emit('db.changed', {});
		void this.run(id, true).catch(() => undefined);
	}

	// One run writes a file at a time, and a database's positions read its games while they are counted.
	notWhileBusy(databaseId) {
		if (this.building.has(databaseId) || this.copying.has(databaseId)) {
			throw coded('FAILED', 'This database is already being indexed.');
		}
		const positions = this.positionsFor(databaseId);
		if (positions && this.building.has(positions.id)) {
			throw coded('FAILED', 'Wait for the positions of this database to finish counting, or stop them.');
		}
	}

	async run(id, restart, incoming = []) {
		const entry = this.entry(id);
		// The query worker lets go of the file this run writes.
		await this.worker.request({ op: 'close', file: entry.index }).catch(() => undefined);
		this.write(id, { failure: null, ready: false });
		this.emit('db.changed', {});
		try {
			const counted = await this.index(id, {
				op: 'games',
				index: entry.index,
				sources: sourcesOf(entry).map(({ path, bytes }) => ({ path, bytes })),
				incoming,
				restart,
			});
			// The files as the database lists them (an imported one also lists the desktop's), named for the row.
			const named = (counted.sources ?? sourcesOf(entry)).map(
				(one) =>
					sourcesOf(this.entry(id)).find((known) => known.path === one.path) ?? {
						...one,
						name: String(one.path).split(/[\\/]/).pop(),
					},
			);
			this.write(id, {
				sources: named,
				games: counted.games,
				topId: counted.top,
				indexedSources: counted.indexedSources,
				version: INDEX_VERSION,
				ready: true,
				failure: null,
				updatedAt: new Date().toISOString(),
			});
			// Games taken out and read again: positions kept apart still point at the old ones.
			const positions = this.positionsFor(id);
			if (counted.replaced > 0 && positions && !positions.combined) {
				this.writePositions(positions.id, { outdated: true });
			}
			this.emit('db.changed', {});
			return card(this.entry(id), await this.sizeOf(entry.index), false);
		} catch (error) {
			const stopped = this.stopped.has(id);
			this.failed(id, entry.name, error);
			// A first run that failed before anything was kept leaves nothing worth resuming.
			if (!stopped && restart && incoming.length > 0) {
				await this.forget(id);
			}
			this.emit('db.changed', {});
			throw error;
		}
	}

	// One worker per run; its progress goes to the row as the desktop's showProgress() sends it.
	index(id, message, { positions = false } = {}) {
		if (this.building.has(id)) {
			return Promise.reject(coded('FAILED', 'This database is already being indexed.'));
		}
		const worker = this.createIndexWorker();
		const pace = new Pace();
		return new Promise((resolve, reject) => {
			let over = false;
			const finish = (settle, value) => {
				if (over) {
					return;
				}
				over = true;
				worker.terminate();
				this.building.delete(id);
				this.progress.delete(id);
				this.keepAwake();
				settle(value);
			};
			this.building.set(id, {
				stop: () => {
					this.stopped.add(id);
					finish(reject, coded('FAILED', 'Indexing stopped.'));
				},
			});
			this.keepAwake();

			worker.onmessage = ({ data }) => {
				if (data.type === 'progress') {
					// Counting positions: one percentage for the run, reading the games about 70% of it.
					let shown = { stage: data.stage, done: data.done, total: data.total };
					if (positions) {
						const share = data.total > 0 ? Math.min(1, data.done / data.total) : 0;
						const whole = data.stage === 'reading' ? 0.7 * share : 0.7 + 0.3 * share;
						shown = { stage: 'counting', done: Math.round(whole * 1000), total: 1000 };
					}
					const frame = { ...shown, ...pace.update(shown.stage, shown.done, shown.total), at: Date.now(), space: null };
					this.progress.set(id, frame);
					this.emit('db.progress', { databaseId: id, ...frame });
					return;
				}
				if (data.type === 'result') {
					if (data.ok) {
						finish(resolve, data.value);
					} else {
						finish(reject, coded(data.code ?? 'FAILED', data.message ?? 'Indexing failed.'));
					}
				}
			};
			worker.onerror = (event) => {
				finish(reject, coded('FAILED', `The indexing stopped: ${event.message ?? 'unknown error'}`));
			};
			worker.postMessage({ ...message, seq: 1 });
		});
	}

	// Kept on the entry, so the reason is still there for a page opened later, and announced.
	failed(id, name, error) {
		if (this.stopped.delete(id)) {
			return;
		}
		const message = String(error?.message ?? error ?? '').split('\n')[0].trim() || 'Indexing failed.';
		if (this.entry(id)) {
			this.write(id, { failure: message, ready: false });
		} else if (this.positionEntry(id)) {
			this.writePositions(id, { failure: message });
		}
		this.emit('db.failed', { databaseId: id, name, message });
	}

	cancel(id) {
		const run = this.building.get(id);
		if (!run) {
			return false;
		}
		run.stop();
		this.emit('db.changed', {});
		return true;
	}

	// ------------------------------------------------------------------ positions

	// The search databases positions can be built from, with the room each would take.
	async positionCandidates() {
		const { bytes: free } = await this.native.freeSpace().catch(() => ({ bytes: 0 }));
		const databases = [];
		for (const entry of this.entries()) {
			if (this.positionsFor(entry.id)) {
				continue;
			}
			databases.push({
				databaseId: entry.id,
				name: entry.name,
				needed: await this.positionsNeed(entry),
				available:
					entry.ready === true &&
					entry.version === INDEX_VERSION &&
					!this.building.has(entry.id) &&
					!this.copying.has(entry.id),
			});
		}
		return { free, databases };
	}

	// As the desktop's estimate, from the PGN's size; an imported database has only its own size to go by.
	async positionsNeed(entry) {
		const pgn = pgnBytes(entry);
		return Math.round(pgn > 0 ? pgn * POSITIONS_PER_PGN_BYTE : (await this.sizeOf(entry.index)) * 1.3);
	}

	// Listed, and the reason it cannot be given right away if there is one; counting is then started apart.
	async newPositions(databaseId) {
		const search = this.entry(databaseId);
		if (!search) {
			throw coded('NOT_FOUND', `No database with id ${databaseId}`);
		}
		if (this.positionsFor(databaseId)) {
			throw coded('FAILED', 'This database already has its positions.');
		}
		if (search.ready !== true || this.building.has(databaseId) || this.copying.has(databaseId)) {
			throw coded('FAILED', 'Positions can be added once the database has finished indexing.');
		}
		await this.roomFor(await this.positionsNeed(search));

		const id = this.settings.takeDatabaseId();
		const taken = new Set(
			[...this.entries(), ...this.positionEntries()].map((entry) => String(entry.index).toLowerCase()),
		);
		// Beside its search database, under the same name: "/TWIC.sqlite", "/TWIC.positions.sqlite".
		const base = String(search.index).replace(/\.sqlite$/i, '');
		let index = `${base}.positions.sqlite`;
		for (let copy = 2; taken.has(index.toLowerCase()); copy++) {
			index = `${base}.positions (${copy}).sqlite`;
		}
		this.settings.update({
			positionDatabases: [
				...this.positionEntries(),
				{
					id,
					databaseId,
					index,
					combined: false,
					ready: false,
					upTo: 0,
					positions: 0,
					maxPly: search.maxPly ?? DEFAULT_MAX_PLY,
					version: POSITIONS_VERSION,
					failure: null,
					updatedAt: new Date().toISOString(),
				},
			],
		});
		this.emit('db.changed', {});
		return id;
	}

	// Throws when it cannot be done now; otherwise whether it starts from nothing.
	checkUpdate(id) {
		const entry = this.positionEntry(id);
		if (!entry) {
			throw coded('NOT_FOUND', `No position database with id ${id}`);
		}
		const search = this.entry(entry.databaseId);
		if (!search || search.ready !== true || this.building.has(entry.databaseId)) {
			throw coded('FAILED', 'Wait for the database to finish indexing, then update its positions.');
		}
		if (this.building.has(id)) {
			throw coded('FAILED', 'These positions are already being counted.');
		}
		return entry.outdated === true && !entry.combined;
	}

	async countPositions(id, restart) {
		const entry = this.positionEntry(id);
		const search = this.entry(entry.databaseId);
		const file = this.positionFile(entry);
		// The positions file is this run's. The games are only read: where the WebView lets two workers
		// read one file, the database is still searched meanwhile; otherwise searches wait for the run.
		const shared = await this.sharedReading();
		if (!shared) {
			this.reading.add(entry.databaseId);
		}
		// Let go of in any case: a handle left from an import would lock the file.
		await this.worker.request({ op: 'close', file: search.index }).catch(() => undefined);
		await this.worker.request({ op: 'close', file }).catch(() => undefined);
		this.writePositions(id, { failure: null, ...(restart ? { ready: false, upTo: 0, positions: 0 } : {}) });
		this.emit('db.changed', {});
		try {
			const counted = await this.index(
				id,
				{ op: 'positions', index: file, games: search.index, maxPly: entry.maxPly ?? DEFAULT_MAX_PLY, restart },
				{ positions: true },
			);
			this.writePositions(id, {
				positions: counted.positions,
				upTo: counted.upTo,
				version: POSITIONS_VERSION,
				ready: true,
				outdated: false,
				failure: null,
				updatedAt: new Date().toISOString(),
			});
			this.emit('db.changed', {});
			return true;
		} catch (error) {
			// A first count cut short is resumed later; an update cut short leaves the old count usable.
			if (restart || this.positionEntry(id)?.upTo === 0) {
				this.writePositions(id, { ready: false });
			}
			this.failed(id, search?.name ?? null, error);
			this.emit('db.changed', {});
			throw error;
		} finally {
			this.reading.delete(entry.databaseId);
		}
	}

	// As the desktop's Export: a copy of the database, sealed as an export (db/index.worker.ts), saved where
	// the user chooses. Answers with the name it was saved under, or null when the dialog was closed.
	async exportTo(id) {
		const entry = this.entry(id);
		if (!entry) {
			throw coded('NOT_FOUND', 'That database is no longer in the list.');
		}
		if (entry.ready !== true || entry.version !== INDEX_VERSION || this.building.has(id)) {
			throw coded('FAILED', 'Only a database that is fully indexed can be exported.');
		}
		if (this.copying.has(id)) {
			throw coded('FAILED', 'This database is already being copied.');
		}
		const safe = String(entry.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim() || 'Database';
		await this.roomFor(await this.sizeOf(entry.index));
		const picked = await this.native.exportBegin({ name: `${safe}.ppdb`, mime: 'application/octet-stream' });
		if (!picked.saved) {
			return null;
		}

		const part = `/.export-${id}.part`;
		const pace = new Pace();
		const show = (done, total) => {
			const frame = { stage: 'exporting', done, total, ...pace.update('exporting', done, total), at: Date.now(), space: null };
			this.progress.set(id, frame);
			this.emit('db.progress', { databaseId: id, ...frame });
		};
		this.copying.add(id);
		this.keepAwake();
		this.emit('db.changed', {});
		let ok = false;
		try {
			// A handle left from an import would keep the export from reading the file.
			await this.worker.request({ op: 'close', file: entry.index }).catch(() => undefined);
			const names = Object.fromEntries(sourcesOf(entry).filter((one) => one.name).map((one) => [one.path, one.name]));
			// Half the bar for the copy, half for saving it.
			const { bytes } = await runWorker(
				this.createIndexWorker,
				{ op: 'export', index: entry.index, part, maxPly: entry.maxPly ?? DEFAULT_MAX_PLY, names },
				(data) => show(data.done, data.total * 2),
			);
			const file = await (await databaseFolder()).getFileHandle(part.slice(1)).then((handle) => handle.getFile());
			for (let at = 0; at < file.size; at += EXPORT_PIECE) {
				const piece = file.slice(at, Math.min(file.size, at + EXPORT_PIECE));
				await this.native.exportWrite({ token: picked.token, base64: await base64Of(piece) });
				show(bytes + Math.min(file.size, at + EXPORT_PIECE), bytes * 2);
			}
			ok = true;
			return picked.name || `${safe}.ppdb`;
		} finally {
			await this.native.exportEnd({ token: picked.token, ok }).catch(() => undefined);
			await this.worker.request({ op: 'remove', file: part }).catch(() => undefined);
			this.copying.delete(id);
			this.progress.delete(id);
			this.keepAwake();
			this.emit('db.changed', {});
		}
	}

	// A file made by Export on the desktop, copied in as a database of its own. Listed while it
	// copies; it leaves the list again if the file is not a whole, current export.
	async importFrom(file) {
		const { bytes: free } = await this.native.freeSpace().catch(() => ({ bytes: Infinity }));
		if (free < file.size * 1.1) {
			throw coded('FAILED', `Not enough free space: the copy needs ${gigabytes(file.size)} GB.`);
		}

		const id = this.settings.takeDatabaseId();
		const name = file.name.replace(/\.ppdb$/i, '').trim() || `Database ${id}`;
		const taken = new Set(this.entries().map((entry) => entry.index.toLowerCase()));
		const index = fileNameFor(name, taken);
		this.settings.update({
			databases: [
				...this.entries(),
				{
					id,
					name,
					sources: [],
					index,
					failure: null,
					games: 0,
					positions: 0,
					maxPly: DEFAULT_MAX_PLY,
					indexedSources: 0,
					version: INDEX_VERSION,
					ready: false,
					importing: true,
					updatedAt: new Date().toISOString(),
				},
			],
		});
		this.copying.add(id);
		this.keepAwake();
		this.emit('db.changed', {});

		try {
			// The File itself goes to the worker, which copies it in as a stream: no size limit but free space.
			const started = Date.now();
			const found = await this.worker.request(
				{ op: 'import', file: index, source: file },
				{
					onProgress: ({ done, total }) =>
						this.emit('db.progress', { databaseId: id, ...copyProgress('importing', done, total, started) }),
				},
			);
			const { combined, upTo, ...kept } = found;
			this.write(id, {
				...kept,
				indexedSources: found.sources.length,
				ready: true,
				importing: false,
				updatedAt: new Date().toISOString(),
			});
			if (combined) {
				const positionsId = this.settings.takeDatabaseId();
				this.settings.update({
					positionDatabases: [
						...this.positionEntries(),
						{
							id: positionsId,
							databaseId: id,
							index,
							combined: true,
							ready: true,
							upTo,
							positions: found.positions,
							maxPly: found.maxPly,
							version: POSITIONS_VERSION,
							failure: null,
							updatedAt: new Date().toISOString(),
						},
					],
				});
			}
			return card(this.entry(id), await this.sizeOf(index), false);
		} catch (error) {
			this.settings.update({ databases: this.entries().filter((entry) => entry.id !== id) });
			throw error;
		} finally {
			this.copying.delete(id);
			this.keepAwake();
			this.emit('db.changed', {});
		}
	}

	// A database and everything it has here: its file, its journal, the copies of its PGNs.
	async forget(id) {
		const entry = this.entry(id);
		if (!entry) {
			return;
		}
		await this.worker.request({ op: 'remove', file: entry.index }).catch(() => undefined);
		await removePgns(sourcesOf(entry).map((source) => source.path));
		this.settings.update({ databases: this.entries().filter((one) => one.id !== id) });
	}

	async remove(id) {
		const entry = this.entry(id);
		if (!entry) {
			return false;
		}
		if (this.copying.has(id)) {
			throw coded('FAILED', 'Wait for the copy of this database to finish.');
		}
		if (this.building.has(id)) {
			this.cancel(id);
			await settle();
		}
		const positions = this.positionsFor(id);
		if (positions) {
			await this.removePositions(positions.id);
		}
		await this.forget(id);
		this.emit('db.changed', {});
		return true;
	}

	async removePositions(id) {
		const entry = this.positionEntry(id);
		if (!entry) {
			return false;
		}
		if (this.building.has(id)) {
			this.cancel(id);
			await settle();
		}
		if (!entry.combined) {
			await this.worker.request({ op: 'remove', file: entry.index });
		}
		this.settings.update({ positionDatabases: this.positionEntries().filter((one) => one.id !== id) });
		this.emit('db.changed', {});
		return true;
	}

	write(id, patch) {
		this.settings.update({
			databases: this.entries().map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
		});
	}

	readable(id) {
		const entry = this.entry(id);
		if (!entry) {
			throw coded('NOT_FOUND', `No database with id ${id}`);
		}
		if (this.reading.has(id)) {
			throw coded('FAILED', 'Wait for the positions of this database to finish counting.');
		}
		if (entry.ready !== true) {
			throw coded(
				'FAILED',
				this.building.has(id) ? 'This database is still being indexed.' : 'This database is not ready yet.',
			);
		}
		return entry.index;
	}

	ask(databaseId, method, args, channel, positions = null) {
		const index = this.readable(databaseId);
		return this.worker.request({ op: 'query', method, index, positions, args }, { channel: channel ?? null });
	}

	askPositions(positionsId, method, args, channel) {
		const entry = this.positionEntry(positionsId);
		if (!entry) {
			throw coded('NOT_FOUND', `No position database with id ${positionsId}`);
		}
		if (entry.ready !== true || this.building.has(positionsId)) {
			throw coded('FAILED', 'Those positions are still being counted.');
		}
		return this.ask(entry.databaseId, method, args, channel, this.positionFile(entry));
	}

	tree(positionsId, fen, channel) {
		return this.askPositions(positionsId, 'tree', { fen }, channel);
	}

	games(positionsId, fen, sort, ascending, page, size, channel) {
		return this.askPositions(positionsId, 'games', { fen, sort, ascending, page, size }, channel);
	}

	game(databaseId, gameId, channel) {
		return this.ask(databaseId, 'game', { gameId }, channel);
	}

	players(databaseId, q, limit, channel) {
		return this.ask(databaseId, 'players', { q, limit }, channel);
	}

	opponent(databaseId, scope, channel) {
		return this.ask(databaseId, 'opponent', scope, channel);
	}

	opponentGames(databaseId, scope, channel) {
		return this.ask(databaseId, 'opponentGames', scope, channel);
	}

	// From the database's positions when they cover all its games; built from the games otherwise.
	opponentTree(databaseId, scope, channel) {
		const positions = this.positionsFor(databaseId);
		const search = this.entry(databaseId);
		const usable = positions && positions.ready === true && (positions.upTo ?? 0) >= (search?.topId ?? Infinity);
		return this.ask(databaseId, 'opponentTree', scope, channel, usable ? this.positionFile(positions) : null);
	}

	search(databaseId, criteria, channel) {
		return this.ask(databaseId, 'search', criteria, channel);
	}
}

// As database.js card(), with the file's place shown inside the app's storage.
function card(entry, bytes, running) {
	const sources = sourcesOf(entry);
	return {
		id: entry.id,
		name: entry.name,
		// The PGN's own name: its copy in the app has a made-up one.
		path: sources[0]?.name ?? sources[0]?.path ?? '',
		games: entry.games,
		positions: entry.positions,
		maxPly: entry.maxPly,
		location: `${LOCATION}${entry.index}`,
		bytes,
		pgnBytes: pgnBytes(entry),
		ready: entry.ready === true && entry.version === INDEX_VERSION,
		stale: entry.ready === true && entry.version !== INDEX_VERSION,
		// Stopped part way (Stop, the app closed): Resume carries on.
		paused: entry.ready !== true && entry.version === INDEX_VERSION && !running && entry.importing !== true,
		failure: entry.ready === true || running ? null : (entry.failure ?? null),
		updatedAt: entry.updatedAt,
	};
}

function pgnOnly(file) {
	if (!/\.pgn$/i.test(file.name)) {
		throw coded('BAD_REQUEST', `"${file.name}" is not a PGN file: choose a file ending in .pgn.`);
	}
}

function sourcesOf(entry) {
	return Array.isArray(entry?.sources) ? entry.sources : [];
}

function pgnBytes(entry) {
	return sourcesOf(entry).reduce((sum, source) => sum + (source.bytes ?? 0), 0);
}

// Where the copy of a database's nth PGN is kept: "/pgn/12-1.pgn" (db/index.worker.ts keeps it in PGN_FOLDER).
function pgnPath(id, nth) {
	return `/pgn/${id}-${nth}.pgn`;
}

// The databases' folder in the app's storage (db/databases.worker.ts keeps them there).
async function databaseFolder() {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle('premovedprep-databases', { create: true });
}

// The pieces an export is saved in, through the plugin: small enough for one call.
const EXPORT_PIECE = 4 * 1024 * 1024;

function base64Of(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
		reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
		reader.readAsDataURL(blob);
	});
}

async function pgnFolder() {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(PGN_FOLDER, { create: true });
}

async function pgnKept(path) {
	try {
		await (await pgnFolder()).getFileHandle(path.slice(path.lastIndexOf('/') + 1));
		return true;
	} catch {
		return false;
	}
}

async function removePgns(paths) {
	if (paths.length === 0) {
		return;
	}
	const folder = await pgnFolder().catch(() => null);
	for (const path of paths) {
		await folder?.removeEntry(path.slice(path.lastIndexOf('/') + 1)).catch(() => undefined);
	}
}

// A stopped run's worker lets go of its files shortly after it is ended; removing them waits for that.
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 500));
}

// The time left of a run, from its speed in the step it is in (the desktop's estimate.js, simply).
class Pace {
	constructor() {
		this.stage = null;
		this.from = 0;
		this.since = 0;
	}

	update(stage, done, total) {
		const now = Date.now();
		if (stage !== this.stage || done < this.from) {
			this.stage = stage;
			this.from = done;
			this.since = now;
			return { secondsLeft: null };
		}
		const elapsed = (now - this.since) / 1000;
		const rate = elapsed >= 3 ? (done - this.from) / elapsed : 0;
		return { secondsLeft: rate > 0 ? Math.max(0, (total - done) / rate) : null };
	}
}

// The database's name as a file name, unique among the app's databases: "/TGigabase2.sqlite", "/TGigabase2 (2).sqlite".
function fileNameFor(name, taken) {
	let base = String(name)
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(0, 100);
	if (base.length === 0 || RESERVED.test(base)) {
		base = `_${base || 'Database'}`;
	}
	for (let copy = 1; ; copy += 1) {
		const file = copy === 1 ? `/${base}.sqlite` : `/${base} (${copy}).sqlite`;
		if (!taken.has(file.toLowerCase())) {
			return file;
		}
	}
}

// The row's progress during a copy, in the shape the desktop's showProgress() sends (stage, done,
// total, and the time left worked out from the speed so far).
function copyProgress(stage, done, total, started) {
	const elapsed = (Date.now() - started) / 1000;
	const rate = elapsed > 0 ? done / elapsed : 0;
	return {
		stage,
		done,
		total,
		secondsLeft: rate > 0 ? Math.max(0, (total - done) / rate) : null,
		at: Date.now(),
		space: null,
	};
}

function gigabytes(bytes) {
	return (bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1);
}

// The system's file chooser, from the page: the Android counterpart of the desktop's open dialog.
export function pickFile(accept) {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = accept;
		input.style.display = 'none';
		const done = (file) => {
			input.remove();
			resolve(file);
		};
		input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
		input.addEventListener('cancel', () => done(null), { once: true });
		document.body.appendChild(input);
		input.click();
	});
}
