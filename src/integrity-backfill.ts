import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { scanScripts } from "./hash.js";
import type { HashAlgorithm } from "./types.js";

/**
 * How to set `crossorigin` on backfilled tags.
 *
 * - `'auto'` (default): detect from `assetPrefix`. Same-origin assets get
 *   `integrity` only (matching what Next does for its own SRI tags, verified on a
 *   real export build — Next adds no `crossorigin` for same-origin). Cross-origin
 *   assets get `integrity` + `crossorigin="anonymous"`, because SRI on a
 *   cross-origin script requires a CORS-eligible fetch or the browser blocks it.
 * - `'anonymous'` / `'use-credentials'`: force that value on every backfilled tag.
 * - `false`: never add `crossorigin` (for setups where assets are same-origin via
 *   a rewrite/proxy even though `assetPrefix` looks absolute).
 */
export type CrossOriginOption =
	| "auto"
	| "anonymous"
	| "use-credentials"
	| false;

export interface BackfillOptions {
	/** Hash algorithm. Must match the SRI algorithm Next used. Default sha256. */
	algorithm?: HashAlgorithm;
	/** `assetPrefix` from the resolved Next config. Drives cross-origin detection. */
	assetPrefix?: string;
	/** `basePath` from the resolved Next config. Stripped from `src` before resolving. */
	basePath?: string;
	/** crossorigin handling for backfilled tags. Default `'auto'`. */
	crossOrigin?: CrossOriginOption;
	/**
	 * Resolve a tag's `src` (already stripped of basePath/assetPrefix) to an
	 * on-disk file path. Return null when the file is not under the asset root
	 * (e.g. a third-party absolute URL we cannot hash).
	 */
	resolve: (assetPath: string) => string | null;
}

export interface BackfillResult {
	/** The rewritten HTML (unchanged when nothing was backfilled — idempotent). */
	html: string;
	/** CSP source expressions for the newly injected integrity hashes (deduped). */
	added: string[];
	/** Number of tags that gained an `integrity` attribute. */
	injected: number;
	/** True when at least one backfilled asset was cross-origin. */
	crossOriginDetected: boolean;
}

/**
 * Determine whether `assetPrefix` points at a different origin than the page.
 * Handles relative (''), protocol-relative ('//cdn'), same-host-absolute, and
 * different-host-absolute. We do not know the page's own host at build time, so
 * any absolute or protocol-relative prefix is treated as potentially cross-origin
 * — the conservative choice, since a missing `crossorigin` on a true cross-origin
 * tag breaks the page, while an unneeded `crossorigin` on a same-origin tag is
 * harmless (the browser fetches with CORS and same-origin always satisfies it).
 */
export function isCrossOrigin(assetPrefix: string | undefined): boolean {
	if (!assetPrefix) return false;
	const p = assetPrefix.trim();
	if (p === "") return false;
	// Protocol-relative (`//cdn...`) or absolute (`https://cdn...`) → another origin.
	if (p.startsWith("//")) return true;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return true;
	// A relative prefix (e.g. `/assets`) stays same-origin.
	return false;
}

/**
 * Resolve the desired `crossorigin` attribute value for a backfilled tag, or null
 * to add none. Precedence: an explicit `'anonymous'` / `'use-credentials'` /
 * `false` always wins; `'auto'` (the default) derives from `assetPrefix`.
 */
function crossOriginValue(
	option: CrossOriginOption,
	crossOrigin: boolean,
): "anonymous" | "use-credentials" | null {
	if (option === false) return null;
	if (option === "anonymous") return "anonymous";
	if (option === "use-credentials") return "use-credentials";
	// 'auto': mirror what a consistent SRI deployment needs.
	return crossOrigin ? "anonymous" : null;
}

/** Strip an optional leading basePath/assetPrefix from a URL path. */
function stripPrefix(src: string, prefix: string | undefined): string {
	if (!prefix) return src;
	const p = prefix.replace(/\/$/, "");
	if (p && src.startsWith(p)) return src.slice(p.length) || "/";
	return src;
}

/**
 * Backfill `integrity` (and `crossorigin` when needed) into external
 * `<script src>` tags that lack it, in one HTML string. Tags already carrying
 * `integrity` are left untouched, so re-running is a no-op (idempotent). Only
 * tags whose `src` resolves to an on-disk asset are touched; anything else
 * (third-party absolute URLs, missing files) is skipped.
 *
 * Inline-script hashes are unaffected: these tags have empty bodies, and only the
 * open tag is edited. Callers that also inject a meta CSP should still compute
 * inline hashes and integrity from the POST-backfill HTML so the policy lists the
 * hashes that now appear in the tags.
 */
