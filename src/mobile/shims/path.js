// node:path for the bundled desktop modules: "/" paths, which is how the Android app names its files.

export const sep = '/';

export function join(...parts) {
	return normalize(parts.filter((part) => part !== '').join('/'));
}

export function normalize(path) {
	const absolute = path.startsWith('/');
	const out = [];
	for (const name of path.split('/')) {
		if (name === '' || name === '.') {
			continue;
		}
		if (name === '..') {
			out.pop();
		} else {
			out.push(name);
		}
	}
	return `${absolute ? '/' : ''}${out.join('/')}` || (absolute ? '/' : '.');
}

export function dirname(path) {
	const at = path.lastIndexOf('/');
	return at <= 0 ? (at === 0 ? '/' : '.') : path.slice(0, at);
}

export function basename(path, suffix) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export function extname(path) {
	const name = basename(path);
	const at = name.lastIndexOf('.');
	return at <= 0 ? '' : name.slice(at);
}

export function resolve(...parts) {
	return normalize(parts.join('/'));
}

export default { sep, join, normalize, dirname, basename, extname, resolve };
