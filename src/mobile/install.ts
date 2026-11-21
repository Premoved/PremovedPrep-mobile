// The Android counterpart of the desktop's preload.js: window.premovedDesktop, before the page starts.
// Only inside the Android app; in a plain browser (ng serve) the page stays the web version.

import { Capacitor } from '@capacitor/core';

import { DesktopApi } from '../app/core/shell/desktop-bridge';
import { Bridge } from './bridge.js';
import { Databases } from './databases.js';
import { DatabaseWorker } from './db/client.js';
import { Engines } from './engines.js';
import { files } from './saf-files.js';
import { Native } from './native';
import { Players } from './players.js';
import { Settings } from './settings.js';
import { LocalStore } from './store.js';
import { MOBILE_VERSION } from './version';

// As on the desktop: only a web address or mailto is handed to the system; anything else is dropped.
const HANDS_OVER = /^(https?:\/\/|mailto:)/i;

function install(): void {
	// mobile.css keys every Android-only rule on this class, so the same styles stay inert in a browser.
	document.documentElement.classList.add('android');
	guardLongPress();

	const settings = new Settings();
	const store = new LocalStore(files, () => Native.folderState());
	let bridge: Bridge | null = null;
	const engines = new Engines(settings, Native, (event: string, data: unknown) => bridge?.emit(event, data));
	const worker = new DatabaseWorker(
		() => new Worker(new URL('./db/databases.worker', import.meta.url), { type: 'module' }),
	);
	const databases = new Databases(
		settings,
		worker,
		Native,
		(event: string, data: unknown) => bridge?.emit(event, data),
		// One per indexing run (db/index.worker.ts): Stop ends it.
		() => new Worker(new URL('./db/index.worker', import.meta.url), { type: 'module' }),
	);
	const players = new Players(
		settings,
		worker,
		Native,
		(event: string, data: unknown) => bridge?.emit(event, data),
		() => new Worker(new URL('./db/index.worker', import.meta.url), { type: 'module' }),
		// The download inside the app, at an address of the page's own origin.
		(path: string) => Capacitor.convertFileSrc(path),
	);
	bridge = new Bridge({ store, engines, databases, players, native: Native });
	const local = bridge;

	// Read at every start, as the desktop adopts its bundled engine; the page asks engine.list later.
	const ready = engines.adoptBundled().catch((error: unknown) => {
		console.error('The bundled engine could not be read', error);
		return null;
	});
	void store.ensure().catch(() => undefined);

	const answerers = new Map<string, () => unknown>();

	// The desktop asks "unsaved" before its window closes; answering also flushes drafts. Android
	// gives no such moment, so the drafts are flushed each time the app goes to the background.
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState !== 'hidden') {
			return;
		}
		const answer = answerers.get('unsaved');
		if (answer) {
			void Promise.resolve()
				.then(answer)
				.catch(() => undefined);
		}
	});

	const api: DesktopApi = {
		version: MOBILE_VERSION,
		platform: 'android',
		arch: 'arm64',
		// Android shows one page at a time: the desktop's tab bar is hidden (mobile.css), nothing overlays it.
		titleBarHeight: 0,
		setTitleBarColors: async (color: string) => {
			await Native.systemBars({ darkBackground: isDark(color) }).catch(() => undefined);
			return true;
		},
		onAsk: (question: string, answer: () => unknown) => {
			answerers.set(question, answer);
			return () => answerers.delete(question);
		},
		bridge: {
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === 'engine.list') {
					await ready;
				}
				return local.request(method, params);
			},
			on: (event: string, handler: (data: unknown) => void) => local.on(event, handler),
		},
	};
	window.premovedDesktop = api;

	// Links the page opens in a new window go to the system browser, as on the desktop.
	window.open = ((url?: string | URL) => {
		const href = url === undefined ? '' : String(url);
		if (HANDS_OVER.test(href) && !href.startsWith(window.location.origin)) {
			void Native.openExternal({ url: href }).catch(() => undefined);
		}
		return null;
	}) as typeof window.open;
}

// A long press is the touch stand-in for hovering: the page answers it (contextmenu) with its own
// tooltip. Three things Android adds get in the way:
//  - Chrome starts a native drag of the link, image or draggable row under the finger and paints its
//    ghost behind the tooltip; the page, told a drag began, greys the row or card and never hears that it
//    ended. Nothing in the app is dragged by touch, so drags are refused before the page sees them.
//  - Lifting the finger sends the compatibility mouse and focus events: the first time a button is
//    pressed it also "enters" it (mouseover, focus) and the tooltips redraw themselves as plain hover
//    tooltips, which a touch screen hides; then leave, blur or click close them. From the long press until
//    a moment after the finger is lifted, these are kept from the page. Later taps are not affected.
const AFTER_RELEASE_MS = 600;
const STIRS_TOOLTIPS = [
	'mouseover',
	'mouseenter',
	'mouseout',
	'mouseleave',
	'pointerover',
	'pointerenter',
	'pointerout',
	'pointerleave',
	'focus',
	'focusin',
	'blur',
	'focusout',
	'click',
	'scroll',
];

function guardLongPress(): void {
	window.addEventListener(
		'dragstart',
		(event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
		},
		{ capture: true },
	);

	let holding = false;
	let releasedAt = -Infinity;
	window.addEventListener('contextmenu', () => (holding = true), { capture: true });
	const release = (): void => {
		if (holding) {
			holding = false;
			releasedAt = performance.now();
		}
	};
	// Not pointercancel: Chrome sends it when the long press is recognised, while the finger is still down.
	for (const type of ['pointerup', 'touchend', 'touchcancel']) {
		window.addEventListener(type, release, { capture: true, passive: true });
	}
	// A new press starts afresh.
	window.addEventListener('pointerdown', () => (releasedAt = -Infinity), { capture: true, passive: true });

	for (const type of STIRS_TOOLTIPS) {
		window.addEventListener(
			type,
			(event) => {
				if (holding || performance.now() - releasedAt < AFTER_RELEASE_MS) {
					event.stopImmediatePropagation();
					if (type === 'click') {
						event.preventDefault();
					}
				}
			},
			{ capture: true },
		);
	}
}

// "#rrggbb" darker than mid-grey: light icons on the system bars.
function isDark(color: string): boolean {
	const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
	if (!hex) {
		return false;
	}
	const value = parseInt(hex[1], 16);
	const r = (value >> 16) & 255;
	const g = (value >> 8) & 255;
	const b = value & 255;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

if (Capacitor.getPlatform() === 'android') {
	install();
}