export function backfillIntegrity(
	html: string,
	options: BackfillOptions,
): BackfillResult {
	const algorithm = options.algorithm ?? "sha256";
	const crossOriginOpt = options.crossOrigin ?? "auto";
	const crossOrigin = isCrossOrigin(options.assetPrefix);

	// Collect edits with their byte offsets, then apply right-to-left so earlier
	// offsets stay valid as we splice.
	const edits: Array<{ at: number; insert: string }> = [];
	const added = new Set<string>();
	let injected = 0;

	for (const tok of scanScripts(html)) {
		if (!tok.src) continue; // inline
		if (tok.integrity && tok.integrity.trim() !== "") continue; // already covered
		// Skip inert types and tags whose src is not a resolvable local asset.
		const type = tok.attrs.get("type")?.trim().toLowerCase();
		if (
			type &&
			(type === "application/json" ||
				type === "application/ld+json" ||
				type === "text/template" ||
				type === "text/html")
		) {
			continue;
		}
		// A backfill cannot pin a script Next will fetch from another origin without
		// also hashing those bytes locally; resolve() returns null for those.
		const assetPath = stripPrefix(
			stripPrefix(tok.src, options.assetPrefix),
			options.basePath,
		);
		const file = options.resolve(assetPath);
		if (!file) continue;
		let bytes: Buffer;
		try {
			bytes = readFileSync(file);
		} catch {
			continue; // not on disk; leave the tag as-is
		}
		const digest = createHash(algorithm).update(bytes).digest("base64");
		const integrity = `${algorithm}-${digest}`;
		added.add(`'${integrity}'`);

		// Build the attributes to insert just before the open tag's `>`. `openEnd`
		// points just past `>`; the char at openEnd-1 is `>` (or part of `/>`).
		let insertAt = tok.openEnd - 1;
		// A self-closing-looking `/>` keeps the solidus; insert before the `/`.
		if (html[insertAt - 1] === "/") insertAt -= 1;

		const coVal = crossOriginValue(crossOriginOpt, crossOrigin);
		const hasCrossOrigin = tok.attrs.has("crossorigin");
		let attrs = ` integrity="${integrity}"`;
		if (coVal && !hasCrossOrigin) attrs += ` crossorigin="${coVal}"`;

		edits.push({ at: insertAt, insert: attrs });
		injected++;
	}

	if (edits.length === 0) {
		return {
			html,
			added: [],
			injected: 0,
			crossOriginDetected: false,
		};
	}

	let out = html;
	for (const edit of edits.sort((a, b) => b.at - a.at)) {
		out = out.slice(0, edit.at) + edit.insert + out.slice(edit.at);
	}

	return {
		html: out,
		added: [...added],
		injected,
		crossOriginDetected: crossOrigin && crossOriginOpt !== false,
	};
}

/**
 * Build a resolver that maps a `/_next/...`-style asset path to an on-disk file
 * under `assetRoot`. For `output: 'export'`, `assetRoot` is the export dir (`out`)
 * and `/_next/static/...` lives directly under it. For server builds, `assetRoot`
 * is the dist root (`.next`); `/_next/static/...` is served from `<distRoot>/static`,
 * so the `/_next` URL segment is rewritten to `<distRoot>`.
 */
export function makeAssetResolver(
	assetRoot: string,
	mode: "export" | "server",
): (assetPath: string) => string | null {
	return (assetPath: string) => {
		// Only resolve same-origin, _next-served assets. Anything absolute
		// (http/https/protocol-relative) is left to crossorigin handling and is not
		// hashable from disk here.
		if (
			/^[a-z][a-z0-9+.-]*:\/\//i.test(assetPath) ||
			assetPath.startsWith("//")
		) {
			return null;
		}
		let rel = assetPath.split("?")[0]?.split("#")[0] ?? assetPath;
		if (!rel.startsWith("/")) rel = `/${rel}`;
		if (mode === "export") {
			// /_next/static/chunks/x.js -> <out>/_next/static/chunks/x.js
			const p = join(assetRoot, rel);
			return isAbsolute(p) ? p : null;
		}
		// server: /_next/static/... -> <distRoot>/static/...
		const m = rel.match(/^\/_next\/(.*)$/);
		if (!m || m[1] === undefined) return null;
		return join(assetRoot, m[1]);
	};
}
