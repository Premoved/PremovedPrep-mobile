export interface ReadOnlyVfs {
	readonly name: string;
	acquire(fileName: string, handle: FileSystemSyncAccessHandle, options?: { writable?: boolean }): void;
	release(fileName: string): FileSystemSyncAccessHandle | null;
	handle(fileName: string): FileSystemSyncAccessHandle | null;
	useTemporaryFiles(files: FileSystemSyncAccessHandle[]): void;
	takeTemporaryFiles(): FileSystemSyncAccessHandle[];
}
export declare function installReadOnlyVfs(sqlite3: unknown, name?: string): ReadOnlyVfs;
