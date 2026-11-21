// Android port of PremovedPrep-App/shell/local/store.js. Same collections, sidecars and answers;
// the files live in the folder picked through the Storage Access Framework (files: saf-files.js).
//
// Differences from the desktop, all forced by Android:
// - The user picks the parent folder (Documents is suggested); PremovedPrep/ is created inside it, as
//   on the desktop. Paths are relative to the picked folder, and shown as "Documents/PremovedPrep/...".
// - fs.existsSync / mkdirSync become awaited calls (the files are reached through the plugin).
// - Atomic writes (temp file + rename) are done by the plugin's fsWrite.
// - collectionId hashes the path relative to the picked folder: ids stay per device, as on the desktop.

import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import pgn from './core/pgn.js';
import { basename, dirname } from './paths.js';

const { parseGames, toEntry, compose, convertTypeTo, typeFor, UID_TAG, TYPE_TAG } = pgn;

const ROOT_NAME = 'PremovedPrep';

const DEFAULT_ICON = 'folder';

const SIDECAR_SUFFIX = '.premovedprep.json';

const EMPTY_MAIN_LINE_PGN = `[Event "Main line"]
[Site "?"]
[Date "????.??.??"]
[Round "?"]
[White "?"]
[Black "?"]
[Result "*"]
[${TYPE_TAG} "MAIN_LINE"]

*
`;

// Games per file, kept with the file's size and date: listing a shelf does not read every file again,
// only the ones that changed. Kept across restarts, in the page's storage.
const COUNTS_KEY = 'premovedprep.gameCounts';
const COUNTS_KEPT = 500;

function loadCounts() {
	try {
		const saved = JSON.parse(localStorage.getItem(COUNTS_KEY) ?? '[]');
		return new Map(Array.isArray(saved) ? saved : []);
	} catch {
		return new Map();
	}
}

const LIBRARY = `${ROOT_NAME}/Library`;
const WHITE = `${ROOT_NAME}/Repertoire/White`;
const BLACK = `${ROOT_NAME}/Repertoire/Black`;

export class LocalStore {
	constructor(files, folderState) {
		this.files = files;
		// Asked once: the folder only changes when the user picks another (forgetFolder).
		this.readFolderState = folderState;
		this.knownState = null;
		// Serialises writes, renames and removes so a save can never land between a rename's file
		// move and its sidecar move, or race another save.
		this.queue = Promise.resolve();
		this.counts = loadCounts();
		this.countsSaving = null;
		// Sidecars read while listing a shelf, kept with their size and date like the counts.
		this.sidecars = new Map();
		// Collection id → { file, shelf } where it was last found (placeOf).
		this.places = new Map();
	}

	folderState() {
		if (!this.knownState) {
			this.knownState = this.readFolderState().catch((error) => {
				this.knownState = null;
				throw error;
			});
		}
		return this.knownState;
	}

	// Another folder was picked: nothing known about the old one applies.
	forgetFolder() {
		this.knownState = null;
		this.sidecars.clear();
		this.places.clear();
		this.counts.clear();
		this.saveCounts();
	}

	saveCounts() {
		if (this.countsSaving) {
			return;
		}
		this.countsSaving = setTimeout(() => {
			this.countsSaving = null;
			const kept = [...this.counts].slice(-COUNTS_KEPT);
			try {
				localStorage.setItem(COUNTS_KEY, JSON.stringify(kept));
			} catch {
				// Storage full or refused: the counts are found again next time.
			}
		}, 500);
	}

