// node:fs for the bundled desktop modules, on Android.
//
// The queries read everything from the database itself: a PGN beside it (games indexed before their
// text was kept inside) is missing, as a deleted file would be on the desktop.
//
// The indexer reads the PGNs it is given (createReadStream). db/index.worker.ts copies each one into
// the app's storage and registers it here under the path the indexer is given, before a run. rmSync
// (an index started again from nothing) is passed to the same worker, which empties the file.

import { Buffer } from 'buffer';

// Kept on globalThis: the indexer's bundle (core/index-worker.js) has its own copy of this module, and
// db/index.worker.ts registers through another; both must see the same files.
const shared = (globalThis.__premovedFs ??= { files: new Map(), remover: null });
const files = shared.files;

export function registerFile(path, file) {
	files.set(path, file);
}

export function unregisterFile(path) {
	files.delete(path);
}

export function setRemover(handler) {
	shared.remover = handler;
}

function missing(file) {
	const error = new Error(`ENOENT: no such file, open '${file}'`);
	error.code = 'ENOENT';
	return error;
}

export function existsSync(file) {
	return files.has(file);
}

export function openSync(file) {
	throw missing(file);
}

export function statSync(file) {
	const found = files.get(file);
	if (!found) {
		throw missing(file);
	}
	return { size: found.size, isFile: () => true, isDirectory: () => false };
}

export function fstatSync() {
	throw missing('');
}

export function readSync() {
	throw missing('');
}

export function closeSync() {}

export function rmSync(file) {
	shared.remover?.(file);
}

// Room is checked on the page before a run (the plugin's freeSpace): here it is unknown, so "enough".
export function statfsSync() {
	return { bavail: Number.MAX_SAFE_INTEGER, bsize: 1 };
}

export function createReadStream(file, { start = 0 } = {}) {
	const found = files.get(file);
	if (!found) {
		throw missing(file);
	}
	return {
		async *[Symbol.asyncIterator]() {
			const reader = found.slice(start).stream().getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						return;
					}
					yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				}
			} finally {
				reader.releaseLock();
			}
		},
	};
}

export default {
	existsSync,
	openSync,
	statSync,
	fstatSync,
	readSync,
	closeSync,
	rmSync,
	statfsSync,
	createReadStream,
	registerFile,
	unregisterFile,
	setRemover,
};
