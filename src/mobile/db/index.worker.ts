/// <reference lib="webworker" />

// The indexing worker: the desktop's indexer (index-worker.js, bundled into core/) run unchanged on
// files in the app's private storage (OPFS, folder premovedprep-databases), through the writable side
// of opfs-readonly-vfs.js. One run per worker: databases.js starts one for each run and ends it for
// Stop, and the next run carries on from what was committed, as on the desktop.
//
// A PGN is first copied into the app's storage (folder premovedprep-pgn): the file the user picked may
// not be readable again later, and an index cut short is resumed from its copy. Once every game of a
// database is in, its copies are removed: the games' texts are kept in the database itself.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { DatabaseSync, useSqlite } from './node-sqlite.js';
import { installReadOnlyVfs, ReadOnlyVfs } from './opfs-readonly-vfs.js';
import indexer from '../core/index-worker.js';
import playerList from '../core/player-list-worker.js';
import { EXPORT_FORMAT, INDEX_VERSION } from '../core/database-constants.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FOLDER = 'premovedprep-databases';
const PGN_FOLDER = 'premovedprep-pgn';
const TEMP_FOLDER = 'premovedprep-tmp';
// SQLite's own temporary files (sorting for an index): a few, reused.
const TEMP_FILES = 4;
// A progress message at most this often while a PGN is copied in.
const PROGRESS_BYTES = 16 * 1024 * 1024;

// The indexer gives its game facts to count workers in a SharedArrayBuffer; Android has none, and
// counts on this thread (shims/process-global.js), where a plain buffer does the same.
if (typeof SharedArrayBuffer === 'undefined') {
	(globalThis as Any).SharedArrayBuffer = ArrayBuffer;
}

// Shared with the shims inside the indexer's bundle (shims/fs.js, shims/worker_threads.js).
const fsShared: { files: Map<string, File>; remover: ((file: string) => void) | null } = ((globalThis as Any).__premovedFs ??=
	{ files: new Map(), remover: null });
const parentShared: { sink: ((message: Any) => void) | null } = ((globalThis as Any).__premovedParent ??= {
	sink: null,
});

let vfs: ReadOnlyVfs;

const ready: Promise<void> = (async () => {
	const sqlite3: Any = await (sqlite3InitModule as Any)({
		locateFile: (file: string) => `/${file}`,
		print: () => undefined,
		printErr: (...parts: unknown[]) => console.error('[sqlite]', ...parts),
	});
	vfs = installReadOnlyVfs(sqlite3, 'premovedprep-rw');
	useSqlite(sqlite3, vfs.name);
})();

async function directory(name: string): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(name, { create: true });
}

// "/TWIC.sqlite" → "TWIC.sqlite"; "/pgn/12-1.pgn" → "12-1.pgn" (each kind has its folder).
function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function coded(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

const acquired: FileSystemSyncAccessHandle[] = [];

// The database and its journal, writable: SQLite opens them by these names.
async function acquireWritable(name: string): Promise<void> {
	const folder = await directory(FOLDER);
	for (const file of [name, `${name}-journal`]) {
		const handle = await (await folder.getFileHandle(baseName(file), { create: true })).createSyncAccessHandle();
		acquired.push(handle);
		vfs.acquire(file, handle, { writable: true });
	}
}

async function acquireReadOnly(name: string): Promise<void> {
	const folder = await directory(FOLDER);
	// Read only, shared with the query worker where the WebView allows it (see databases.worker.ts).
	const handle: FileSystemSyncAccessHandle = await ((await folder.getFileHandle(baseName(name))) as Any).createSyncAccessHandle({
		mode: 'read-only',
	});
	acquired.push(handle);
	vfs.acquire(name, handle);
}

async function useTemporaryFiles(): Promise<void> {
	const folder = await directory(TEMP_FOLDER);
	const files: FileSystemSyncAccessHandle[] = [];
	for (let at = 0; at < TEMP_FILES; at++) {
		const handle = await (await folder.getFileHandle(`temp-${at}`, { create: true })).createSyncAccessHandle();
		handle.truncate(0);
		acquired.push(handle);
		files.push(handle);
	}
	vfs.useTemporaryFiles(files);
}

// The picked PGN, copied into the app's storage under the path the indexer is given.
async function copyIn(path: string, source: File, progress: (done: number, total: number) => void): Promise<void> {
	const folder = await directory(PGN_FOLDER);
	const handle = await folder.getFileHandle(baseName(path), { create: true });
	const access = await handle.createSyncAccessHandle();
	let written = 0;
	try {
		access.truncate(0);
		const reader = source.stream().getReader();
		let reported = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const wrote = access.write(value, { at: written });
			if (wrote !== value.byteLength) {
				throw new Error('the storage is full');
			}
			written += value.byteLength;
			if (written - reported >= PROGRESS_BYTES) {
				reported = written;
				progress(written, source.size);
			}
		}
		access.flush();
	} catch (error) {
		access.close();
		await folder.removeEntry(baseName(path)).catch(() => undefined);
		throw coded('FAILED', `The PGN could not be copied into the app: ${(error as Error)?.message ?? error}`);
	}
	access.close();
	progress(written, source.size);
}

