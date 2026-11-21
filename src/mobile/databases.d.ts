export declare class Databases {
	constructor(
		settings: unknown,
		worker: unknown,
		native: unknown,
		emit: (event: string, data: unknown) => void,
		createIndexWorker: () => Worker,
	);
}
export declare function pickFile(accept: string): Promise<File | null>;
