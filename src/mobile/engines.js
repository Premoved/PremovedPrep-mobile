// Android counterpart of PremovedPrep-App/shell/local/engine.js: the same cards, sessions and command
// allow-list. The processes are started by the plugin (native/android), from the binaries shipped in the
// APK (Stockfish, Lc0); on Android an engine picked by the user cannot be run, so there are only these.

import { MOBILE_VERSION } from './version';

// Lc0 reads its network at the start: on a slow tablet that takes a while.
const PROBE_TIMEOUT_MS = 20_000;

// A closed engine is kept running, idle, so the next start on the Analysis Board answers at once: starting
// one means reading its whole binary (Stockfish carries its networks, about 100 MB), which takes seconds on
// a tablet. One per engine; while idle it keeps the smallest hash.
const PARKED_HASH_MB = 16;
const PARK_READY_MS = 3_000;
// After the app has started, the first engine is started in the background, once the page has settled.
const WARM_AFTER_MS = 4_000;

// Shown until the engine has answered uci with its own name.
const NAMES = { stockfish: 'Stockfish', lc0: 'Lc0' };

const OPTION = /^option name (.+?) type (\w+)(?: .*?)?(?: max (-?\d+))?\s*$/;

export class Engines {
	constructor(settings, native, emit) {
		this.settings = settings;
		this.native = native;
		this.emit = emit;
		this.sessions = new Map();
		// Sessions opened to read an engine's options (probe): their lines go there, not to the page.
		this.probes = new Map();
		// Idle engines kept running, by engine (bundledId): { sessionId, ready }. Their lines go nowhere.
		this.parked = new Map();
		this.idleLines = new Map();
		this.cpus = null;

		void native.addListener('engineLine', ({ sessionId, line }) => {
			const probe = this.probes.get(sessionId);
			const idle = this.idleLines.get(sessionId);
			if (probe) {
				probe(line);
			} else if (idle) {
				idle(line);
			} else if (this.sessions.has(sessionId)) {
				this.emit('engine.line', { sessionId, line });
			}
		});
		void native.addListener('engineClosed', ({ sessionId }) => {
			this.idleLines.delete(sessionId);
			for (const [bundledId, parked] of this.parked) {
				if (parked.sessionId === sessionId) {
					this.parked.delete(bundledId);
				}
			}
			if (this.sessions.delete(sessionId)) {
				this.emit('engine.closed', { sessionId });
			}
		});
	}

	list() {
		return this.settings.value.engines.map((engine) => ({
			id: engine.id,
			name: engine.name,
			reportedName: engine.reportedName ?? null,
			author: engine.author ?? null,
			threads: engine.threads !== false,
			maxThreads: engine.maxThreads ?? this.cpus,
			maxHashMb: engine.maxHashMb ?? null,
			multiPv: engine.multiPv !== false,
			bundled: engine.bundled === true,
		}));
	}

	// The bundled engines, read once per version of the app (an update may bring new versions of them), and
	// not at every start: each read starts the engine. Each keeps its id across starts, so the default chosen
	// on the Engines tab stays chosen.
	async adoptBundled() {
		const info = await this.native.info();
		this.cpus = info.cpus;
		const shipped = Array.isArray(info.engines) ? info.engines : info.engine ? ['stockfish'] : [];
		const known = this.settings.value.engines;
		const readFor = `${MOBILE_VERSION}:${shipped.join(',')}`;
		const adopted = shipped.map((bundledId) =>
			known.find((engine) => engine.bundled === true && (engine.bundledId ?? 'stockfish') === bundledId),
		);
		if (this.settings.value.enginesReadFor === readFor && adopted.every(Boolean)) {
			this.warmSoon(shipped[0]);
			return adopted[0] ?? null;
		}
		const engines = [];
		// One after another: two engines starting at once on a phone slow each other's answer.
		let complete = true;
		for (const bundledId of shipped) {
			const before = known.find((engine) => engine.bundled === true && (engine.bundledId ?? 'stockfish') === bundledId);
			let probed;
			try {
				probed = await this.probe(bundledId);
			} catch (error) {
				console.error(`The bundled engine ${bundledId} did not start`, error);
				complete = false;
				// Slow to answer this once (the app starting, a busy device): one read before stays listed; an
				// engine never read is listed by its name, and read again at the next start.
				engines.push(before ?? { id: this.settings.takeEngineId(), name: NAMES[bundledId] ?? bundledId, bundled: true, bundledId });
				continue;
			}
			engines.push({
				id: before ? before.id : this.settings.takeEngineId(),
				name: probed.reportedName ?? NAMES[bundledId] ?? bundledId,
				bundled: true,
				bundledId,
				...probed,
			});
		}
		// Read again at the next start if one of them did not answer.
		this.settings.update({ engines, enginesReadFor: complete ? readFor : null });
		this.warmSoon(shipped[0]);
		return engines[0] ?? null;
	}

	// The first engine started in the background, once, so the Analysis Board's first start is quick.
	warmSoon(bundledId) {
		if (!bundledId) {
			return;
		}
		setTimeout(() => {
			if (this.parked.has(bundledId) || [...this.sessions.values()].some((one) => one.bundledId === bundledId)) {
				return;
			}
			this.native
				.engineOpen({ engine: bundledId })
				.then(({ sessionId }) => this.park(sessionId, bundledId))
				.catch(() => undefined);
		}, WARM_AFTER_MS);
	}

