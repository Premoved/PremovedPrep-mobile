export declare class Players {
	constructor(
		settings: unknown,
		worker: unknown,
		native: unknown,
		emit: (event: string, data: unknown) => void,
		createIndexWorker: () => Worker,
		fileSrc: (path: string) => string,
	);
}