	serialised(task) {
		const run = this.queue.then(task, task);
		this.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async location() {
		const state = await this.folderState();
		if (!state.chosen || !state.granted || !state.display) {
			return { parent: null, root: null, library: null, white: null, black: null, exists: false };
		}
		const parent = state.display;
		const root = `${parent}/${ROOT_NAME}`;
		return {
			isDefault: state.isDefault === true,
			parent,
			root,
			library: `${root}/Library`,
			white: `${root}/Repertoire/White`,
			black: `${root}/Repertoire/Black`,
			exists: await this.files.exists(ROOT_NAME),
		};
	}

	async ensure() {
		const at = await this.location();
		if (!at.parent) {
			return at;
		}
		for (const directory of [ROOT_NAME, LIBRARY, WHITE, BLACK]) {
			await this.files.mkdirs(directory);
		}
		return this.location();
	}

	async shelves() {
		const state = await this.folderState();
		if (!state.chosen || !state.granted) {
			return [];
		}
		return [
			{ kind: 'LIBRARY', color: null, directory: LIBRARY },
			{ kind: 'REPERTOIRE', color: 'w', directory: WHITE },
			{ kind: 'REPERTOIRE', color: 'b', directory: BLACK },
		];
	}

	async shelfOf(kind, color) {
		return (await this.shelves()).find((entry) => entry.kind === kind && entry.color === (color ?? null)) ?? null;
	}

	async shelf(kind, color) {
		const shelf = await this.shelfOf(kind, color);
		if (!shelf) {
			return [];
		}

		const names = (await this.files.list(shelf.directory).catch(() => null)) ?? [];
		const listed = new Map(names.map((entry) => [entry.name, entry]));

		const collections = [];
		for (const entry of names) {
			if (entry.dir || !entry.name.toLowerCase().endsWith('.pgn')) {
				continue;
			}
			const file = `${shelf.directory}/${entry.name}`;
			this.places.set(collectionId(file), { file, shelf });
			const sidecar = await this.listedSidecar(file, listed.get(basename(sidecarPath(file))));
			collections.push({
				id: collectionId(file),
				kind: shelf.kind,
				color: shelf.color,
				name: entry.name.slice(0, -4),
				relativePath: relative(file),
				itemCount: await this.count(file, entry),
				truncated: false,
				bytes: entry.size,
				updatedAt: new Date(entry.mtime).toISOString(),
				cloudId: sidecar && typeof sidecar.cloudId === 'number' ? sidecar.cloudId : null,
				icon: sidecar && typeof sidecar.icon === 'string' ? sidecar.icon : DEFAULT_ICON,
				syncedDigest: sidecar && typeof sidecar.syncedDigest === 'string' ? sidecar.syncedDigest : null,
				sortOrder: sidecar && Number.isInteger(sidecar.sortOrder) ? sidecar.sortOrder : null,
			});
		}
		// The custom order the user dragged into; files never placed (new, or from before) follow, by name.
		return collections.sort(
			(a, b) =>
				(a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
				a.name.localeCompare(b.name),
		);
	}

	// Custom order of one shelf: each file's place is kept in its own sidecar, so it follows a rename.
	async setOrder(ids) {
		return this.serialised(async () => {
			const list = Array.isArray(ids) ? ids : [];
			for (const [index, id] of list.entries()) {
				const file = await this.fileFor(id);
				if (!file) {
					continue;
				}
				const sidecar = (await this.readSidecar(file)) ?? {};
				if (sidecar.sortOrder !== index) {
					await this.writeSidecar(file, { ...sidecar, sortOrder: index });
				}
			}
			return true;
		});
	}

	async placeOf(id) {
		// Where the id was last seen, if the file is still there: one check instead of listing every shelf.
		const seen = this.places.get(id);
		if (seen) {
			const stat = await this.files.stat(seen.file).catch(() => null);
			if (stat && stat.exists && !stat.dir) {
				return seen;
			}
			this.places.delete(id);
		}
		for (const shelf of await this.shelves()) {
			const names = (await this.files.list(shelf.directory).catch(() => null)) ?? [];
			for (const entry of names) {
				if (entry.dir || !entry.name.toLowerCase().endsWith('.pgn')) {
					continue;
				}
				const file = `${shelf.directory}/${entry.name}`;
				const found = { file, shelf };
				this.places.set(collectionId(file), found);
				if (collectionId(file) === id) {
					return found;
				}
			}
		}
		return null;
	}

	async fileFor(id) {
		const place = await this.placeOf(id);
		return place ? place.file : null;
	}

	async modified(file) {
		const stat = await this.files.stat(file).catch(() => null);
		return stat && stat.exists ? new Date(stat.mtime).toISOString() : null;
	}

	async entries(id) {
		const place = await this.placeOf(id);
		if (!place) {
			return [];
		}
		const when = await this.modified(place.file);
		const text = await this.files.readText(place.file).catch(() => '');
		return parseGames(text).map((game, index) => ({
			...toEntry(`${id}#${index}`, game, place.shelf.kind),
			updatedAt: when,
		}));
	}

	async details(id) {
		const place = await this.placeOf(id);
		if (!place) {
			return [];
		}
		const when = await this.modified(place.file);
		// Not caught: the sync reads through here, and a file it could not read must fail the sync,
		// not be pushed as empty.
		const text = await this.files.readText(place.file);
		const name = basename(place.file).slice(0, -4);

		return parseGames(text).map((game, index) => ({
			...toEntry(`${id}#${index}`, game, place.shelf.kind),
			updatedAt: when,
			collectionId: id,
			collectionName: name,
			pgn: compose(game.tags, game.movetext),
		}));
	}

	async entry(entryId) {
		const [id, at] = String(entryId).split('#');
		const index = Number(at);
		const place = await this.placeOf(id);
		if (!place || !Number.isInteger(index)) {
			return null;
		}
		const text = await this.files.readText(place.file);
		const games = parseGames(text);
		const game = games[index];
		if (!game) {
			return null;
		}
		return {
			...toEntry(entryId, game, place.shelf.kind),
			updatedAt: await this.modified(place.file),
			collectionId: id,
			collectionName: basename(place.file).slice(0, -4),
			kind: place.shelf.kind,
			color: place.shelf.color,
			pgn: compose(game.tags, game.movetext),
		};
	}

	// entry: the file as the shelf listing gave it (size, mtime); the count is reused while they match.
	async count(file, entry) {
		const known = this.counts.get(file);
		if (entry && known && known.size === entry.size && known.mtime === entry.mtime) {
			return known.count;
		}
		const text = await this.files.readText(file).catch(() => '');
		const count = parseGames(text).length;
		if (entry) {
			this.counts.delete(file);
			this.counts.set(file, { size: entry.size, mtime: entry.mtime, count });
			this.saveCounts();
		}
		return count;
	}

	async createCollection(kind, color, name, icon) {
		const shelf = await this.shelfOf(kind, color);
		if (!shelf) {
			throw coded('BAD_REQUEST', 'No storage folder has been chosen on this device');
		}

		const safe = fileName(name);
		const file = `${shelf.directory}/${safe}.pgn`;
		if (await this.files.exists(file)) {
			throw coded('BAD_REQUEST', `There is already a collection called ${safe} here`);
		}

		const contents = shelf.kind === 'REPERTOIRE' ? EMPTY_MAIN_LINE_PGN : '';
		// The icon chosen in the dialog, as setIcon and adopt keep it; none given → the folder.
		const chosen = typeof icon === 'string' && icon.length > 0 ? icon : DEFAULT_ICON;
		await this.writeCollection(file, contents, {
			cloudId: null,
			syncedAt: null,
			icon: chosen,
		});

		const stat = await this.files.stat(file).catch(() => null);
		return {
			id: collectionId(file),
			kind: shelf.kind,
			color: shelf.color,
			name: safe,
			relativePath: relative(file),
			itemCount: parseGames(contents).length,
			truncated: false,
			bytes: stat && stat.exists ? stat.size : 0,
			updatedAt: new Date().toISOString(),
			cloudId: null,
			icon: chosen,
		};
	}

	async read(id) {
		const file = await this.fileFor(id);
		return file ? this.files.readText(file) : null;
	}

	async adopt({ kind, color, name, pgn: text, cloudId, icon }) {
		const shelf = await this.shelfOf(kind, color);
		if (!shelf) {
			throw coded('BAD_REQUEST', 'No storage folder has been chosen on this device');
		}

		// Copying a cloud collection that is already here makes no second copy (a second tap while the
		// first copy is still being written would otherwise make one).
		if (typeof cloudId === 'number') {
			const twin = (await this.shelf(kind, color)).find((collection) => collection.cloudId === cloudId);
			if (twin) {
				throw coded('BAD_REQUEST', `"${twin.name}" is already on this device`);
			}
		}

		let file = `${shelf.directory}/${fileName(name)}.pgn`;
		for (let suffix = 2; await this.files.exists(file); suffix += 1) {
			file = `${shelf.directory}/${fileName(name)} (${suffix}).pgn`;
		}

		await this.writeCollection(file, withTrunk(kind, text ?? ''), {
			cloudId: cloudId ?? null,
			syncedAt: new Date().toISOString(),
			icon: typeof icon === 'string' && icon.length > 0 ? icon : DEFAULT_ICON,
		});
		return {
			id: collectionId(file),
			name: basename(file).slice(0, -4),
			relativePath: relative(file),
		};
	}

	// Not a literal append: the file is read, extended and rewritten whole through writeCollection.
	async append(id, text, stamp = {}) {
		const place = await this.placeOf(id);
		if (!place) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		const file = place.file;
		const existing = parseGames(await this.files.readText(file));
		const added = parseGames(String(text ?? '')).filter(
			(game) => game.plies > 0 || Object.keys(game.tags).length > 0,
		);
		if (added.length === 0) {
			throw coded('BAD_REQUEST', 'That file contains no games');
		}

		for (const game of added) {
			if (!game.tags[TYPE_TAG] && stamp.itemType) {
				game.tags[TYPE_TAG] = convertTypeTo(place.shelf.kind, stamp.itemType);
			}
			game.tags[TYPE_TAG] = typeFor(place.shelf.kind, game.tags);
		}

		await this.writeCollection(file, serialise([...existing, ...added]), await this.readSidecar(file));
		return { added: added.length, total: existing.length + added.length };
	}

	async replaceEntry(entryId, text) {
		const { file, index, games } = await this.locate(entryId);
		const replacement = parseGames(String(text ?? ''));
		if (replacement.length === 0) {
			throw coded('BAD_REQUEST', 'That is not a game');
		}
		const before = games[index].tags;
		for (const name of [UID_TAG, TYPE_TAG]) {
			if (!replacement[0].tags[name] && before[name]) {
				replacement[0].tags[name] = before[name];
			}
		}
		games.splice(index, 1, replacement[0]);
		await this.writeCollection(file, serialise(games), await this.readSidecar(file));
		return true;
	}

	async removeEntry(entryId) {
		const { file, index, games } = await this.locate(entryId);
		games.splice(index, 1);
		await this.writeCollection(file, serialise(games), await this.readSidecar(file));
		return true;
	}

	/**
	 * Several entries of one file in a single rewrite. One by one would not work: removing an entry
	 * renumbers every entry after it. `expected`, when given, is each entry's PGN as it was copied;
	 * an entry that no longer matches (the file changed since) is left in place and reported.
	 */
	async removeEntries(entryIds, expected) {
		const ids = [...new Set((entryIds ?? []).map(String))];
		if (ids.length === 0) {
			return { removed: 0, skipped: 0 };
		}
		const collections = new Set(ids.map((entryId) => entryId.split('#')[0]));
		if (collections.size !== 1) {
			throw coded('BAD_REQUEST', 'Entries from more than one file');
		}
		const file = await this.fileFor([...collections][0]);
		if (!file) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		const games = parseGames(await this.files.readText(file));
		const wanted = new Map();
		(entryIds ?? []).forEach((entryId, at) => wanted.set(String(entryId), expected ? expected[at] : undefined));

		const drop = new Set();
		let skipped = 0;
		for (const [entryId, copied] of wanted) {
			const index = Number(entryId.split('#')[1]);
			const game = Number.isInteger(index) ? games[index] : undefined;
			if (!game || (typeof copied === 'string' && same(compose(game.tags, game.movetext), copied) === false)) {
				skipped++;
				continue;
			}
			drop.add(index);
		}
		if (drop.size > 0) {
			await this.writeCollection(
				file,
				serialise(games.filter((_, index) => !drop.has(index))),
				await this.readSidecar(file),
			);
		}
		return { removed: drop.size, skipped };
	}

	async locate(entryId) {
		const [id, at] = String(entryId).split('#');
		const index = Number(at);
		const file = await this.fileFor(id);
		if (!file || !Number.isInteger(index)) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		const games = parseGames(await this.files.readText(file));
		if (index < 0 || index >= games.length) {
			throw coded('NOT_FOUND', 'That entry is no longer in the file');
		}
		return { file, index, games };
	}

	async write(id, text) {
		const file = await this.fileFor(id);
		if (!file) {
			throw coded('NOT_FOUND', 'That file is no longer in the folder');
		}
		await this.writeCollection(file, String(text ?? ''), await this.readSidecar(file));
		return true;
	}

	async markSynced(id, digest) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const sidecar = (await this.readSidecar(file)) ?? {};
			await this.writeSidecar(file, { ...sidecar, syncedDigest: digest ?? null, syncedAt: new Date().toISOString() });
			return true;
		});
	}

	// Serialised against writeCollection() and remove(): the file move and its sidecar move must
	// not interleave with a save that is reading or rewriting the same collection.
	async rename(id, name) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const target = `${dirname(file)}/${fileName(name)}.pgn`;
			if (target === file) {
				return { id, name: fileName(name) };
			}
			if (await this.files.exists(target)) {
				throw coded('BAD_REQUEST', `There is already a collection called ${fileName(name)} here`);
			}

			const sidecar = await this.readSidecar(file);
			await this.files.rename(file, basename(target));
			await this.files.remove(sidecarPath(file));
			if (sidecar) {
				await this.writeSidecar(target, sidecar);
			}
			return { id: collectionId(target), name: fileName(name) };
		});
	}

	async remove(id) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				return false;
			}
			await this.files.remove(file);
			await this.files.remove(sidecarPath(file));
			return true;
		});
	}

	async setIcon(id, icon) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const sidecar = (await this.readSidecar(file)) ?? {};
			await this.writeSidecar(file, { ...sidecar, icon: typeof icon === 'string' && icon ? icon : DEFAULT_ICON });
			return true;
		});
	}

	async pair(id, cloudId) {
		return this.serialised(async () => {
			const file = await this.fileFor(id);
			if (!file) {
				throw coded('NOT_FOUND', 'That file is no longer in the folder');
			}
			const sidecar = (await this.readSidecar(file)) ?? {};
			await this.writeSidecar(file, {
				...sidecar,
				cloudId: cloudId ?? null,
				syncedDigest: null,
				syncedAt: new Date().toISOString(),
			});
			return true;
		});
	}

	// listed: the sidecar as the shelf listing gave it (size, mtime); read again only when it changed.
	async listedSidecar(file, listed) {
		if (!listed) {
			return null;
		}
		const path = sidecarPath(file);
		const known = this.sidecars.get(path);
		if (known && known.size === listed.size && known.mtime === listed.mtime) {
			return known.value;
		}
		const value = await this.readSidecar(file);
		this.sidecars.set(path, { size: listed.size, mtime: listed.mtime, value });
		return value;
	}

	async readSidecar(file) {
		try {
			return JSON.parse(await this.files.readText(sidecarPath(file)));
		} catch {
			return null;
		}
	}

	async writeSidecar(file, value) {
		this.sidecars.delete(sidecarPath(file));
		await this.files.writeText(sidecarPath(file), `${JSON.stringify(value, null, '\t')}\n`);
	}

	// The plugin writes beside the file and renames over it: an interrupted write leaves the old
	// version. Serialised against rename() and remove() on the same store.
	async writeCollection(file, text, sidecar) {
		return this.serialised(async () => {
			this.counts.delete(file);
			await this.files.mkdirs(dirname(file));
			await this.files.writeText(file, text);
			if (sidecar) {
				await this.writeSidecar(file, sidecar);
			}
		});
	}
}

