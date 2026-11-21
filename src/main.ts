// Android: the desktop app's main.ts, with the local half installed first (window.premovedDesktop),
// as the desktop's preload script does before the page runs.
import './mobile/install';

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
