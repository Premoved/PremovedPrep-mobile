#!/usr/bin/env node
// Puts the engines for Android where the plugin looks for them: the plugin's jniLibs, so Android
// installs them in nativeLibraryDir, the one place an app may run a binary from.
//
//   libstockfish.so, libstockfish_dotprod.so   Stockfish (ARMv8, ARMv8 with Dot Product). The release
//                                              is the desktop's: its tag is read from
//                                              PremovedPrep-App/tools/fetch-engine.mjs.
//   liblc0.so                                  Leela Chess Zero, taken from the Android APK of its
//                                              official release, which carries the network inside the
//                                              binary.
//
// First choice: the same engines built with 16 KB page alignment, which run on devices with 4 KB and with
// 16 KB pages (.github/workflows/engines.yml publishes them in this repository's release
// engines-<Stockfish tag>-lc0-<Lc0 tag>). Until that release exists, the official builds above, which
// run only on 4 KB devices; PREMOVEDPREP_ENGINES_FROM=official takes those in any case.
//
// The binaries are GPL-3.0 and stay out of the repository, as on the desktop.
// PREMOVEDPREP_ENGINES=stockfish fetches Stockfish alone.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = process.env.PREMOVEDPREP_DESKTOP
	? path.resolve(ROOT, process.env.PREMOVEDPREP_DESKTOP)
	: existsSync(path.join(ROOT, 'desktop', 'package.json'))
		? path.join(ROOT, 'desktop')
		: path.resolve(ROOT, '../PremovedPrep-App');
const STOCKFISH = 'official-stockfish/Stockfish';
const LC0 = 'LeelaChessZero/lc0';
const LC0_TAG = 'v0.32.1';
const OWN = 'Premoved/PremovedPrep-mobile';
const INTO = path.join(ROOT, 'native', 'android', 'src', 'main', 'jniLibs', 'arm64-v8a');
const WANTED = (process.env.PREMOVEDPREP_ENGINES ?? 'stockfish,lc0').split(',').map((name) => name.trim());

function desktopTag() {
	const script = path.join(DESKTOP, 'tools', 'fetch-engine.mjs');
	if (existsSync(script)) {
		const found = /const TAG = '([^']+)'/.exec(readFileSync(script, 'utf8'));
		if (found) {
			return found[1];
		}
	}
	console.warn('The desktop app was not found; using sf_19.');
	return 'sf_19';
}

await rm(INTO, { recursive: true, force: true });
await mkdir(INTO, { recursive: true });

if (!(await ownBuilds())) {
	await stockfish();
	if (WANTED.includes('lc0')) {
		await lc0();
	}
}
checkPages();

// The 16 KB builds of this repository's Engines workflow, if they are published for these versions.
async function ownBuilds() {
	if (process.env.PREMOVEDPREP_ENGINES_FROM === 'official') {
		return false;
	}
	const tag = `engines-${desktopTag()}-lc0-${LC0_TAG}`;
	const release = await pick(OWN, tag, true);
	const assets = release?.assets ?? [];
	const wanted = ['libstockfish.so', 'libstockfish_dotprod.so', ...(WANTED.includes('lc0') ? ['liblc0.so'] : [])];
	const found = wanted.map((name) => assets.find((asset) => asset.name === name));
	if (!release || found.some((asset) => !asset)) {
		console.warn(`No 16 KB engine builds yet (release ${tag} of ${OWN}): taking the official builds.`);
		return false;
	}
	for (const asset of found) {
		console.log(`Downloading ${asset.name} (${tag})...`);
		await download(asset.browser_download_url, path.join(INTO, asset.name));
		console.log(`  -> ${path.relative(ROOT, path.join(INTO, asset.name))}`);
	}
	return true;
}

// Whether each binary also runs on a device with 16 KB memory pages: every loaded segment must allow it.
function checkPages() {
	const PAGE = 16 * 1024;
	for (const name of readdirSync(INTO)) {
		const data = readFileSync(path.join(INTO, name));
		const phoff = Number(data.readBigUInt64LE(0x20));
		const size = data.readUInt16LE(0x36);
		const count = data.readUInt16LE(0x38);
		let fits = true;
		for (let i = 0; i < count; i++) {
			const at = phoff + i * size;
			if (data.readUInt32LE(at) !== 1) {
				continue;
			}
			const offset = data.readBigUInt64LE(at + 8);
			const vaddr = data.readBigUInt64LE(at + 16);
			const align = data.readBigUInt64LE(at + 48);
			if (align < BigInt(PAGE) || offset % BigInt(PAGE) !== vaddr % BigInt(PAGE)) {
				fits = false;
			}
		}
		console.log(fits ? `${name}: runs with 4 KB and 16 KB pages` : `${name}: 4 KB pages only (not for Google Play)`);
	}
}

