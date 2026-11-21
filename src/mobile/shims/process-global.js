// process as a global, as Node has it, for the bundled desktop modules (esbuild inject). The indexer
// reads its settings from it: no count workers on Android (the positions are counted on the indexing
// thread, as the desktop does when it has none), and the platform for its path comparisons.

export const process = {
	env: { INDEX_COUNTERS: '0' },
	platform: 'android',
	versions: {},
	nextTick(callback, ...args) {
		queueMicrotask(() => callback(...args));
	},
};
