export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;

export function imageMime(bytes: Uint8Array): string | null {
	if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
	if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
	if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
	return null;
}

export async function readPastedImage(file: File): Promise<string> {
	if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 32 MiB');
	const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
	const mime = imageMime(header);
	if (!mime) throw new Error('仅支持 JPEG、PNG、GIF 或 WebP 图片');
	const encoded = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'));
		reader.onerror = () => reject(new Error('图片读取失败'));
		reader.readAsDataURL(file);
	});
	const comma = encoded.indexOf(',');
	if (comma < 0 || !encoded.slice(0, comma).endsWith(';base64')) throw new Error('图片编码失败');
	return `data:${mime};base64,${encoded.slice(comma + 1)}`;
}
