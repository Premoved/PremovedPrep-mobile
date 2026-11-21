// A small SQLite VFS over ordinary files in the app's private storage (OPFS), for the local databases.
// Unlike "opfs-sahpool" it keeps each database as a file of its own name, so one can be copied in or
// out as a stream (databases.worker.ts imports a file itself); unlike "opfs" it needs no
// SharedArrayBuffer, which Android's WebView does not offer.
//
// SQLite's calls are synchronous; OPFS hands out its synchronous access handles asynchronously.
// So a file is opened with acquire() before SQLite opens it, and the VFS only looks it up: read only
// for the queries (databases.worker.ts), writable for indexing (index.worker.ts), which also acquires
// the database's journal. Files SQLite makes for itself (temporary, no name) take a file from the
// pool given with useTemporaryFiles(), or are kept in memory when there is none left.
//
// No locks: each file is written by one worker at a time, which databases.js sees to.

export function installReadOnlyVfs(sqlite3, name = 'premovedprep-ro') {
	const { capi, wasm } = sqlite3;
	const handles = new Map(); // file name → { file: FileSystemSyncAccessHandle, writable }
	const open = new Map(); // sqlite3_file pointer → { file, writable, pooled }
	let pool = []; // free temporary files (FileSystemSyncAccessHandle)

	const ioStruct = new capi.sqlite3_io_methods();
	const vfsStruct = new capi.sqlite3_vfs();
	ioStruct.$iVersion = 1;
	vfsStruct.$iVersion = 2;
	vfsStruct.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
	vfsStruct.$mxPathname = 512;
	vfsStruct.$zName = wasm.allocCString(name);

	const io = {
		xCheckReservedLock(_pFile, pOut) {
			wasm.poke32(pOut, 0);
			return 0;
		},
		xClose(pFile) {
			const entry = open.get(pFile);
			open.delete(pFile);
			if (entry?.pooled) {
				entry.file.truncate(0);
				pool.push(entry.file);
			}
			return 0;
		},
		xDeviceCharacteristics() {
			return capi.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
		},
		xFileControl() {
			return capi.SQLITE_NOTFOUND;
		},
		xFileSize(pFile, pSize) {
			const entry = open.get(pFile);
			if (!entry) {
				return capi.SQLITE_IOERR;
			}
			wasm.poke64(pSize, BigInt(entry.file.getSize()));
			return 0;
		},
		xLock() {
			return 0;
		},
		xRead(pFile, pDest, n, offset) {
			const entry = open.get(pFile);
			if (!entry) {
				return capi.SQLITE_IOERR;
			}
			try {
				const heap = wasm.heap8u();
				const read = entry.file.read(heap.subarray(pDest, pDest + n), { at: Number(offset) });
				if (read < n) {
					heap.fill(0, pDest + read, pDest + n);
					return capi.SQLITE_IOERR_SHORT_READ;
				}
				return 0;
			} catch (error) {
				console.error('[sqlite vfs] read failed', error);
				return capi.SQLITE_IOERR_READ;
			}
		},
		xSectorSize() {
			return 4096;
		},
		xSync(pFile) {
			const entry = open.get(pFile);
			if (entry?.writable && typeof entry.file.flush === 'function') {
				try {
					entry.file.flush();
				} catch (error) {
					console.error('[sqlite vfs] flush failed', error);
					return capi.SQLITE_IOERR_FSYNC;
				}
			}
			return 0;
		},
		xTruncate(pFile, size) {
			const entry = open.get(pFile);
			if (!entry || !entry.writable) {
				return capi.SQLITE_READONLY;
			}
			try {
				entry.file.truncate(Number(size));
				return 0;
			} catch (error) {
				console.error('[sqlite vfs] truncate failed', error);
				return capi.SQLITE_IOERR_TRUNCATE;
			}
		},
		xUnlock() {
			return 0;
		},
		xWrite(pFile, pSource, n, offset) {
			const entry = open.get(pFile);
			if (!entry || !entry.writable) {
				return capi.SQLITE_READONLY;
			}
			try {
				const written = entry.file.write(wasm.heap8u().subarray(pSource, pSource + n), { at: Number(offset) });
				return written === n ? 0 : capi.SQLITE_FULL;
			} catch (error) {
				// Most often the storage is full.
				console.error('[sqlite vfs] write failed', error);
				return capi.SQLITE_FULL;
			}
		},
	};

	const vfs = {
		xAccess(_pVfs, zName, _flags, pOut) {
			const known = handles.get(wasm.cstrToJs(zName));
			wasm.poke32(pOut, known && known.file.getSize() > 0 ? 1 : 0);
			return 0;
		},
		xCurrentTime(_pVfs, pOut) {
			wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, 'double');
			return 0;
		},
		xCurrentTimeInt64(_pVfs, pOut) {
			wasm.poke(pOut, BigInt(Math.round(2440587.5 * 86400000 + Date.now())), 'i64');
			return 0;
		},
		// A journal SQLite is done with: emptied (OPFS removes files only asynchronously).
		xDelete(_pVfs, zName) {
			const known = handles.get(wasm.cstrToJs(zName));
			if (known?.writable) {
				known.file.truncate(0);
				known.file.flush?.();
			}
			return 0;
		},
		xFullPathname(_pVfs, zName, nOut, pOut) {
			const written = wasm.cstrncpy(pOut, zName, nOut);
			return written < nOut ? 0 : capi.SQLITE_CANTOPEN;
		},
		xGetLastError() {
			return 0;
		},
		xOpen(_pVfs, zName, pFile, flags, pOutFlags) {
			const fileName = zName ? wasm.cstrToJs(zName) : null;
			const readOnly = (flags & capi.SQLITE_OPEN_READONLY) !== 0;
			let entry;
			if (fileName && handles.has(fileName)) {
				const known = handles.get(fileName);
				entry = { file: known.file, writable: known.writable && !readOnly, pooled: false };
			} else if (!fileName || (flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0) {
				const spare = pool.pop();
				entry = spare
					? { file: spare, writable: true, pooled: true }
					: { file: new MemoryFile(), writable: true, pooled: false };
				if (spare) {
					spare.truncate(0);
				}
			} else {
				return capi.SQLITE_CANTOPEN;
			}
			open.set(pFile, entry);
			const file = new capi.sqlite3_file(pFile);
			file.$pMethods = ioStruct.pointer;
			file.dispose();
			if (pOutFlags) {
				wasm.poke32(pOutFlags, entry.writable ? flags : capi.SQLITE_OPEN_READONLY);
			}
			return 0;
		},
	};

	// Randomness and sleep as the default VFS does them.
	const fallback = capi.sqlite3_vfs_find(null);
	if (fallback) {
		const base = new capi.sqlite3_vfs(fallback);
		vfsStruct.$xRandomness = base.$xRandomness;
		vfsStruct.$xSleep = base.$xSleep;
		base.dispose();
	}
	if (!vfsStruct.$xRandomness) {
		vfs.xRandomness = (_pVfs, nOut, pOut) => {
			const heap = wasm.heap8u();
			for (let at = 0; at < nOut; at++) {
				heap[pOut + at] = Math.floor(Math.random() * 256);
			}
			return nOut;
		};
	}
	if (!vfsStruct.$xSleep) {
		vfs.xSleep = () => 0;
	}

	sqlite3.vfs.installVfs({
		io: { struct: ioStruct, methods: io },
		vfs: { struct: vfsStruct, methods: vfs },
	});

	return {
		name,
		// The file must stay acquired while SQLite has it open (OPFS allows one handle per file).
		acquire(fileName, handle, { writable = false } = {}) {
			handles.set(fileName, { file: handle, writable });
		},
		release(fileName) {
			const known = handles.get(fileName);
			handles.delete(fileName);
			return known?.file ?? null;
		},
		handle(fileName) {
			return handles.get(fileName)?.file ?? null;
		},
		// Files for SQLite's temporary data (sorting, CREATE INDEX on a large table), in place of memory.
		useTemporaryFiles(files) {
			pool = [...files];
		},
		// The temporary files not in use, for closing after a run.
		takeTemporaryFiles() {
			const free = pool;
			pool = [];
			return free;
		},
	};
}

// A temporary file SQLite asked for when no pooled one is left: kept in memory.
class MemoryFile {
	constructor() {
		this.bytes = new Uint8Array(0);
		this.size = 0;
	}

	getSize() {
		return this.size;
	}

	read(target, { at }) {
		const available = Math.max(0, Math.min(target.length, this.size - at));
		target.set(this.bytes.subarray(at, at + available));
		return available;
	}

	write(source, { at }) {
		const end = at + source.length;
		if (end > this.bytes.length) {
			const grown = new Uint8Array(Math.max(end, this.bytes.length * 2, 64 * 1024));
			grown.set(this.bytes.subarray(0, this.size));
			this.bytes = grown;
		}
		this.bytes.set(source, at);
		this.size = Math.max(this.size, end);
		return source.length;
	}

	truncate(size) {
		this.size = Math.min(this.size, size);
	}
}
