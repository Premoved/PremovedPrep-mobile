// node:crypto for the desktop modules bundled into the app (tools/shell-modules.mjs): only what
// they use. SHA-1 builds the position keys; it must give the desktop's bytes, or a database made
// on the desktop would not be found by the same positions here.

import { sha1 } from '@noble/hashes/legacy.js';

export function createHash(algorithm) {
	if (algorithm !== 'sha1') {
		throw new Error(`createHash('${algorithm}') is not available in the Android app`);
	}
	const parts = [];
	const hash = {
		update(data, encoding) {
			parts.push(typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : data);
			return hash;
		},
		digest(encoding) {
			const out = Buffer.from(sha1(Buffer.concat(parts)));
			return encoding ? out.toString(encoding) : out;
		},
	};
	return hash;
}

export function randomUUID() {
	return globalThis.crypto.randomUUID();
}

export default { createHash, randomUUID };
