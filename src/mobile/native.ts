import { PluginListenerHandle, registerPlugin } from '@capacitor/core';

// The app's own Android plugin (native/android): what the desktop's Node shell does with the system.

export interface FolderState {
	// A folder was picked once; granted: Android still lets the app use it (a reinstall takes that away).
	readonly chosen: boolean;
	readonly granted: boolean;
	// Shown to the user: "Documents", "1234-5678/Chess"...
	readonly display: string | null;
	// Nothing picked: Documents on the device's own storage, used from the first start (Android 11 and later).
	readonly isDefault: boolean;
}

export interface FileStat {
	readonly exists: boolean;
	readonly dir: boolean;
	readonly size: number;
	// Milliseconds since 1970.
	readonly mtime: number;
}

export interface DirEntry {
	readonly name: string;
	readonly dir: boolean;
	readonly size: number;
	readonly mtime: number;
}

export interface PremovedNativePlugin {
	// engines: the ids of the engines shipped in this build, in the order the page lists them.
	info(): Promise<{ cpus: number; abi: string; sdk: number; engine: boolean; engines: string[] }>;
	freeSpace(): Promise<{ bytes: number; total: number }>;
	keepAwake(options: { on: boolean }): Promise<void>;
	openExternal(options: { url: string }): Promise<void>;
	systemBars(options: { darkBackground: boolean }): Promise<void>;

	engineOpen(options: { engine: string }): Promise<{ sessionId: string }>;
	engineSend(options: { sessionId: string; command: string }): Promise<void>;
	engineClose(options: { sessionId: string }): Promise<void>;

	folderPick(): Promise<FolderState & { picked: boolean }>;
	folderState(): Promise<FolderState>;

	// Paths are relative to the picked folder, with "/" between names.
	fsList(options: { path: string }): Promise<{ exists: boolean; entries: DirEntry[] }>;
	fsStat(options: { path: string }): Promise<FileStat>;
	fsRead(options: { path: string }): Promise<{ text: string }>;
	// Written beside the file and renamed over it: an interrupted write leaves the old version.
	fsWrite(options: { path: string; text: string }): Promise<void>;
	fsRename(options: { path: string; name: string }): Promise<void>;
	fsRemove(options: { path: string }): Promise<void>;
	fsMkdirs(options: { path: string }): Promise<void>;

	saveFile(options: { name: string; mime: string; base64: string }): Promise<{ saved: boolean }>;
	// A large file saved in pieces (a database export): the dialog, then the pieces, then the end.
	exportBegin(options: { name: string; mime: string }): Promise<{ saved: boolean; token?: string; name?: string }>;
	exportWrite(options: { token: string; base64: string }): Promise<void>;
	exportEnd(options: { token: string; ok: boolean }): Promise<void>;

	// A file from the server into the app's cache (the offline player list), read back through Capacitor.convertFileSrc.
	download(options: { url: string; name: string }): Promise<{ path: string; bytes: number }>;
	downloadRemove(options: { name: string }): Promise<void>;

	addListener(
		event: 'engineLine',
		handler: (data: { sessionId: string; line: string }) => void,
	): Promise<PluginListenerHandle>;
	addListener(event: 'engineClosed', handler: (data: { sessionId: string }) => void): Promise<PluginListenerHandle>;
}

export const Native = registerPlugin<PremovedNativePlugin>('PremovedNative');
