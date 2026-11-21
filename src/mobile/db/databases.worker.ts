/// <reference lib="webworker" />

// The local databases' worker: SQLite (WebAssembly) on ordinary files in the app's private storage
// (OPFS, folder premovedprep-databases), read through opfs-readonly-vfs.js, with the desktop's
// queries.js and its import checks running unchanged on top (src/mobile/core/).
//
// Import copies the file in as a stream: its size is limited by free space, not by memory.
// Queries run one at a time (client.js), as each file has a single OPFS handle.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { useSqlite, DatabaseSync } from './node-sqlite.js';
import { installReadOnlyVfs, ReadOnlyVfs } from './opfs-readonly-vfs.js';
import { NOT_AN_EXPORT, checkImported } from './imported.js';
import queries from '../core/queries.js';
import indexer from '../core/index-worker.js';
import playerQueries from '../core/player-queries.js';

const { Reader, METHODS } = queries;
const { isPrepared } = indexer;

// As the desktop's query-worker.js: these reach the page with their own code.
const PASSED_ON = new Set(['NOT_FOUND', 'BAD_REQUEST', 'UNKNOWN_METHOD', 'NO_POSITIONS', 'NEWER_VERSION']);

const FOLDER = 'premovedprep-databases';

// A progress message at most this often during an import.
const PROGRESS_BYTES = 32 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let vfs: ReadOnlyVfs;

const ready: Promise<void> = (async () => {
	const sqlite3: Any = await (sqlite3InitModule as Any)({
		// prepare.mjs copies the file to the app's root.
		locateFile: (file: string) => `/${file}`,
		print: () => undefined,
		printErr: (...parts: unknown[]) => console.error('[sqlite]', ...parts),
	});
	vfs = installReadOnlyVfs(sqlite3);
	useSqlite(sqlite3, vfs.name);
})();

async function folder(): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(FOLDER, { create: true });
}

// Names as databases.js gives them ("/TWIC.sqlite"): the file in the folder is "TWIC.sqlite".
function fileNameOf(name: string): string {
	return name.replace(/^\/+/, '');
}

async function acquire(name: string): Promise<void> {
	if (vfs.handle(name)) {
		return;
	}
	const handle = await (await folder()).getFileHandle(fileNameOf(name));
	vfs.acquire(name, await readOnlyHandle(handle));
}

