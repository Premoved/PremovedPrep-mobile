export const environment = {
	production: true,
	// Absolute on Android: the requests leave through CapacitorHttp (native code), as the desktop's
	// shell forwards '/api'. The refresh cookie stays HttpOnly, in Android's cookie manager.
	apiBaseUrl: 'https://api.premovedprep.com/api',
	// This build's own source: the Android app is published from PremovedPrep-mobile.
	sourceCodeUrl: 'https://github.com/Premoved/PremovedPrep-mobile',
	contactEmail: 'contact@premoved.com',
	supportUrl: 'https://buymeacoffee.com/premoved',
};
