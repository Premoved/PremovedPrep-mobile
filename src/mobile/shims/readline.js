// node:readline for the bundled desktop modules: createInterface over a stream of bytes, as the
// player list's builder reads the server's file line by line (player-list-worker.js).

export function createInterface({ input }) {
	return {
		async *[Symbol.asyncIterator]() {
			const decoder = new TextDecoder();
			let held = '';
			for await (const chunk of input) {
				held += decoder.decode(chunk, { stream: true });
				let at = held.indexOf('\n');
				while (at !== -1) {
					yield held.slice(0, at > 0 && held[at - 1] === '\r' ? at - 1 : at);
					held = held.slice(at + 1);
					at = held.indexOf('\n');
				}
			}
			held += decoder.decode();
			if (held.length > 0) {
				yield held;
			}
		},
	};
}

export default { createInterface };
