import { createHash } from "node:crypto";
import type { HashAlgorithm } from "./types.js";

/**
 * Script `type` values that are NOT executed by the browser, so CSP never
 * blocks them and they never need a hash. We skip them to keep the policy lean.
 */
const NON_EXECUTABLE_TYPES = new Set([
	"application/json",
	"application/ld+json",
	"text/template",
	"text/html",
]);

export interface InlineScript {
	/** The script body (text between the open and close tags). */
	body: string;
	/** Lower-cased attribute names present on the open tag. */
	attrs: Map<string, string>;
	/** True when the tag is executable AND bare (no `src`, no `nonce`). */
	executable: boolean;
}

/**
 * Parse the attributes of a `<script ...>` open tag starting at `start` (the
 * index just past `<script`). Quoted values are respected, so a `>` or a
 * `src=`-looking substring INSIDE a quoted attribute value does not terminate
 * the tag or get mistaken for a real attribute. This is the blind spot a single
 * regex has, and the reason this is a hand-written tokenizer.
 *
 * Returns the parsed attributes and the index just past the open tag's `>`, or
 * null if the tag is never closed. A `<script>` is a raw-text element, so a
 * trailing `/` before `>` does NOT self-close it (HTML ignores the solidus); the
 * element still runs until `</script>`.
 */
function parseOpenTag(
	html: string,
	start: number,
): { attrs: Map<string, string>; end: number } | null {
	const attrs = new Map<string, string>();
	let i = start;
	const len = html.length;

	while (i < len) {
		const ch = html[i];

		// End of the open tag. A trailing `/` is an ignored solidus, not a close.
		if (ch === ">") {
			return { attrs, end: i + 1 };
		}
		if (ch === "/" && html[i + 1] === ">") {
			return { attrs, end: i + 2 };
		}

		// Skip whitespace between attributes.
		if (
			ch === " " ||
			ch === "\t" ||
			ch === "\n" ||
			ch === "\r" ||
			ch === "\f"
		) {
			i++;
			continue;
		}

		// Read an attribute name.
		let name = "";
		while (
			i < len &&
			!/[\s/>=]/.test(html[i]!) // name ends at whitespace, '/', '>', or '='
		) {
			name += html[i];
			i++;
		}
		name = name.toLowerCase();

		// Skip whitespace before a possible '='.
		while (i < len && /\s/.test(html[i]!)) i++;

		let value = "";
		if (html[i] === "=") {
			i++; // consume '='
			while (i < len && /\s/.test(html[i]!)) i++; // whitespace before value
			const quote = html[i];
			if (quote === '"' || quote === "'") {
				i++; // consume opening quote
				while (i < len && html[i] !== quote) {
					value += html[i];
					i++;
				}
				i++; // consume closing quote
			} else {
				// Unquoted value: read until whitespace or '>'.
				while (i < len && !/[\s>]/.test(html[i]!)) {
					value += html[i];
					i++;
				}
			}
		}

		// A browser uses the FIRST occurrence of a duplicate attribute; mirror that
		// so a second `type=` can't flip our executable classification.
		if (name && !attrs.has(name)) attrs.set(name, value);
	}

	return null; // unterminated open tag
}

/**
 * Index of the next real `</script` close tag at or after `from`. The browser
 * only ends a script element on `</script` followed by whitespace, `/`, or `>`,
 * so `</scriptx` does NOT close it. Returns -1 if there is none.
 */
function findCloseTag(html: string, from: number): number {
	const re = /<\/script[\s/>]/gi;
	re.lastIndex = from;
	const m = re.exec(html);
	return m ? m.index : -1;
}

function isExecutable(attrs: Map<string, string>): boolean {
	if (attrs.has("src")) return false; // external
	if (attrs.has("nonce")) return false; // already covered at request time
	const type = attrs.get("type")?.trim().toLowerCase();
	if (type && NON_EXECUTABLE_TYPES.has(type)) return false;
	return true;
}

/**
 * Tokenize every `<script>` element in an HTML string, classifying each as
 * executable-and-bare or not. Quote-aware, so it is not fooled by `>` or
 * `src=`/`nonce=` text inside a quoted attribute value. This is the single
 * source of truth for both hashing and counting.
 */
export function scanInlineScripts(html: string): InlineScript[] {
	const out: InlineScript[] = [];
	const open = /<script\b/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: regex.exec() in the loop condition is the standard global-scan idiom (lastIndex advances; null ends it).
	while ((m = open.exec(html)) !== null) {
		const parsed = parseOpenTag(html, m.index + m[0].length);
		if (!parsed) break; // unterminated tag; stop rather than mis-hash
		const executable = isExecutable(parsed.attrs);

		// Find the matching close tag from the end of the open tag.
		let body = "";
		const closeIdx = findCloseTag(html, parsed.end);
		if (closeIdx !== -1) {
			body = html.slice(parsed.end, closeIdx);
			// Advance the open-tag scanner past this element's close tag.
			const gt = html.indexOf(">", closeIdx);
			open.lastIndex = gt === -1 ? html.length : gt + 1;
		} else {
			open.lastIndex = parsed.end;
		}

		out.push({ body, attrs: parsed.attrs, executable });
	}
	return out;
}

export function hashInlineScript(
	content: string,
	algorithm: HashAlgorithm = "sha256",
): string {
	const digest = createHash(algorithm).update(content, "utf8").digest("base64");
	return `'${algorithm}-${digest}'`;
}

