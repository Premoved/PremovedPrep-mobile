// After `ng build`: the list of bundled dependencies Angular writes to www/3rdpartylicenses.txt is put
// beside the other notices, in www/licenses/, where the Third-party page and THIRD-PARTY.md point.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');
const notices = join(WWW, '3rdpartylicenses.txt');

if (!existsSync(notices)) {
	console.warn('licenses: www/3rdpartylicenses.txt was not generated (a development build); nothing copied.');
} else {
	mkdirSync(join(WWW, 'licenses'), { recursive: true });
	copyFileSync(notices, join(WWW, 'licenses', '3rdpartylicenses.txt'));
	console.log('licenses: www/licenses/3rdpartylicenses.txt written.');
}
