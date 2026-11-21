#!/usr/bin/env node
// Run once after `npx cap add android` (npm run android:add does it), and again any time: every
// change is made only if it is not there yet.
//
//   1. Native libraries are extracted at install (useLegacyPackaging): the engines are run as
//      processes from nativeLibraryDir, which holds nothing when libraries stay packed in the APK.
//   2. versionName / versionCode follow package.json (0.1.0 -> 0.1.0 / 100).
//   3. The launcher icon and the splash screen are the app's own (resources/android/res, made from the
//      desktop app's build/icon.png), copied over the ones Capacitor generates.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const RESOURCES = path.join(ROOT, 'resources', 'android', 'res');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

if (!existsSync(GRADLE)) {
	if (existsSync(`${GRADLE}.kts`)) {
		fail('android/app/build.gradle.kts: this script edits the Groovy build.gradle. Add the two changes by hand (see README).');
	}
	fail('android/app/build.gradle is missing: run `npx cap add android` first.');
}

const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
const code = major * 10000 + minor * 100 + patch;

let text = readFileSync(GRADLE, 'utf8');
const before = text;

text = text.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${version}"`);

const MARK = '// PremovedPrep: native libraries extracted at install';
if (!text.includes(MARK)) {
	text += `
${MARK} (the engines run as processes from nativeLibraryDir).
android {
    packagingOptions {
        jniLibs {
            useLegacyPackaging true
        }
    }
}
`;
}

if (text !== before) {
	writeFileSync(GRADLE, text);
	console.log(`android/app/build.gradle updated (version ${version}, code ${code}).`);
} else {
	console.log('android/app/build.gradle already up to date.');
}

if (existsSync(RESOURCES)) {
	await cp(RESOURCES, RES, { recursive: true, force: true });
	console.log('Launcher icon and splash screen copied into android/app/src/main/res.');
} else {
	console.warn('resources/android/res is missing: the launcher icon stays Capacitor\'s.');
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
