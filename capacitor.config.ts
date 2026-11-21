import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
	// Fixed for good once the app is published (Google Play refuses a change); the same as the desktop appId.
	appId: 'com.premoved.premovedprep',
	appName: 'PremovedPrep',
	webDir: 'www',
	android: {
		// Only the bundled pages; nothing loaded over plain HTTP.
		allowMixedContent: false,
	},
	plugins: {
		// API requests leave from native code instead of the WebView, as the desktop's local proxy does:
		// no CORS, and the HttpOnly refresh cookie kept by Android's cookie manager, out of reach of the page.
		CapacitorHttp: {
			enabled: true,
		},
		CapacitorCookies: {
			enabled: true,
		},
	},
};

export default config;
