// Model-visible text budgets are UTF-8 bytes, not line counts or JS characters.
export const TOOL_OUTPUT_BYTES = 64 * 1024;
export const REQUEST_TOOL_OUTPUT_BYTES = 128 * 1024;

function prefix(buffer: Buffer, bytes: number): string {
	let end = Math.min(bytes, buffer.length);
	while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function suffix(buffer: Buffer, bytes: number): string {
	let start = Math.max(0, buffer.length - bytes);
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

/** Keep both ends without splitting Unicode; the marker counts against the cap. */
export function boundText(text: string, limit: number = TOOL_OUTPUT_BYTES, marker: string = "\n… [output truncated] …\n"): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= limit) return text;
	const markerBytes = Buffer.byteLength(marker);
	if (markerBytes >= limit) return prefix(Buffer.from(marker), limit);
	const remaining = limit - markerBytes;
	return prefix(buffer, Math.ceil(remaining / 2)) + marker + suffix(buffer, Math.floor(remaining / 2));
}

export function textBytes(content: Array<{ type: string; text?: string }>): number {
	return content.reduce((sum, block) => sum + (block.type === "text" && block.text ? Buffer.byteLength(block.text) : 0), 0);
}

/** One budget across all text blocks. Preserve non-text blocks and block ordering. */
export function boundContent<T extends { type: string; text?: string }>(content: T[], limit: number, marker?: string): T[] {
	const total = textBytes(content);
	if (total <= limit) return content;
	let remaining = limit;
	let remainingOriginal = total;
	return content.map((block) => {
		if (block.type !== "text" || !block.text) return block;
		const bytes = Buffer.byteLength(block.text);
		if (bytes === 0) return block;
		const share = Math.min(remaining, Math.floor((remaining * bytes) / remainingOriginal));
		remainingOriginal -= bytes;
		const text = boundText(block.text, share, marker);
		remaining -= Buffer.byteLength(text);
		return { ...block, text };
	});
}
