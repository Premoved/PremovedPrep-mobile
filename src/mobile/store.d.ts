export declare class LocalStore {
	constructor(files: unknown, folderState: () => Promise<unknown>);
	ensure(): Promise<unknown>;
	location(): Promise<unknown>;
}
export declare function coded(code: string, message: string): Error;
