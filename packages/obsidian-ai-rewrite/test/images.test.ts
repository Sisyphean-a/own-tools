import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageMime, readPastedImage } from '../src/images';

test('image formats are identified by signature rather than claimed MIME', () => {
	assert.equal(imageMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
	assert.equal(imageMime(new Uint8Array([255, 216, 255, 0])), 'image/jpeg');
	assert.equal(imageMime(new TextEncoder().encode('GIF89a')), 'image/gif');
	assert.equal(imageMime(new TextEncoder().encode('RIFFxxxxWEBP')), 'image/webp');
	assert.equal(imageMime(new TextEncoder().encode('<svg>')), null);
});

test('pasted image is verified by bytes, encoded in memory, and unsupported formats are rejected', async () => {
	const previous = globalThis.FileReader;
	class Reader {
		result: string | null = null;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		readAsDataURL(file: File): void {
			void file.arrayBuffer().then((buffer) => {
				this.result = `data:text/plain;base64,${Buffer.from(buffer).toString('base64')}`;
				this.onload?.();
			}, () => this.onerror?.());
		}
	}
	globalThis.FileReader = Reader as unknown as typeof FileReader;
	try {
		const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'a.txt', { type: 'text/plain' });
		assert.match(await readPastedImage(file), /^data:image\/png;base64,/);
		await assert.rejects(readPastedImage(new File(['<svg>'], 'a.svg', { type: 'image/png' })), /仅支持/);
	} finally {
		if (previous) globalThis.FileReader = previous;
		else Reflect.deleteProperty(globalThis, 'FileReader');
	}
});
