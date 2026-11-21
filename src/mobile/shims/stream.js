// node:stream for the bundled desktop modules: only what the player list's builder uses,
// Readable.fromWeb(body).pipe(zlib.createGunzip()), over the browser's own streams.

export const Readable = {
	fromWeb(stream) {
		return {
			pipe(transform) {
				return transform.attach(stream);
			},
		};
	},
};

export default { Readable };
