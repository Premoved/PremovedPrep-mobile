export declare function useSqlite(sqlite3: unknown, vfs: string): void;
export declare class DatabaseSync {
	constructor(location: string, options?: { readOnly?: boolean });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	prepare(sql: string): any;
	exec(sql: string): void;
	close(): void;
}
