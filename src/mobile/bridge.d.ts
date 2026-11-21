// Loose types for the plain-JavaScript ports (store.js, engines.js...), which stay close to the
// desktop's shell code.
export declare class Bridge {
	constructor(parts: { store: unknown; engines: unknown; databases: unknown; players: unknown; native: unknown });
	emit(event: string, data: unknown): void;
	on(event: string, handler: (data: unknown) => void): () => void;
	request(method: string, params: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;
}