// Read only where the WebView allows it (Chromium 121 and later): such handles can be open in several
// workers at once, so a database is still searched while index.worker.ts counts its positions.
async function readOnlyHandle(file: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle> {
	return (file as Any).createSyncAccessHandle({ mode: 'read-only' });
}

// Whether the handles above are really shared: an older WebView ignores the mode and locks the file.
async function sharedReading(): Promise<boolean> {
	const probe = await (await folder()).getFileHandle('.probe', { create: true });
	const handle: Any = await readOnlyHandle(probe);
	try {
		return handle.mode === 'read-only';
	} finally {
		handle.close();
	}
}

function release(name: string): void {
	vfs.release(name)?.close();
}

// One per search database, and one per search database with its positions (as query-worker.js).
const readers = new Map<string, Any>();

// The offline player list: one reader per file (as player-query-worker.js).
const playerReaders = new Map<string, Any>();

async function playerReaderFor(file: string): Promise<Any> {
	let reader = playerReaders.get(file);
	if (!reader) {
		await acquire(file);
		reader = new playerQueries.Reader(file);
		playerReaders.set(file, reader);
	}
	return reader;
}

async function readerFor(index: string, positions: string | null): Promise<Any> {
	const name = `${index}\n${positions ?? ''}`;
	let reader = readers.get(name);
	if (!reader) {
		await acquire(index);
		if (positions && positions !== index) {
			await acquire(positions);
		}
		reader = new Reader(index, positions ?? null);
		readers.set(name, reader);
	}
	return reader;
}

function closeReaders(file: string): void {
	const player = playerReaders.get(file);
	if (player) {
		playerReaders.delete(file);
		try {
			player.close();
		} catch {
			// Already closed.
		}
	}
	for (const [name, reader] of [...readers]) {
		if (name.split('\n').includes(file)) {
			readers.delete(name);
			try {
				reader.close();
			} catch {
				// Already closed.
			}
		}
	}
}

function coded(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

async function handle(message: Any, progress: (done: number, total: number) => void): Promise<unknown> {
	switch (message.op) {
		case 'query': {
			const run = Object.hasOwn(METHODS, message.method) ? METHODS[message.method] : null;
			if (!run) {
				throw coded('UNKNOWN_METHOD', `No such query: ${message.method}`);
			}
			return run(await readerFor(message.index, message.positions ?? null), message.args ?? {});
		}
		case 'players': {
			const run = Object.hasOwn(playerQueries.METHODS, message.method) ? playerQueries.METHODS[message.method] : null;
			if (!run) {
				throw coded('UNKNOWN_METHOD', `No such query: ${message.method}`);
			}
			return run(await playerReaderFor(message.file), message.args ?? {});
		}
		case 'import':
			return importDatabase(message.file, message.source as File, progress);
		case 'remove':
			closeReaders(message.file);
			release(message.file);
			await (await folder()).removeEntry(fileNameOf(message.file)).catch(() => undefined);
			// The journal an indexing run keeps beside it (index.worker.ts).
			await (await folder()).removeEntry(`${fileNameOf(message.file)}-journal`).catch(() => undefined);
			return true;
		case 'close':
			closeReaders(message.file);
			release(message.file);
			return true;
		case 'size':
			return sizeOf(message.file);
		case 'shared':
			return sharedReading().catch(() => false);
		case 'files': {
			const names: string[] = [];
			// keys() is in every Chromium WebView, not yet in TypeScript's DOM types.
			for await (const key of ((await folder()) as Any).keys() as AsyncIterable<string>) {
				names.push(`/${key}`);
			}
			return names;
		}
		default:
			throw coded('UNKNOWN_METHOD', `No such operation: ${message.op}`);
	}
}

async function sizeOf(name: string): Promise<number> {
	const open = vfs.handle(name);
	if (open) {
		return open.getSize();
	}
	try {
		return (await (await (await folder()).getFileHandle(fileNameOf(name))).getFile()).size;
	} catch {
		return 0;
	}
}

// The file is written as it is read, so a database larger than the tablet's memory comes in too.
// Then the desktop's checks (imported.js); a file that fails them is removed again.
async function importDatabase(name: string, source: File, progress: (done: number, total: number) => void): Promise<unknown> {
	closeReaders(name);
	release(name);
	const directory = await folder();
	const handle = await directory.getFileHandle(fileNameOf(name), { create: true });
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
			access.write(value, { at: written });
			written += value.byteLength;
			if (written - reported >= PROGRESS_BYTES) {
				reported = written;
				progress(written, source.size);
			}
		}
		access.flush();
	} catch (error) {
		access.close();
		await directory.removeEntry(fileNameOf(name)).catch(() => undefined);
		throw coded('FAILED', `The file could not be copied: ${(error as Error)?.message ?? error}`);
	}
	vfs.acquire(name, access);
	try {
		return checkImported(DatabaseSync, isPrepared, name, written);
	} catch (error) {
		release(name);
		await directory.removeEntry(fileNameOf(name)).catch(() => undefined);
		throw error;
	}
}

self.onmessage = async ({ data }: MessageEvent) => {
	const { seq } = data;
	const progress = (done: number, total: number) => self.postMessage({ type: 'progress', seq, done, total });
	try {
		await ready;
		const value = await handle(data, progress);
		self.postMessage({ type: 'result', seq, ok: true, value });
	} catch (error: Any) {
		self.postMessage({
			type: 'result',
			seq,
			ok: false,
			code: PASSED_ON.has(error?.code) ? error.code : 'FAILED',
			message: error?.message ?? String(error ?? NOT_AN_EXPORT),
		});
	}
};
