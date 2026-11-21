// Android counterpart of PremovedPrep-App/shell/local/settings.js: the same value and methods, kept in
// the WebView's localStorage (the app's private data) instead of local-resources.json.

const KEY = 'premovedprep.local-resources';

const EMPTY = {
	engines: [],
	databases: [],
	// The positions of search databases, each built from one of them.
	positionDatabases: [],
	nextEngineId: 1,
	nextDatabaseId: 1,
};

export class Settings {
	constructor() {
		this.value = this.read();
	}

	read() {
		try {
			return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? 'null') };
		} catch {
			// Missing or corrupt: fall back to defaults.
			return { ...EMPTY };
		}
	}

	save() {
		localStorage.setItem(KEY, JSON.stringify(this.value));
	}

	update(patch) {
		this.value = { ...this.value, ...patch };
		this.save();
		return this.value;
	}

	takeEngineId() {
		const id = this.value.nextEngineId;
		this.update({ nextEngineId: id + 1 });
		return id;
	}

	takeDatabaseId() {
		const id = this.value.nextDatabaseId;
		this.update({ nextDatabaseId: id + 1 });
		return id;
	}
}
