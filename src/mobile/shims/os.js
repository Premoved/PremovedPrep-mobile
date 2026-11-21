// node:os for the bundled desktop modules: the number of cores, for how many workers to start.

function cores() {
	return Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1);
}

export function availableParallelism() {
	return cores();
}

export function cpus() {
	return Array.from({ length: cores() }, () => ({ model: '', speed: 0 }));
}

export function homedir() {
	return '';
}

export function tmpdir() {
	return '/tmp';
}

export const EOL = '\n';

export default { availableParallelism, cpus, homedir, tmpdir, EOL };
