// Paths inside the picked folder: names joined by "/".

export function dirname(path) {
	const at = path.lastIndexOf('/');
	return at === -1 ? '' : path.slice(0, at);
}

export function basename(path) {
	return path.slice(path.lastIndexOf('/') + 1);
}
