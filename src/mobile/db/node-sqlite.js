// node:sqlite for the bundled desktop modules: the DatabaseSync and StatementSync they use, over the
// official SQLite WebAssembly build (oo1 API), which is synchronous inside a worker as node:sqlite is.
// The worker calls useSqlite() once SQLite is loaded, with the VFS the database files live in.
//
// Kept on globalThis: each bundled desktop module (core/queries.js, core/index-worker.js) has its own
// copy of this file, and the worker reaches another; all of them must use the SQLite it loaded.
const shared = (globalThis.__premovedSqlite ??= { sqlite: null });

export function useSqlite(sqlite3, vfs) {
	shared.sqlite = { sqlite3, vfs };
}

export class DatabaseSync {
	constructor(location, options = {}) {
		const sqlite = shared.sqlite;
		if (!sqlite) {
			throw new Error('SQLite is not loaded yet');
		}
		this.location = String(location);
		this.db = new sqlite.sqlite3.oo1.DB(this.location, options.readOnly ? 'r' : 'c', sqlite.vfs);
		// Sorting and temporary tables in memory: the VFS has no folder for SQLite's own temporary files.
		this.db.exec('PRAGMA temp_store = MEMORY');
	}

	exec(sql) {
		this.db.exec(forAndroid(String(sql)));
	}

	// node:sqlite's flag: inside BEGIN ... COMMIT.
	get isTransaction() {
		return shared.sqlite.sqlite3.capi.sqlite3_get_autocommit(this.db.pointer) === 0;
	}

	prepare(sql) {
		return new StatementSync(this, sql);
	}

	// node:sqlite takes the arity from the function itself unless varargs is set.
	function(name, options, fn) {
		const callback = typeof options === 'function' ? options : fn;
		const settings = typeof options === 'function' ? {} : (options ?? {});
		this.db.createFunction(name, (_context, ...args) => callback(...args), {
			arity: settings.varargs ? -1 : callback.length,
			deterministic: settings.deterministic === true,
			directOnly: settings.directOnly === true,
		});
	}

	close() {
		this.db.close();
	}
}

// The desktop indexer's settings, as the VFS here can take them (opfs-vfs.js):
// - a rollback journal (TRUNCATE) in place of WAL, which needs shared memory the VFS does not offer.
//   An interrupted transaction is still undone at the next open, so a cut-short run resumes;
// - no helper threads for sorting (WebAssembly SQLite has none);
// - half the desktop's page cache (128 MB there), for a tablet's memory.
const REWRITES = [
	[/PRAGMA\s+journal_mode\s*=\s*WAL/gi, 'PRAGMA journal_mode = TRUNCATE'],
	[/PRAGMA\s+threads\s*=\s*\d+/gi, 'PRAGMA threads = 0'],
	[/PRAGMA\s+cache_size\s*=\s*-131072/gi, 'PRAGMA cache_size = -65536'],
];

function forAndroid(sql) {
	let out = sql;
	for (const [pattern, replacement] of REWRITES) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

class StatementSync {
	constructor(owner, sql) {
		this.owner = owner;
		this.statement = owner.db.prepare(sql);
		this.arrays = false;
	}

	setReturnArrays(enabled) {
		this.arrays = enabled === true;
	}

	bind(args) {
		this.statement.reset(true);
		if (args.length === 0) {
			return;
		}
		// Named parameters as node:sqlite takes them: an object, keys with or without their prefix.
		if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array)) {
			const named = {};
			for (const [key, value] of Object.entries(args[0])) {
				named[/^[:@$]/.test(key) ? key : `:${key}`] = value;
			}
			this.statement.bind(named);
			return;
		}
		this.statement.bind(args.map((value) => (typeof value === 'boolean' ? Number(value) : value)));
	}

	row() {
		return this.statement.get(this.arrays ? [] : {});
	}

	get(...args) {
		this.bind(args);
		try {
			return this.statement.step() ? this.row() : undefined;
		} finally {
			this.statement.reset();
		}
	}

	all(...args) {
		this.bind(args);
		try {
			const rows = [];
			while (this.statement.step()) {
				rows.push(this.row());
			}
			return rows;
		} finally {
			this.statement.reset();
		}
	}

	run(...args) {
		this.bind(args);
		try {
			this.statement.step();
		} finally {
			this.statement.reset();
		}
		const { capi } = shared.sqlite.sqlite3;
		return {
			changes: capi.sqlite3_changes(this.owner.db.pointer),
			lastInsertRowid: capi.sqlite3_last_insert_rowid(this.owner.db.pointer),
		};
	}

	*iterate(...args) {
		this.bind(args);
		try {
			while (this.statement.step()) {
				yield this.row();
			}
		} finally {
			this.statement.reset();
		}
	}
}

export default { DatabaseSync };
