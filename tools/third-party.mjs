// The third-party notices of the mobile app, served at /licenses/ (the Third-party page reads
// /licenses/THIRD-PARTY.md): this repository's own THIRD-PARTY.md, with this project's LICENSE and the
// GPL-3.0 text that covers Stockfish and Lc0 beside it.
//
// prepare.mjs writes them into .build/public/licenses/ (the build copies them into www/licenses/);
// tools/licenses.mjs adds 3rdpartylicenses.txt after `ng build`.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function writeThirdParty({ root, out, fail }) {
	const source = join(root, 'THIRD-PARTY.md');
	if (!existsSync(source)) {
		fail(`THIRD-PARTY.md is missing at ${source}.`);
	}

	const target = join(out, 'public', 'licenses');
	mkdirSync(target, { recursive: true });
	cpSync(source, join(target, 'THIRD-PARTY.md'));
	cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));

	const gpl = join(root, 'node_modules', '@lichess-org', 'chessground', 'LICENSE');
	if (!existsSync(gpl)) {
		fail('the GPL-3.0 text was not found (node_modules/@lichess-org/chessground/LICENSE): run `npm install` first.');
	}
	cpSync(gpl, join(target, 'GPL-3.0.txt'));
}