function sidecarPath(file) {
	return `${file.slice(0, -4)}${SIDECAR_SUFFIX}`;
}

// As on the desktop: relative to the PremovedPrep folder ("Library/Openings.pgn").
function relative(file) {
	return file.slice(ROOT_NAME.length + 1);
}

// Strips characters Windows forbids in a filename and trailing dots/spaces it silently drops. Kept as
// on the desktop: the folder may be copied to a computer, and Android's FAT/exFAT cards refuse them too.
function fileName(name) {
	const cleaned = String(name)
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(0, 120);
	if (cleaned.length === 0) {
		return 'Untitled';
	}
	return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

function withTrunk(kind, text) {
	if (kind !== 'REPERTOIRE') {
		return text;
	}
	const games = parseGames(text);
	const hasTrunk = games.some((game) => typeFor('REPERTOIRE', game.tags) === 'MAIN_LINE');
	if (hasTrunk) {
		return text;
	}
	return games.length === 0 ? EMPTY_MAIN_LINE_PGN : `${EMPTY_MAIN_LINE_PGN}\n${text}`;
}

function serialise(games) {
	return games.map((game) => compose(game.tags, game.movetext)).join('\n');
}

// Whitespace aside: the copy was taken from compose() too, but may have been trimmed on the way.
function same(a, b) {
	const flat = (text) =>
		String(text ?? '')
			.replace(/\s+/g, ' ')
			.trim();
	return flat(a) === flat(b);
}

export function coded(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

// Derived from the path, not stored: changes if the file is renamed.
function collectionId(file) {
	return bytesToHex(sha1(utf8ToBytes(file))).slice(0, 16);
}