/**
 * Extract CSP hashes for every executable bare inline script in an HTML string.
 * Deduplicated and stable across requests for prerendered output.
 */
export function extractInlineHashes(
	html: string,
	algorithm: HashAlgorithm = "sha256",
): string[] {
	const hashes = new Set<string>();
	for (const script of scanInlineScripts(html)) {
		if (!script.executable) continue;
		if (script.body.length === 0) continue;
		hashes.add(hashInlineScript(script.body, algorithm));
	}
	return [...hashes];
}

/**
 * Count executable bare inline script TAGS via the tokenizer. Counts empty tags
 * too (unlike `extractInlineHashes`, which needs bytes to hash), so it matches
 * the coarse regex's tag-counting and the two only disagree on genuine drift.
 */
export function countInlineScripts(html: string): number {
	let n = 0;
	for (const script of scanInlineScripts(html)) {
		if (script.executable) n++;
	}
	return n;
}

/**
 * An INDEPENDENT, regex-only count of executable inline scripts that does not
 * share the tokenizer's structure. The self-check compares this against
 * countInlineScripts: a disagreement means one method missed or misparsed a tag
 * (e.g. after a Next.js change, or on adversarial markup), which is exactly the
 * silent drift the build should fail on.
 */
export function coarseExecutableCount(html: string): number {
	const opens = html.match(/<script\b/gi)?.length ?? 0;
	const credentialed =
		html.match(/<script\b[^>]*\s(?:src|nonce)\s*=/gi)?.length ?? 0;
	const inert =
		html.match(
			/<script\b[^>]*\stype\s*=\s*["']?(?:application\/json|application\/ld\+json|text\/template|text\/html)\b/gi,
		)?.length ?? 0;
	return Math.max(0, opens - credentialed - inert);
}

/**
 * A third, independent signal: the number of `</script>` close tags. Every
 * inline (non-self-closing) script has exactly one, so this bounds the number of
 * inline elements regardless of attribute shape. Used only as a tripwire in the
 * self-check, never to drive hashing.
 */
export function closeTagCount(html: string): number {
	return html.match(/<\/script\s*>/gi)?.length ?? 0;
}

/**
 * Extract CSP hash-source expressions from `integrity` attributes on external
 * `<script src="..." integrity="sha256-H">` tags in prerendered HTML. Each
 * returned value is ready to drop into a `script-src` directive (e.g.
 * `'sha256-abc123'`). Only executable scripts are considered (script tags with
 * `type="application/json"` etc. are skipped).
 *
 * Deduplicated and stable: each hash appears once regardless of how many tags
 * reference the same file.
 */
export function extractExternalIntegrity(html: string): string[] {
	const seen = new Set<string>();
	const open = /<script\b/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard global-scan idiom.
	while ((m = open.exec(html)) !== null) {
		const parsed = parseOpenTag(html, m.index + m[0].length);
		if (!parsed) break;
		const src = parsed.attrs.get("src");
		const integrity = parsed.attrs.get("integrity");
		if (!src || !integrity) {
			// Advance past this element's close tag so we don't re-scan it.
			const closeIdx = findCloseTag(html, parsed.end);
			if (closeIdx !== -1) {
				const gt = html.indexOf(">", closeIdx);
				open.lastIndex = gt === -1 ? html.length : gt + 1;
			} else {
				open.lastIndex = parsed.end;
			}
			continue;
		}
		// Skip non-executable types (data blocks, templates, etc.).
		const type = parsed.attrs.get("type")?.trim().toLowerCase();
		if (type && NON_EXECUTABLE_TYPES.has(type)) continue;
		// Advance past this element's close tag.
		const closeIdx = findCloseTag(html, parsed.end);
		if (closeIdx !== -1) {
			const gt = html.indexOf(">", closeIdx);
			open.lastIndex = gt === -1 ? html.length : gt + 1;
		} else {
			open.lastIndex = parsed.end;
		}
		seen.add(`'${integrity.trim()}'`);
	}
	return [...seen];
}

/**
 * Count external `<script src="...">` tags (those with a `src` attribute) in
 * prerendered HTML. Used alongside `extractExternalIntegrity` in the self-check
 * to detect chunks without integrity attributes. Non-executable types (data
 * blocks, templates) are excluded.
 */
export function countExternalScripts(html: string): number {
	let count = 0;
	const open = /<script\b/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard global-scan idiom.
	while ((m = open.exec(html)) !== null) {
		const parsed = parseOpenTag(html, m.index + m[0].length);
		if (!parsed) break;
		const src = parsed.attrs.get("src");
		const type = parsed.attrs.get("type")?.trim().toLowerCase();
		if (!src || (type && NON_EXECUTABLE_TYPES.has(type))) {
			const closeIdx = findCloseTag(html, parsed.end);
			if (closeIdx !== -1) {
				const gt = html.indexOf(">", closeIdx);
				open.lastIndex = gt === -1 ? html.length : gt + 1;
			} else {
				open.lastIndex = parsed.end;
			}
			continue;
		}
		count++;
		const closeIdx = findCloseTag(html, parsed.end);
		if (closeIdx !== -1) {
			const gt = html.indexOf(">", closeIdx);
			open.lastIndex = gt === -1 ? html.length : gt + 1;
		} else {
			open.lastIndex = parsed.end;
		}
	}
	return count;
}