	// An engine set aside, idle: whatever it was doing is stopped, its hash made small, and it is ready once
	// it answers isready.
	park(sessionId, bundledId) {
		if (this.parked.has(bundledId)) {
			void this.native.engineClose({ sessionId }).catch(() => undefined);
			return;
		}
		let settle;
		const ready = new Promise((resolve) => {
			settle = resolve;
		});
		const timer = setTimeout(() => settle(false), PARK_READY_MS);
		this.idleLines.set(sessionId, (line) => {
			if (line.trim() === 'readyok') {
				clearTimeout(timer);
				settle(true);
			}
		});
		this.parked.set(bundledId, { sessionId, ready });
		for (const command of ['stop', `setoption name Hash value ${PARKED_HASH_MB}`, 'setoption name MultiPV value 1', 'ucinewgame', 'isready']) {
			void this.native.engineSend({ sessionId, command }).catch(() => undefined);
		}
	}

	// The idle engine, if one is kept and still answers: it becomes the page's session.
	async takeParked(bundledId) {
		const parked = this.parked.get(bundledId);
		if (!parked) {
			return null;
		}
		this.parked.delete(bundledId);
		if (!(await parked.ready)) {
			this.idleLines.delete(parked.sessionId);
			void this.native.engineClose({ sessionId: parked.sessionId }).catch(() => undefined);
			return null;
		}
		this.idleLines.delete(parked.sessionId);
		return parked.sessionId;
	}

	async open(engineId) {
		const engine = this.settings.value.engines.find((entry) => entry.id === engineId);
		if (!engine) {
			throw new Error(`No engine with id ${engineId}`);
		}
		const bundledId = engine.bundledId ?? 'stockfish';
		const sessionId = (await this.takeParked(bundledId)) ?? (await this.native.engineOpen({ engine: bundledId })).sessionId;
		this.sessions.set(sessionId, { engineId, bundledId });
		return { sessionId, engineId, engineName: engine.name };
	}

	send(sessionId, command) {
		if (!this.sessions.has(sessionId) || !allowedCommand(command)) {
			return;
		}
		void this.native.engineSend({ sessionId, command }).catch(() => undefined);
	}

	close(sessionId) {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		this.sessions.delete(sessionId);
		// Kept running, idle, for the next start; a second one of the same engine is ended (the plugin sends
		// quit, so the engine frees its hash table, then ends the process).
		if (!this.parked.has(session.bundledId)) {
			this.park(sessionId, session.bundledId);
			return;
		}
		void this.native.engineClose({ sessionId }).catch(() => undefined);
	}

	closeAll() {
		for (const sessionId of [...this.sessions.keys()]) {
			this.close(sessionId);
		}
	}

	probe(bundledId) {
		return new Promise((resolve, reject) => {
			const found = {
				reportedName: null,
				author: null,
				threads: false,
				maxThreads: null,
				maxHashMb: null,
				multiPv: false,
			};
			let sessionId = null;
			let finished = false;

			const done = (error) => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				if (sessionId !== null) {
					this.probes.delete(sessionId);
					void this.native.engineClose({ sessionId }).catch(() => undefined);
				}
				if (error) {
					reject(error);
				} else {
					resolve(found);
				}
			};

			const timer = setTimeout(() => done(new Error('The engine did not answer uci')), PROBE_TIMEOUT_MS);

			this.native
				.engineOpen({ engine: bundledId })
				.then((opened) => {
					sessionId = opened.sessionId;
					if (finished) {
						void this.native.engineClose({ sessionId }).catch(() => undefined);
						return;
					}
					this.probes.set(sessionId, (line) => {
						if (line.startsWith('id name ')) {
							found.reportedName = line.slice(8).trim();
						} else if (line.startsWith('id author ')) {
							found.author = line.slice(10).trim();
						} else if (line.startsWith('option name ')) {
							read(found, line);
						} else if (line.trim() === 'uciok') {
							done(null);
						}
					});
					return this.native.engineSend({ sessionId, command: 'uci' });
				})
				.catch((error) => done(error instanceof Error ? error : new Error(String(error))));
		});
	}
}

function read(found, line) {
	const option = OPTION.exec(line);
	if (!option) {
		return;
	}
	const [, name, , max] = option;
	const ceiling = max === undefined ? null : Number(max);
	if (name === 'Threads') {
		found.threads = true;
		found.maxThreads = ceiling;
	} else if (name === 'Hash') {
		found.maxHashMb = ceiling;
	} else if (name === 'MultiPV') {
		found.multiPv = true;
	}
}

// Allow-listed, as on the desktop: setoption's Debug Log File/EvalFile/SyzygyPath can read or write arbitrary paths.
const SEND_SIMPLE = new Set(['uci', 'isready', 'ucinewgame', 'stop', 'quit', 'ponderhit']);
const SEND_OPTION =
	/^setoption name (Threads|Hash|MultiPV|UCI_ShowWDL|UCI_Chess960|Ponder) value (\d{1,7}|true|false)$/;
const SEND_GO = /^go( (infinite|ponder|(depth|nodes|movetime|mate|movestogo|wtime|btime|winc|binc) \d{1,12}))*$/;
const SEND_POSITION =
	/^position (startpos|fen [pnbrqkPNBRQK1-8/]{15,90} [wb] (-|[KQkqA-Ha-h]{1,4}) (-|[a-h][36])( \d{1,4} \d{1,4})?)( moves( [a-h][1-8][a-h][1-8][qrbn]?){1,1000})?$/;

export function allowedCommand(command) {
	if (typeof command !== 'string' || command.length > 8000 || /[\r\n\0]/.test(command)) {
		return false;
	}
	return SEND_SIMPLE.has(command) || SEND_OPTION.test(command) || SEND_GO.test(command) || SEND_POSITION.test(command);
}
