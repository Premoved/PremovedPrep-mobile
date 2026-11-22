// Android: the desktop app's main.ts, with the local half installed first (window.premovedDesktop),
// as the desktop's preload script does before the page runs.
import { started } from './mobile/install';

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// After the Android half is installed (window.premovedDesktop) and the kept drafts are back.
void started
	.catch((err) => console.error(err))
	.then(() => bootstrapApplication(App, appConfig))
	.catch((err) => console.error(err));
