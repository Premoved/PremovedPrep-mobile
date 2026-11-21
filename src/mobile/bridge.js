// Android counterpart of PremovedPrep-App/shell/local/bridge.js + the ipcMain handler in main.js:
// the same methods and the same { ok, value } / { ok: false, code, message } answers, so the page's
// AgentBridgeService works unchanged.

import { MOBILE_VERSION } from './version';
import { coded } from './store.js';

import { pickFile } from './databases.js';

export class Bridge {
	constructor({ store, engines, databases, players, native }) {
		this.store = store;
		this.engines = engines;
		this.databases = databases;
		this.native = native;
		this.players = players;
		this.listeners = new Map();
	}

	emit(event, data) {
		for (const handler of [...(this.listeners.get(event) ?? [])]) {
			try {
				handler(data);
			} catch (error) {
				console.error(`A handler of ${event} failed`, error);
			}
		}
	}

	on(event, handler) {
		const handlers = this.listeners.get(event) ?? new Set();
		handlers.add(handler);
		this.listeners.set(event, handlers);
		return () => handlers.delete(handler);
	}

	async request(method, params) {
		const started = performance.now();
		try {
			return { ok: true, value: await this.handle(String(method), params ?? {}) };
		} catch (error) {
			return {
				ok: false,
				code: error && error.code ? error.code : 'FAILED',
				message: error && error.message ? error.message : String(error),
			};
		} finally {
			// Where the time goes, for chrome://inspect (the console of the app's page).
			console.info(`[timing] ${method} ${Math.round(performance.now() - started)} ms`);
		}
	}

	async handle(method, params) {
		const table = this.table();
		// Own properties only: guards against dispatching to constructor/toString on the table.
		const call = Object.hasOwn(table, method) ? table[method] : null;
		if (!call) {
			throw coded('UNKNOWN_METHOD', `No such method: ${method}`);
		}
		return call(params);
	}

