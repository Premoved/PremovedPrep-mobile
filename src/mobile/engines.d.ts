export declare class Engines {
	constructor(settings: unknown, native: unknown, emit: (event: string, data: unknown) => void);
	adoptBundled(): Promise<unknown>;
	list(): unknown[];
}
export declare function allowedCommand(command: string): boolean;
