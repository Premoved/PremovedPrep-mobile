// node:zlib for the bundled desktop modules: raw deflate with a preset dictionary, which the
// browser's CompressionStream does not offer. Game texts packed on the desktop unpack here, and
// the other way round.

import * as exported from 'pako';

// pako 2 has named exports; an older CommonJS build only a default one.
const pako = exported.inflateRaw ? exported : exported.default;

function withDictionary(options) {
	return options && options.dictionary ? { dictionary: options.dictionary } : undefined;
}

export function deflateRawSync(input, options) {
	return Buffer.from(pako.deflateRaw(input, withDictionary(options)));
}

export function inflateRawSync(input, options) {
	return Buffer.from(pako.inflateRaw(input, withDictionary(options)));
}

// The player list arrives gzipped: the browser's own DecompressionStream, read as chunks of bytes
// (shims/stream.js and shims/readline.js pass it on).
export function createGunzip() {
	return {
		attach(stream) {
			const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
			return {
				async *[Symbol.asyncIterator]() {
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) {
								return;
							}
							yield value;
						}
					} finally {
						reader.releaseLock();
					}
				},
			};
		},
	};
}

export default { deflateRawSync, inflateRawSync, createGunzip };
