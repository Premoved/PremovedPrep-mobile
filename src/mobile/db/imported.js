// The checks of the desktop's opened() (database.js) on an imported export: the same tables, versions
// and completeness, the same messages. DatabaseSync and isPrepared are passed in, so the checks run on
// SQLite WebAssembly in the worker and on node:sqlite in the tests.

import { DEFAULT_MAX_PLY, EXPORT_FORMAT, INDEX_VERSION, LAYOUT } from '../core/database-constants.js';

export const NOT_AN_EXPORT = 'This file is not a database exported from PremovedPrep.';
const INCOMPLETE = 'This file is not a whole export. Export the database again and import the new file.';

function coded(code, message) {
	return Object.assign(new Error(message), { code });
}

export function checkImported(DatabaseSync, isPrepared, file, size) {
	let db;
	try {
		db = new DatabaseSync(file);
	} catch {
		throw coded('FAILED', NOT_AN_EXPORT);
	}
	try {
		const tableIn = (name) =>
			db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
		const metaIn = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

		let layout;
		try {
			layout = db.prepare('PRAGMA user_version').get().user_version;
		} catch {
			throw coded('FAILED', NOT_AN_EXPORT);
		}
		if (!['game', 'source', 'meta'].every((table) => tableIn(table)) || metaIn('export') === null) {
			throw coded('FAILED', NOT_AN_EXPORT);
		}
		const version = metaIn('indexVersion');
		if (metaIn('export') > EXPORT_FORMAT || version > INDEX_VERSION || layout > LAYOUT) {
			throw coded(
				'NEWER_VERSION',
				'This database was exported by a newer version of PremovedPrep. Update the app, then import it again.',
			);
		}
		if (version !== INDEX_VERSION || layout !== LAYOUT) {
			throw coded(
				'FAILED',
				'This database was exported by an older version of PremovedPrep. Export it again from the latest version.',
			);
		}
		const pages = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
		if (size < pages || !isPrepared(db)) {
			throw coded('FAILED', INCOMPLETE);
		}
		const rows = db.prepare('SELECT id, path, bytes, done FROM source ORDER BY id').all();
		if (rows.some((row, at) => row.id !== at + 1 || row.done !== 1)) {
			throw coded('FAILED', INCOMPLETE);
		}
		const games = db.prepare('SELECT COUNT(*) AS n FROM game').get().n;
		const topId = db.prepare('SELECT MAX(id) AS top FROM game').get().top ?? 0;
		// Exported from a database that kept its positions in its own file: they come with it.
		const combined = tableIn('bucket') && tableIn('pos_00');
		const positions = combined ? db.prepare('SELECT COALESCE(SUM(positions), 0) AS n FROM bucket').get().n : 0;
		const upTo = combined ? (metaIn('gamesUpTo') ?? topId) : 0;
		if (combined && metaIn('gamesUpTo') === null) {
			try {
				db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('gamesUpTo', ?)`).run(upTo);
			} catch {
				// Opened read only (the Android app): upTo is kept in the settings entry all the same.
			}
		}
		const maxPly = Number(metaIn('maxPly') ?? DEFAULT_MAX_PLY);
		return {
			sources: rows.map((row) => ({ path: row.path, bytes: row.bytes })),
			games,
			topId,
			positions,
			maxPly,
			combined,
			upTo,
		};
	} catch (error) {
		if (error?.code) {
			throw error;
		}
		throw coded('FAILED', NOT_AN_EXPORT);
	} finally {
		db.close();
	}
}
