import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	countInlineScripts,
	countUncoveredExternalScripts,
	extractExternalIntegrity,
	extractInlineHashes,
} from "./hash.js";
import {
	backfillIntegrity,
	type CrossOriginOption,
	makeAssetResolver,
} from "./integrity-backfill.js";
import { buildMetaPolicy } from "./policy.js";
import type { HashAlgorithm, StrictCspOptions } from "./types.js";

/** Integrity-backfill configuration passed down to the export meta injector. */
export interface ExportBackfillConfig {
	assetPrefix?: string;
	basePath?: string;
	crossOrigin?: CrossOriginOption;
}

let warnedFrameAncestors = false;

// Marks the meta tag we inject so re-runs replace it instead of stacking.
const META_TAG =
	/<meta http-equiv="Content-Security-Policy"[^>]*data-strict-csp[^>]*>\s*/i;

/**
 * Byte ranges where a `<head>` substring would NOT be a real head tag: HTML
 * comments and raw-text elements (`script`, `style`, `textarea`, `title`). An
 * unterminated comment extends to EOF, matching browser parsing. We avoid
 * anchoring the meta inside any of these.
 */
function inertRanges(html: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	const comment = /<!--/g;
	let c: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: regex.exec() in the loop condition is the standard global-scan idiom (lastIndex advances; null ends it).
	while ((c = comment.exec(html)) !== null) {
		const close = html.indexOf("-->", c.index + 4);
		const end = close === -1 ? html.length : close + 3;
		ranges.push([c.index, end]);
		comment.lastIndex = end;
	}

	const rawText = /<(script|style|textarea|title)\b[^>]*>/gi;
	let r: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: regex.exec() in the loop condition is the standard global-scan idiom (lastIndex advances; null ends it).
	while ((r = rawText.exec(html)) !== null) {
		const closeRe = new RegExp(`</${r[1]}[\\s/>]`, "i");
		const afterOpen = r.index + r[0].length;
		const rel = html.slice(afterOpen).search(closeRe);
		const end = rel === -1 ? html.length : afterOpen + rel;
		ranges.push([r.index, end]);
		rawText.lastIndex = end;
	}

	return ranges;
}

/**
 * Find the first real `<head ...>` open tag, skipping any inside a comment or a
 * raw-text element so the meta is never injected into an inert location while
 * the real head goes uncovered.
 */
function findHeadInsert(html: string): number | null {
	const ranges = inertRanges(html);
	const re = /<head[^>]*>/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: regex.exec() in the loop condition is the standard global-scan idiom (lastIndex advances; null ends it).
	while ((m = re.exec(html)) !== null) {
		const idx = m.index;
		const inert = ranges.some(([s, e]) => idx >= s && idx < e);
		if (!inert) return idx + m[0].length;
	}
	return null;
}

function walkHtml(dir: string): string[] {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		try {
			if (entry.isDirectory()) out.push(...walkHtml(full));
			else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
		} catch {
			// Skip entries that vanish mid-scan.
		}
	}
	return out;
}

/**
 * Inject a `<meta http-equiv="Content-Security-Policy">` carrying the page's
 * inline-script hashes into every HTML file under `exportDir`. For
 * `output: 'export'`, where there is no server to set a response header. The
 * policy travels in the HTML, so the site is strict under any static host or
 * CDN. Pair with `experimental.sri` for external-bundle integrity.
 *
 * Idempotent: re-running replaces the previously injected tag. Returns the
 * number of files patched.
 *
 * A `<meta>` CSP cannot express `frame-ancestors` (browsers ignore it there), so
 * an exported site has no clickjacking protection from the policy alone. Set
 * `frame-ancestors` / `X-Frame-Options` at your CDN. This is warned once.
 */
export function injectMetaCsp(
	exportDir: string,
	algorithm: HashAlgorithm = "sha256",
	options: StrictCspOptions = {},
	backfill?: ExportBackfillConfig,
): number {
	let patched = 0;
	const skipped: string[] = [];
	const resolve = makeAssetResolver(exportDir, "export");
	let totalInjected = 0;
	let crossOriginDetected = false;
	for (const file of walkHtml(exportDir)) {
		const original = readFileSync(file, "utf8");
		let html = original.replace(META_TAG, "");
		// Backfill integrity into external <script src> tags Next left un-pinned,
		// BEFORE computing inline hashes and the meta policy, so the policy lists
		// the hashes that now appear in the tags. Idempotent: a tag already carrying
		// integrity is skipped, so re-running the postbuild does not double-inject.
		if (backfill) {
			const result = backfillIntegrity(html, {
				algorithm,
				assetPrefix: backfill.assetPrefix,
				basePath: backfill.basePath,
				crossOrigin: backfill.crossOrigin,
				resolve,
			});
			html = result.html;
			totalInjected += result.injected;
			if (result.crossOriginDetected) crossOriginDetected = true;
		}
		const hashes = extractInlineHashes(html, algorithm);
		const externalIntegrity = extractExternalIntegrity(html);
		const uncoveredExternal = countUncoveredExternalScripts(html);
		const policy = buildMetaPolicy(
			hashes,
			options,
			externalIntegrity,
			uncoveredExternal,
		);
		const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" data-strict-csp>`;

		const insertAt = findHeadInsert(html);
		if (insertAt === null) {
			// No anchorable <head>. Silently skipping a page that ships inline scripts
			// would leave it unprotected, so surface those loudly.
			if (countInlineScripts(html) > 0) skipped.push(file);
			continue;
		}
		const next = html.slice(0, insertAt) + meta + html.slice(insertAt);
		if (next !== original) {
			writeFileSync(file, next);
			patched++;
		}
	}

	if (skipped.length > 0) {
		console.warn(
			`strict-csp-next: ${skipped.length} exported file(s) have inline scripts ` +
				`but no <head> to anchor a <meta> CSP, so they are NOT protected:\n` +
				skipped.map((f) => `  ${f}`).join("\n"),
		);
	}
	// Fail loud, never silent: when assets are cross-origin, the backfilled tags
	// carry crossorigin="anonymous" but the CDN must opt in with CORS headers.
	if (crossOriginDetected && totalInjected > 0) {
		console.warn(
			`strict-csp-next: chunks are served from ${backfill?.assetPrefix} ` +
				`(cross-origin). Added crossorigin="anonymous" to ${totalInjected} ` +
				`backfilled <script> tag(s). Your CDN MUST return ` +
				`\`Access-Control-Allow-Origin\` for these files or the browser will ` +
				`block them as SRI failures.`,
		);
	}
	// frame-ancestors can't be delivered via <meta>; remind the operator once.
	if (!warnedFrameAncestors) {
		warnedFrameAncestors = true;
		console.warn(
			`strict-csp-next: a <meta> CSP cannot set frame-ancestors. Configure ` +
				`frame-ancestors (or X-Frame-Options) at your CDN to prevent clickjacking.`,
		);
	}
	return patched;
}