// Each PGN the run reads, from its copy.
async function register(sources: { path: string; bytes: number }[]): Promise<void> {
	const folder = await directory(PGN_FOLDER);
	for (const source of sources) {
		try {
			const file = await (await folder.getFileHandle(baseName(source.path))).getFile();
			fsShared.files.set(source.path, file);
		} catch {
			// Not here: the indexer only reads files not yet done, and says which one is missing.
		}
	}
}

async function removePgns(paths: string[]): Promise<void> {
	const folder = await directory(PGN_FOLDER);
	for (const path of paths) {
		await folder.removeEntry(baseName(path)).catch(() => undefined);
	}
}

// The files a database was already built from, as its own source table lists them. A database imported
// from a desktop export knows its PGNs by their paths on that computer, which the app has no entry for:
// they are kept first, in their order (all read, so none is read again), and the new ones follow.
function knownSources(index: string): { path: string; bytes: number }[] {
	// Writable: a run cut short left its journal, and opening the file is what rolls it back.
	const db = new DatabaseSync(index);
	try {
		const listed = db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'source'`).get();
		return listed ? db.prepare('SELECT path, bytes FROM source ORDER BY id').all() : [];
	} finally {
		db.close();
	}
}

async function indexGames(message: Any, post: (data: Any) => void): Promise<unknown> {
	const { index, incoming = [], restart = false } = message;
	for (const one of incoming as { path: string; file: File }[]) {
		await copyIn(one.path, one.file, (done, total) => post({ type: 'progress', stage: 'importing', done, total }));
	}
	await acquireWritable(index);
	const sources: { path: string; bytes: number }[] = restart ? [] : knownSources(index);
	for (const source of message.sources as { path: string; bytes: number }[]) {
		if (!sources.some((known) => known.path === source.path)) {
			sources.push(source);
		}
	}
	await register(sources);
	await useTemporaryFiles();
	// Started again from nothing: the indexer removes the old file first.
	fsShared.remover = (file: string) => {
		const handle = vfs.handle(file);
		if (handle) {
			handle.truncate(0);
			handle.flush();
		}
	};
	// The indexer reports after its first 2000 games: until then the row shows the run has started.
	post({ type: 'progress', stage: 'reading', done: 0, total: 1 });
	const result: Any = await indexer.build({ mode: 'games', sources, index, restart });
	// Every game is in the database now, with its text: the copies are not needed any more.
	await removePgns(sources.map((source) => source.path).filter((path) => path.startsWith('/pgn/')));
	return { ...result, sources };
}

async function indexPositions(message: Any, post: (data: Any) => void): Promise<unknown> {
	const { index, games, maxPly, restart = false } = message;
	await acquireWritable(index);
	if (games !== index) {
		await acquireReadOnly(games);
	}
	await useTemporaryFiles();
	fsShared.remover = (file: string) => {
		const handle = vfs.handle(file);
		if (handle) {
			handle.truncate(0);
			handle.flush();
		}
	};
	post({ type: 'progress', stage: 'reading', done: 0, total: 1 });
	return indexer.build({ mode: 'positions', index, games, maxPly, restart });
}

// A copy of a search database, made into an export as the desktop's seal() does: one file, marked as an
// export, its PGNs known by their names only. The page then saves it where the user chose.
async function exportDatabase(message: Any, post: (data: Any) => void): Promise<unknown> {
	const { index, part, maxPly, names = {} } = message;
	const folder = await directory(FOLDER);
	// Read only, beside the queries where the WebView allows it (see databases.worker.ts).
	const source: FileSystemSyncAccessHandle = await ((await folder.getFileHandle(baseName(index))) as Any).createSyncAccessHandle({
		mode: 'read-only',
	});
	acquired.push(source);
	const target = await (await folder.getFileHandle(baseName(part), { create: true })).createSyncAccessHandle();
	acquired.push(target);
	target.truncate(0);

	const total = source.getSize();
	const buffer = new Uint8Array(4 << 20);
	let done = 0;
	let reported = 0;
	while (done < total) {
		const read = source.read(buffer, { at: done });
		if (read <= 0) {
			throw coded('FAILED', 'The database could not be read.');
		}
		if (target.write(buffer.subarray(0, read), { at: done }) !== read) {
			throw coded('FAILED', 'Not enough free space for the export.');
		}
		done += read;
		if (done - reported >= 32 * 1024 * 1024 || done === total) {
			reported = done;
			post({ type: 'progress', stage: 'exporting', done, total });
		}
	}
	target.flush();

	vfs.acquire(part, target, { writable: true });
	const journal = await (await folder.getFileHandle(`${baseName(part)}-journal`, { create: true })).createSyncAccessHandle();
	acquired.push(journal);
	vfs.acquire(`${part}-journal`, journal, { writable: true });
	const db = new DatabaseSync(part);
	try {
		db.exec('PRAGMA journal_mode = DELETE');
		const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
		set.run('export', EXPORT_FORMAT);
		set.run('indexVersion', INDEX_VERSION);
		set.run('maxPly', maxPly);
		const rename = db.prepare('UPDATE source SET path = ? WHERE id = ?');
		for (const row of db.prepare('SELECT id, path FROM source').all()) {
			rename.run(names[row.path] ?? String(row.path).split(/[\\/]/).pop(), row.id);
		}
	} finally {
		db.close();
	}
	return { bytes: target.getSize() };
}

// The offline FIDE player list, built by the desktop's own builder (player-list-worker.js) from the
// file the page downloaded (url: its address inside the app), into a database of its own.
async function buildPlayers(message: Any): Promise<unknown> {
	const { url, file, version, format } = message;
	if (format !== playerList.FORMAT) {
		throw coded('FAILED', 'The player list is in a format this version does not read. Update the application.');
	}
	await acquireWritable(file);
	fsShared.remover = (name: string) => {
		const handle = vfs.handle(name);
		if (handle) {
			handle.truncate(0);
			handle.flush();
		}
	};
	return playerList.build({ url, target: file, version });
}

function closeAll(): void {
	for (const handle of acquired.splice(0)) {
		try {
			handle.flush();
			handle.close();
		} catch {
			// Already closed.
		}
	}
}

self.onmessage = async ({ data }: MessageEvent) => {
	const { seq } = data;
	const post = (message: Any) => self.postMessage({ ...message, seq });
	// The indexer's own messages: progress for the row, log lines for the console.
	parentShared.sink = (message: Any) => {
		if (message?.type === 'progress') {
			post({ type: 'progress', stage: message.stage, done: message.done, total: message.total });
		} else if (message?.type === 'log') {
			console.info(`[index] ${message.text}`);
		}
	};
	try {
		await ready;
		let value: unknown;
		if (data.op === 'games') {
			value = await indexGames(data, post);
		} else if (data.op === 'positions') {
			value = await indexPositions(data, post);
		} else if (data.op === 'export') {
			value = await exportDatabase(data, post);
		} else if (data.op === 'players') {
			value = await buildPlayers(data);
		} else if (data.op === 'removePgns') {
			value = await removePgns(data.paths ?? []);
		} else {
			throw coded('UNKNOWN_METHOD', `No such operation: ${data.op}`);
		}
		closeAll();
		post({ type: 'result', ok: true, value });
	} catch (error: Any) {
		closeAll();
		console.error('[index] failed', error);
		post({ type: 'result', ok: false, code: error?.code ?? 'FAILED', message: error?.message ?? String(error) });
	}
};
