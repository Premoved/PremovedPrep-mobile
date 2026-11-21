import { Native } from './native';

// The system's save dialog, opened on Documents (or the app's folder once picked).
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
	const base64 = await toBase64(blob);
	const { saved } = await Native.saveFile({
		name: filename,
		mime: blob.type || 'application/octet-stream',
		base64,
	});
	return saved;
}

function toBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result ?? '');
			resolve(url.slice(url.indexOf(',') + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'));
		reader.readAsDataURL(blob);
	});
}