	table() {
		const notYet = () => this.databases.notYet();
		return {
			'agent.hello': () => ({
				agent: 'PremovedPrep',
				version: MOBILE_VERSION,
				protocol: 1,
				paired: true,
				bridge: 'embedded',
			}),

			'store.location': () => this.store.location(),
			'store.choose': () => this.chooseFolder(),

			'folder.shelf': ({ kind, color }) => this.store.shelf(kind, color ?? null),
			'folder.create': ({ kind, color, name, icon }) => this.store.createCollection(kind, color ?? null, name, icon),
			'folder.read': ({ collectionId }) => this.store.read(collectionId),
			'folder.adopt': (params) => this.store.adopt(params),
			'folder.rename': ({ collectionId, name }) => this.store.rename(collectionId, name),
			'folder.remove': ({ collectionId }) => this.store.remove(collectionId),
			'folder.pair': ({ collectionId, cloudId }) => this.store.pair(collectionId, cloudId ?? null),
			'folder.icon': ({ collectionId, icon }) => this.store.setIcon(collectionId, icon),
			'folder.order': ({ ids }) => this.store.setOrder(ids),
			'folder.write': ({ collectionId, pgn }) => this.store.write(collectionId, pgn),
			'folder.synced': ({ collectionId, digest }) => this.store.markSynced(collectionId, digest ?? null),
			'folder.append': ({ collectionId, pgn, itemType }) => this.store.append(collectionId, pgn, { itemType }),
			'folder.entryReplace': ({ id, pgn }) => this.store.replaceEntry(id, pgn),
			'folder.entryRemove': ({ id }) => this.store.removeEntry(id),
			'folder.entriesRemove': ({ ids, expected }) => this.store.removeEntries(ids, expected ?? null),
			'folder.entries': ({ collectionId }) => this.store.entries(collectionId),
			'folder.details': ({ collectionId }) => this.store.details(collectionId),
			'folder.entry': async ({ id }) => {
				const entry = await this.store.entry(id);
				if (!entry) {
					throw coded('NOT_FOUND', 'That file is no longer in the folder');
				}
				return entry;
			},

			'engine.list': () => this.engines.list(),
			'engine.choose': () => {
				throw coded('FAILED', 'On Android only the engines shipped with the app can be used.');
			},
			'engine.remove': () => {
				throw coded('FAILED', 'The engines shipped with the app cannot be removed.');
			},
			'engine.open': ({ engineId }) => this.engines.open(engineId),
			'engine.send': ({ sessionId, command }) => {
				this.engines.send(sessionId, command);
				return true;
			},
			'engine.close': ({ sessionId }) => {
				this.engines.close(sessionId);
				return true;
			},

			'db.list': () => this.databases.list(),
			'positions.list': () => this.databases.positionsList(),
			'positions.candidates': () => this.databases.positionCandidates(),
			// As on the desktop: these return the list once the run has started; progress follows as db.progress.
			'db.choose': () => this.chooseDatabase(),
			'db.append': ({ databaseId }) => this.appendToDatabase(databaseId),
			'db.rebuild': async ({ databaseId }) => {
				await this.databases.rebuild(databaseId);
				return this.databases.list();
			},
			'db.resume': ({ databaseId }) => {
				this.databases.resume(databaseId);
				return this.databases.list();
			},
			'db.export': ({ databaseId }) => this.databases.exportTo(databaseId),
			'db.import': () => this.importDatabase(),
			'db.remove': async ({ databaseId }) => {
				await this.databases.remove(databaseId);
				return this.databases.list();
			},
			'db.cancel': ({ databaseId }) => this.databases.cancel(databaseId),
			// The database lives inside the app: there is no folder to show it in.
			'db.reveal': () => true,
			'positions.add': async ({ databaseId }) => {
				const positionsId = await this.databases.newPositions(databaseId);
				void this.databases.countPositions(positionsId, true).catch(() => undefined);
				return this.databases.positionsList();
			},
			'positions.update': ({ positionsId }) => {
				const restart = this.databases.checkUpdate(positionsId);
				void this.databases.countPositions(positionsId, restart).catch(() => undefined);
				return this.databases.positionsList();
			},
			'positions.remove': async ({ positionsId }) => {
				await this.databases.removePositions(positionsId);
				return this.databases.positionsList();
			},
			'positions.cancel': ({ positionsId }) => this.databases.cancel(positionsId),
			'positions.reveal': () => true,
			'db.tree': ({ positionsId, fen, channel }) => this.databases.tree(positionsId, fen, channel),
			'db.players': ({ databaseId, q, limit, channel }) => this.databases.players(databaseId, q, limit, channel),
			'db.opponent': ({ databaseId, channel, ...scope }) => this.databases.opponent(databaseId, scope, channel),
			'db.opponentTree': ({ databaseId, channel, ...scope }) =>
				this.databases.opponentTree(databaseId, scope, channel),
			'db.opponentGames': ({ databaseId, channel, ...scope }) =>
				this.databases.opponentGames(databaseId, scope, channel),
			'db.search': ({ databaseId, channel, ...criteria }) => this.databases.search(databaseId, criteria, channel),
			'db.games': ({ positionsId, fen, sort, ascending, page, size, channel }) =>
				this.databases.games(positionsId, fen, sort, ascending === true, page ?? 0, size ?? 100, channel),
			'db.game': async ({ databaseId, gameId, channel }) => {
				const game = await this.databases.game(databaseId, gameId, channel);
				if (!game) {
					throw coded('NOT_FOUND', 'That game is no longer in the file.');
				}
				return game;
			},

			// The offline FIDE player list (players.js), as on the desktop.
			'players.status': () => this.players.status(),
			'players.update': ({ version, url, format }) => this.players.update({ version, url, format }),
			'players.search': ({ q, limit, channel }) => this.players.search(q, limit, channel),
			'players.profile': ({ fideId }) => this.players.profile(fideId),
			'players.identity': ({ fideId }) => this.players.identity(fideId),
		};
	}

	// The file chooser opens on the click that asked for it (the desktop opens its own dialog here).
	// The system's file chooser in place of the desktop's open dialog, with no filter: Android knows .pgn
	// files under several types, or none. The PGN is copied into the app first.
	async chooseDatabase() {
		const file = await pickFile('');
		if (file) {
			await this.databases.add(file);
		}
		return this.databases.list();
	}

	async appendToDatabase(databaseId) {
		this.databases.notWhileBusy(databaseId);
		const file = await pickFile('');
		if (file) {
			await this.databases.append(databaseId, file);
		}
		return this.databases.list();
	}

	async importDatabase() {
		// No filter: Android knows no type for .ppdb and would grey such files out.
		const file = await pickFile('');
		if (!file) {
			return null;
		}
		return this.databases.importFrom(file);
	}

	// As on the desktop, the parent folder is picked and PremovedPrep/ is created inside it. The system
	// picker opens on Documents, so one tap ("Use this folder") keeps everything in Documents/PremovedPrep.
	async chooseFolder() {
		const picked = await this.native.folderPick();
		if (!picked.picked) {
			return this.store.location();
		}
		this.store.forgetFolder();
		return this.store.ensure();
	}
}
