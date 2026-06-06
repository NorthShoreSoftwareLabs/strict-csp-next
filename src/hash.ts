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
 * One `<script>` element from a single tokenizer pass. The four extractors and
 * counters below are thin filters over `scanScripts`, so the scan-and-advance
 * logic lives in exactly one place.
 */
export interface ScriptToken {
	/** Lower-cased attribute names present on the open tag, mapped to values. */
	attrs: Map<string, string>;
	/** The `src` attribute value, or undefined for inline scripts. */
	src?: string;
	/** The `integrity` attribute value, or undefined when absent. */
	integrity?: string;
	/** The script body (text between the open and close tags). */
	body: string;
	/** Byte offset of the start of the open tag (`<script`) in the source HTML. */
	openStart: number;
	/** Byte offset just past the open tag's `>`. */
	openEnd: number;
	/** Byte offset of the matching `</script`, or -1 if unterminated. */
	closeStart: number;
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
 * The single tokenizer pass. Walk every `<script>` element once, returning each
 * with its attributes, `src`, `integrity`, body, and byte offsets. Quote-aware,
 * so it is not fooled by `>` or `src=`/`nonce=` text inside a quoted attribute
 * value. Every other extractor and counter in this module is a thin filter over
 * this one pass, so the scan-and-advance boilerplate exists in exactly one place
 * (the drift the centralized tokenizer is meant to prevent).
 */
export function scanScripts(html: string): ScriptToken[] {
	const out: ScriptToken[] = [];
	const open = /<script\b/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: regex.exec() in the loop condition is the standard global-scan idiom (lastIndex advances; null ends it).
	while ((m = open.exec(html)) !== null) {
		const openStart = m.index;
		const parsed = parseOpenTag(html, openStart + m[0].length);
		if (!parsed) break; // unterminated tag; stop rather than mis-hash

		// Find the matching close tag from the end of the open tag.
		let body = "";
		const closeStart = findCloseTag(html, parsed.end);
		if (closeStart !== -1) {
			body = html.slice(parsed.end, closeStart);
			// Advance the open-tag scanner past this element's close tag.
			const gt = html.indexOf(">", closeStart);
			open.lastIndex = gt === -1 ? html.length : gt + 1;
		} else {
			// Unterminated close: advance past the open tag so we never re-scan it
			// (the bug the duplicated loops had — one branch forgot this).
			open.lastIndex = parsed.end;
		}

		out.push({
			attrs: parsed.attrs,
			src: parsed.attrs.get("src"),
			integrity: parsed.attrs.get("integrity"),
			body,
			openStart,
			openEnd: parsed.end,
			closeStart,
		});
	}
	return out;
}

/**
 * True when a tokenized script tag is NOT one of the inert `type` values the
 * browser never executes. External `<script src>` tags pass this (they execute),
 * so it is the shared executable-type filter for both inline and external scans.
 */
export function isExecutableType(attrs: Map<string, string>): boolean {
	const type = attrs.get("type")?.trim().toLowerCase();
	return !(type && NON_EXECUTABLE_TYPES.has(type));
}

/**
 * Tokenize every `<script>` element in an HTML string, classifying each as
 * executable-and-bare or not. Derived from the single `scanScripts` pass.
 */
export function scanInlineScripts(html: string): InlineScript[] {
	return scanScripts(html).map((s) => ({
		body: s.body,
		attrs: s.attrs,
		executable: isExecutable(s.attrs),
	}));
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
	for (const s of scanScripts(html)) {
		if (!s.src || !s.integrity) continue;
		if (!isExecutableType(s.attrs)) continue;
		seen.add(`'${s.integrity.trim()}'`);
	}
	return [...seen];
}

/**
 * Count executable external `<script src="...">` tags (those with a `src`
 * attribute) in prerendered HTML. Used alongside `extractExternalIntegrity` in
 * the self-check. Non-executable types (data blocks, templates) are excluded.
 * Counts per tag, NOT deduped by file — shared chunks across tags each count.
 */
export function countExternalScripts(html: string): number {
	let count = 0;
	for (const s of scanScripts(html)) {
		if (!s.src || !isExecutableType(s.attrs)) continue;
		count++;
	}
	return count;
}

/**
 * Count executable external `<script src>` tags that LACK an `integrity`
 * attribute — the per-tag uncovered count that the coverage gate keys on. This
 * is deliberately per-tag (not a dedup-count comparison): two tags sharing one
 * file but only one carrying integrity would false-pass a dedup equality, yet
 * the un-pinned tag is still blocked under `'strict-dynamic'`. Non-executable
 * types are excluded.
 */
export function countUncoveredExternalScripts(html: string): number {
	let count = 0;
	for (const s of scanScripts(html)) {
		if (!s.src || !isExecutableType(s.attrs)) continue;
		if (!s.integrity || s.integrity.trim() === "") count++;
	}
	return count;
}
