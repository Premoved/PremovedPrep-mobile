import { saveFile } from '../../../mobile/save';

// Android: the WebView does not download blob links, so the file goes to the system's save dialog.
export function saveBlob(blob: Blob, filename: string): void {
	void saveFile(blob, filename).catch((error: unknown) => console.error('The file could not be saved', error));
}
