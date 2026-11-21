// Android counterpart of PremovedPrep-App/shell/local/engine.js: the same cards, sessions and command
// allow-list. The processes are started by the plugin (native/android), from the binaries shipped in the
// APK (Stockfish, Lc0); on Android an engine picked by the user cannot be run, so there are only these.

const PROBE_TIMEOUT_MS = 8_000;

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
		this.cpus = null;

		void native.addListener('engineLine', ({ sessionId, line }) => {
			const probe = this.probes.get(sessionId);
			if (probe) {
				probe(line);
			} else if (this.sessions.has(sessionId)) {
				this.emit('engine.line', { sessionId, line });
			}
		});
		void native.addListener('engineClosed', ({ sessionId }) => {
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

	// The bundled engines, read again at every start: an update of the app may bring new versions. Each
	// keeps its id across starts, so the default chosen on the Engines tab stays chosen.
	async adoptBundled() {
		const info = await this.native.info();
		this.cpus = info.cpus;
		const shipped = Array.isArray(info.engines) ? info.engines : info.engine ? ['stockfish'] : [];
		const known = this.settings.value.engines;
		const engines = [];
		// One after another: two engines starting at once on a phone slow each other's answer.
		for (const bundledId of shipped) {
			let probed;
			try {
				probed = await this.probe(bundledId);
			} catch (error) {
				console.error(`The bundled engine ${bundledId} did not start`, error);
				continue;
			}
			const before = known.find((engine) => engine.bundled === true && (engine.bundledId ?? 'stockfish') === bundledId);
			engines.push({
				id: before ? before.id : this.settings.takeEngineId(),
				name: probed.reportedName ?? NAMES[bundledId] ?? bundledId,
				bundled: true,
				bundledId,
				...probed,
			});
		}
		this.settings.update({ engines });
		return engines[0] ?? null;
	}

	open(engineId) {
		const engine = this.settings.value.engines.find((entry) => entry.id === engineId);
		if (!engine) {
			throw new Error(`No engine with id ${engineId}`);
		}
		return this.native.engineOpen({ engine: engine.bundledId ?? 'stockfish' }).then(({ sessionId }) => {
			this.sessions.set(sessionId, { engineId });
			return { sessionId, engineId, engineName: engine.name };
		});
	}

	send(sessionId, command) {
		if (!this.sessions.has(sessionId) || !allowedCommand(command)) {
			return;
		}
		void this.native.engineSend({ sessionId, command }).catch(() => undefined);
	}

	close(sessionId) {
		if (!this.sessions.delete(sessionId)) {
			return;
		}
		// The plugin sends quit, so the engine frees its hash table, then ends the process.
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
