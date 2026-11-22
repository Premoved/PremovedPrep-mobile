// Builds .build/: the desktop app's sources with this repository's Android files over them.
//
//   1. PremovedPrep-App/src and /public are copied to .build/ (read only: the desktop app is never written).
//   2. This repository's src/ is copied over them: whole files that differ on Android, and src/mobile/.
//   3. The edits in tools/patches.mjs are applied; each must match exactly once.
//   4. Desktop shell modules are bundled from the desktop app as ES modules into .build/src/mobile/core/,
//      unchanged, so the logic stays the desktop's (tools/shell-modules.mjs).
//   5. SQLite's WebAssembly file is copied to .build/public/, and the indexer's replay worker bundled there.
//   6. The third-party notices are written to .build/public/licenses/ (tools/third-party.mjs).
//
// The desktop app is looked for in PREMOVEDPREP_DESKTOP, else in desktop/ (the git submodule), else in
// ../PremovedPrep-App beside this folder.
// `--check` stops after step 3: it only tells whether this repository still fits the desktop app.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PATCHES } from './patches.mjs';
import { bundleReplayWorker, bundleShellModules, writeConstants } from './shell-modules.mjs';
import { writeThirdParty } from './third-party.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = process.env.PREMOVEDPREP_DESKTOP
	? resolve(ROOT, process.env.PREMOVEDPREP_DESKTOP)
	: existsSync(join(ROOT, 'desktop', 'package.json'))
		? join(ROOT, 'desktop')
		: resolve(ROOT, '../PremovedPrep-App');
const OUT = join(ROOT, '.build');
const CHECK = process.argv.includes('--check');

function fail(message) {
	console.error(`prepare: ${message}`);
	process.exit(1);
}

function desktopInfo() {
	const manifest = join(DESKTOP, 'package.json');
	if (!existsSync(manifest)) {
		fail(`the desktop app was not found at ${DESKTOP}. Set PREMOVEDPREP_DESKTOP to its folder.`);
	}
	const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
	if (pkg.name !== 'premovedprep-app') {
		fail(`${DESKTOP} is not PremovedPrep-App (package name ${pkg.name}).`);
	}
	let commit = null;
	try {
		commit = execFileSync('git', ['-C', DESKTOP, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		// Not a git checkout, or git missing: the version alone is recorded.
	}
	return { version: pkg.version, commit };
}

function copyTrees() {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	cpSync(join(DESKTOP, 'src'), join(OUT, 'src'), { recursive: true });
	cpSync(join(DESKTOP, 'public'), join(OUT, 'public'), { recursive: true });
	mkdirSync(join(OUT, 'tools'), { recursive: true });
	cpSync(join(DESKTOP, 'tools', 'postcss-touch-hover.cjs'), join(OUT, 'tools', 'postcss-touch-hover.cjs'));
	if (!existsSync(join(OUT, 'public', 'piece')) || !existsSync(join(OUT, 'public', 'board'))) {
		fail('the desktop app has no public/piece or public/board yet: run `npm run assets` in PremovedPrep-App first.');
	}
	cpSync(join(ROOT, 'src'), join(OUT, 'src'), { recursive: true });
}

function applyPatches() {
	const problems = [];
	for (const patch of PATCHES) {
		const file = join(OUT, patch.file);
		if (!existsSync(file)) {
			problems.push(`${patch.file}: the file is gone (${patch.why})`);
			continue;
		}
		const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
		const found = text.split(patch.find).length - 1;
		if (found !== 1) {
			problems.push(`${patch.file}: the text to change was found ${found} times instead of once (${patch.why})`);
			continue;
		}
		writeFileSync(file, text.replace(patch.find, () => patch.replace));
	}
	if (problems.length > 0) {
		fail(`the desktop app changed where this repository edits it:\n  - ${problems.join('\n  - ')}\nUpdate tools/patches.mjs.`);
	}
}

async function bundleShell() {
	let esbuild;
	try {
		esbuild = await import('esbuild');
	} catch {
		fail('esbuild is missing: run `npm install` first.');
	}
	const mobileSrc = join(OUT, 'src', 'mobile');
	await bundleShellModules({
		esbuild,
		desktop: DESKTOP,
		mobileSrc,
		out: join(mobileSrc, 'core'),
		// The desktop's own node_modules may be missing (a submodule checkout): this repository's are used.
		nodePaths: [join(ROOT, 'node_modules')],
	});
	await bundleReplayWorker({
		esbuild,
		desktop: DESKTOP,
		mobileSrc,
		outFile: join(OUT, 'public', 'replay-worker.js'),
		nodePaths: [join(ROOT, 'node_modules')],
	});
	try {
		writeConstants({ desktop: DESKTOP, out: join(mobileSrc, 'core') });
	} catch (error) {
		fail(error.message);
	}
}

function copyWasm() {
	// SQLite's WebAssembly file, served at /sqlite3.wasm (db.worker.ts tells SQLite where it is).
	const found = findFile(join(ROOT, 'node_modules', '@sqlite.org', 'sqlite-wasm'), 'sqlite3.wasm');
	if (!found) {
		fail('sqlite3.wasm was not found in node_modules/@sqlite.org/sqlite-wasm: run `npm install` first.');
	}
	cpSync(found, join(OUT, 'public', 'sqlite3.wasm'));
}

function findFile(directory, name) {
	if (!existsSync(directory)) {
		return null;
	}
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isFile() && entry.name === name) {
			return full;
		}
		if (entry.isDirectory()) {
			const inside = findFile(full, name);
			if (inside) {
				return inside;
			}
		}
	}
	return null;
}

function writeVersion(desktop) {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	writeFileSync(
		join(OUT, 'src', 'mobile', 'version.ts'),
		[
			'// Generated by tools/prepare.mjs. Do not edit.',
			`export const MOBILE_VERSION = ${JSON.stringify(pkg.version)};`,
			`export const DESKTOP_VERSION = ${JSON.stringify(desktop.version)};`,
			`export const DESKTOP_COMMIT = ${JSON.stringify(desktop.commit)};`,
			'',
		].join('\n'),
	);
}

const desktop = desktopInfo();
copyTrees();
applyPatches();
if (CHECK) {
	console.log(`prepare: fits PremovedPrep-App ${desktop.version}${desktop.commit ? ` (${desktop.commit})` : ''}.`);
	process.exit(0);
}
await bundleShell();
copyWasm();
writeThirdParty({ root: ROOT, out: OUT, fail });
writeVersion(desktop);
console.log(
	`prepare: .build/ ready from PremovedPrep-App ${desktop.version}${desktop.commit ? ` (${desktop.commit})` : ''}.`,
);