async function stockfish() {
	const release = await pick(STOCKFISH, desktopTag());
	const assets = release.assets ?? [];
	const named = (pattern) => assets.find((asset) => pattern.test(asset.name));

	// A universal build picks its instruction set itself (from sf_19: stockfish-android-arm64-universal.tar.gz);
	// before it, the two ARMv8 builds.
	const universal =
		named(/^stockfish-android-arm64-universal\b/i) ??
		named(/^stockfish-android-armv8-universal\b/i) ??
		named(/^stockfish-android-universal\b/i);
	const wanted = universal
		? [{ asset: universal, as: 'libstockfish.so' }]
		: [
				{ asset: named(/^stockfish-android-armv8\.(tar|zip|tar\.gz)$/i), as: 'libstockfish.so' },
				{ asset: named(/^stockfish-android-armv8-dotprod\.(tar|zip|tar\.gz)$/i), as: 'libstockfish_dotprod.so' },
			];

	if (!wanted[0].asset) {
		fail(`Release ${release.tag_name} has no Android ARMv8 build. Assets: ${assets.map((a) => a.name).join(', ')}`);
	}

	for (const { asset, as } of wanted) {
		if (!asset) {
			continue;
		}
		await inWorkFolder(async (work) => {
			const archive = path.join(work, asset.name);
			console.log(`Downloading ${asset.name} (${release.tag_name})...`);
			await download(asset.browser_download_url, archive);
			execFileSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' });
			const binary = await findBinary(work, archive);
			await place(binary, as);
		});
	}
}

// The APK is a zip; the engine inside is an ordinary Android executable named like a library.
async function lc0() {
	const release = await pick(LC0, LC0_TAG);
	const asset = (release.assets ?? []).find((entry) => /^lc0-.*-android\.apk$/i.test(entry.name));
	if (!asset) {
		fail(`Lc0 ${release.tag_name} has no Android APK. Assets: ${(release.assets ?? []).map((a) => a.name).join(', ')}`);
	}
	await inWorkFolder(async (work) => {
		const apk = path.join(work, asset.name);
		console.log(`Downloading ${asset.name}...`);
		await download(asset.browser_download_url, apk);
		const member = 'lib/arm64-v8a/liblc0.so';
		try {
			// Windows' tar (bsdtar) reads zip files; elsewhere unzip does.
			execFileSync('tar', ['-xf', apk, '-C', work, member], { stdio: 'inherit' });
		} catch {
			execFileSync('unzip', ['-o', '-q', apk, member, '-d', work], { stdio: 'inherit' });
		}
		await place(path.join(work, ...member.split('/')), 'liblc0.so');
	});
}

async function place(binary, as) {
	await copyFile(binary, path.join(INTO, as));
	console.log(`  -> ${path.relative(ROOT, path.join(INTO, as))}`);
}

async function inWorkFolder(task) {
	const work = await mkdtemp(path.join(tmpdir(), 'premovedprep-engine-'));
	try {
		await task(work);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function pick(repo, tag, optional = false) {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
		headers: {
			'user-agent': 'premovedprep-build',
			accept: 'application/vnd.github+json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	if (optional && response.status === 404) {
		return null;
	}
	if (!response.ok) {
		const rate = response.headers.get('x-ratelimit-remaining') === '0' ? ' The rate limit is spent; set GITHUB_TOKEN.' : '';
		fail(`GitHub answered ${response.status} for ${repo} ${tag}.${rate}`);
	}
	return response.json();
}

async function download(url, to) {
	const response = await fetch(url, { headers: { 'user-agent': 'premovedprep-build' }, redirect: 'follow' });
	if (!response.ok || !response.body) {
		fail(`Downloading ${url} answered ${response.status}.`);
	}
	await pipeline(response.body, createWriteStream(to));
}

// The downloaded archive shares the `stockfish-` prefix, so it is excluded by path.
async function findBinary(root, archive) {
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (full !== archive && /^stockfish(-[\w-]+)?$/i.test(entry.name)) {
				return full;
			}
		}
	}
	fail('The archive held no stockfish binary.');
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
