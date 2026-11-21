// The file operations store.js needs, over the folder picked through Android's Storage Access
// Framework. Paths are relative to that folder, with "/" between names.

import { Native } from './native';

// Each call is timed in the console ([timing] fs.*), to see what the folder costs on a device.
async function timed(name, path, call) {
	const started = performance.now();
	try {
		return await call();
	} finally {
		console.info(`[timing] fs.${name} ${path} ${Math.round(performance.now() - started)} ms`);
	}
}

export const files = {
	// null when the folder does not exist.
	async list(path) {
		const listed = await timed('list', path, () => Native.fsList({ path }));
		return listed.exists ? listed.entries : null;
	},
	stat: (path) => timed('stat', path, () => Native.fsStat({ path })),
	async exists(path) {
		return (await timed('stat', path, () => Native.fsStat({ path }))).exists;
	},
	async readText(path) {
		return (await timed('read', path, () => Native.fsRead({ path }))).text;
	},
	writeText: (path, text) => timed('write', path, () => Native.fsWrite({ path, text })),
	rename: (path, name) => timed('rename', path, () => Native.fsRename({ path, name })),
	remove: (path) => timed('remove', path, () => Native.fsRemove({ path })),
	mkdirs: (path) => timed('mkdirs', path, () => Native.fsMkdirs({ path })),
};
