import type { OutgoingHttpHeaders } from "node:http";
import {
	closeTagCount,
	coarseExecutableCount,
	countInlineScripts,
	extractInlineHashes,
} from "./hash.js";
import {
	buildPolicy,
	CSP_HEADER,
	CSP_REPORT_ONLY_HEADER,
	cspHeaderName,
} from "./policy.js";
import type { StrictCspOptions } from "./types.js";

/**
 * Cache-write-time CSP for the App Router.
 *
 * Build-time hashing freezes the inline-script hashes in a static header
 * (`vercel.json` / `next.config`). That works for `static`, whose bytes never
 * change after the build, but breaks for `isr`: when a route revalidates and its
 * data changes, the streamed `self.__next_f.push(...)` scripts get new bytes and
 * new hashes the frozen header does not list, so a strict policy blocks them.
 *
 * The fix is to hash at the moment Next regenerates the page. Next serializes the
 * rendered document to a string and stores it in the incremental cache together
 * with the response headers (verified against Next 16's
 * `response-cache/utils.ts` and `file-system-cache.ts`). `withStrictCspCache`
 * wraps your cache handler and, on every `set`, derives the CSP header from the
 * exact HTML being cached and stamps it onto that same entry. Body and header
 * revalidate together, so the hashes always match, the data is free to change,
 * and the route stays CDN-cacheable with no nonce and no `no-store`.
 */

const CSP_HEADER_NAMES = new Set([CSP_HEADER, CSP_REPORT_ONLY_HEADER]);

export interface CspHeaderForHtml {
	/**
	 * The CSP header value for this document, or `null` when the self-check found
	 * drift. A `null` policy means: do not set a CSP header on this entry, so the
	 * route falls back to the nonce proxy rather than shipping a policy that might
	 * block (see `driftReason`).
	 */
	policy: string | null;
	/** Response header name to use (enforce vs `report-only`). */
	headerName: string;
	/** Why the self-check failed, or `null` when it passed. */
	driftReason: string | null;
}

/**
 * Compute the CSP header for one freshly rendered App Router document. This is
 * the cache-write-time analogue of build-time hashing: the hashes come from the
 * exact bytes Next just produced, so they match even after the inline data
 * changed on revalidation.
 *
 * Runs the same three-signal self-check the build step uses (a quote-aware
 * tokenizer, an independent coarse regex, and the open/close `<script>` tag
 * balance). On disagreement it returns a `null` policy and a `driftReason` so the
 * caller can fail safe instead of caching a policy that might block the page.
 */
export function cspHeaderForHtml(
	html: string,
	options: StrictCspOptions = {},
): CspHeaderForHtml {
	const headerName = cspHeaderName(options);
	const algorithm = options.algorithm ?? "sha256";

	// Three independent counts of executable inline scripts. They agree on output
	// Next emits as expected and only diverge when a script took a shape the
	// scanner did not anticipate, which is the silent drift we must not ship past.
	const inlineScripts = countInlineScripts(html);
	const coarseScripts = coarseExecutableCount(html);
	const opens = html.match(/<script\b/gi)?.length ?? 0;
	const closes = closeTagCount(html);

	const reasons: string[] = [];
	if (inlineScripts !== coarseScripts) {
		reasons.push(
			`tokenizer counted ${inlineScripts}, independent regex counted ${coarseScripts}`,
		);
	}
	if (opens !== closes) {
		reasons.push(
			`${opens} <script> open tag(s) but ${closes} </script> close tag(s)`,
		);
	}
	if (reasons.length > 0) {
		return { policy: null, headerName, driftReason: reasons.join("; ") };
	}

	const hashes = extractInlineHashes(html, algorithm);
	return {
		policy: buildPolicy(hashes, null, options),
		headerName,
		driftReason: null,
	};
}

/**
 * Return a copy of `headers` with any existing CSP header removed, regardless of
 * its letter case, so we never leave two policies on one entry.
 */
function stripCsp(
	headers: OutgoingHttpHeaders | undefined,
): OutgoingHttpHeaders {
	const out: OutgoingHttpHeaders = {};
	if (!headers) return out;
	for (const [key, value] of Object.entries(headers)) {
		if (CSP_HEADER_NAMES.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

export interface AppliedCspHeader {
	/** A new headers object carrying the computed CSP (or none, on drift). */
	headers: OutgoingHttpHeaders;
	/** Why the self-check failed, or `null` when it passed. */
	driftReason: string | null;
}

/**
 * Produce the response headers for a cached document: strip any CSP already
 * present, then set the one derived from `html`. On drift the CSP header is
 * omitted (and `driftReason` is set) so the route falls back to the nonce proxy.
 */
export function applyCspHeader(
	headers: OutgoingHttpHeaders | undefined,
	html: string,
	options: StrictCspOptions = {},
): AppliedCspHeader {
	const { policy, headerName, driftReason } = cspHeaderForHtml(html, options);
	const out = stripCsp(headers);
	if (policy !== null) out[headerName] = policy;
	return { headers: out, driftReason };
}

/**
 * The shape of a cached App Router page entry we care about. `kind` is the string
 * `"APP_PAGE"` (Next's `CachedRouteKind.APP_PAGE`), and by the time the value
 * reaches a cache handler its `html` has been serialized to a string by Next's
 * response-cache layer, so it is safe to hash here.
 */
interface CachedAppPage {
	kind: "APP_PAGE";
	html: string;
	headers?: OutgoingHttpHeaders;
}

function isCachedAppPage(data: unknown): data is CachedAppPage {
	if (typeof data !== "object" || data === null) return false;
	const value = data as { kind?: unknown; html?: unknown };
	return value.kind === "APP_PAGE" && typeof value.html === "string";
}

// Warn at most once per route key, so a drift event is loud the first time but a
// route that revalidates every few seconds does not flood the logs.
const warnedDrift = new Set<string>();

function warnDriftOnce(key: string, reason: string): void {
	if (warnedDrift.has(key)) return;
	warnedDrift.add(key);
	console.warn(
		`strict-csp-next: inline-script self-check failed for cached route ` +
			`${JSON.stringify(key)} (${reason}). Dropping its CSP header so the nonce ` +
			`proxy covers it. This usually means a Next.js change altered inline ` +
			`script emission; see the compatibility notes.`,
	);
}

/** Reset the one-time drift-warning state. Exposed for tests. */
export function resetDriftWarnings(): void {
	warnedDrift.clear();
}

let warnedSetFailed = false;

function warnSetFailedOnce(error: unknown): void {
	if (warnedSetFailed) return;
	warnedSetFailed = true;
	const message = error instanceof Error ? error.message : String(error);
	console.warn(
		`strict-csp-next: the wrapped cache handler's set() threw (${message}). ` +
			`The page still renders (the CSP header was already written), but the ` +
			`entry was not cached. The usual cause is a read-only filesystem on a ` +
			`serverless host: this cache handler is for self-hosted Next (next start ` +
			`/ Docker), not Vercel, which ignores a custom cacheHandler. See the ` +
			`deployment notes.`,
	);
}

type NextCacheHandlerCtor = new (
	// A mixin base must be a constructor with an open argument list.
	// biome-ignore lint/suspicious/noExplicitAny: required shape for a mixin constructor.
	...args: any[]
) => {
	set(key: string, data: unknown, ctx: unknown): Promise<void> | void;
};

export interface WithStrictCspCacheOptions extends StrictCspOptions {
	/**
	 * Limit which routes get a strict policy stamped onto them, by the cache key
	 * Next passes to `set` (the route pathname, e.g. `/blog/hello`). Return `true`
	 * to cover the route, `false` to leave its headers untouched. Use this to adopt
	 * the cache handler on one section of a site without disturbing the CSP the
	 * rest of the app already sends. When omitted, every App Router page is covered.
	 */
	routeFilter?: (routeKey: string) => boolean;
}

/**
 * Wrap a Next.js cache handler so every cached App Router page carries a CSP
 * header whose hashes match its exact bytes. Use it to cover `isr` routes (and
 * any other on-demand-revalidated page) without a nonce and without giving up CDN
 * caching.
 *
 * **Self-hosted only.** This works because Next replays the cache entry's headers
 * when it serves the page (`next start`, Docker `standalone`, any Node host).
 * **Vercel ignores a custom `cacheHandler`** and owns the ISR cache itself, so the
 * header set here never reaches the edge there — verified against a real deploy,
 * and confirmed by the Vercel team (vercel/next.js#52203). On Vercel, strict CSP
 * for `isr` with changing data is not achievable this way; use static hashes for
 * unchanging content or the nonce path. See the deployment notes.
 *
 * Wire it in a small project file that Next can load as `cacheHandler`, composing
 * the built-in filesystem cache (or your own Redis/etc. handler) as the base:
 *
 * @example
 * // cache-handler.cjs
 * const { withStrictCspCache } = require('strict-csp-next/cache-handler')
 * const FileSystemCache =
 *   require('next/dist/server/lib/incremental-cache/file-system-cache').default
 * module.exports = withStrictCspCache(FileSystemCache, { strictDynamic: true })
 *
 * // next.config.mjs
 * export default { cacheHandler: require.resolve('./cache-handler.cjs') }
 *
 * Run the proxy with `{ skipStatic: true }` so it leaves `static` and `isr`
 * routes alone: `static` is covered by `staticCspHeaders()` in `vercel.json`, and
 * `isr` is now covered here. The proxy still nonces `ppr` and `dynamic` routes.
 */
export function withStrictCspCache<TBase extends NextCacheHandlerCtor>(
	Base: TBase,
	options: WithStrictCspCacheOptions = {},
): TBase {
	const { routeFilter } = options;
	class StrictCspCache extends Base {
		async set(key: string, data: unknown, ctx: unknown): Promise<void> {
			if (isCachedAppPage(data) && (!routeFilter || routeFilter(key))) {
				const { headers, driftReason } = applyCspHeader(
					data.headers,
					data.html,
					options,
				);
				if (driftReason) warnDriftOnce(key, driftReason);
				// Assign onto the SAME value object Next holds, not a copy. On a cache
				// MISS this object IS what Next streams to the client (the fill render
				// shares its `headers` reference with the value being cached, and `set`
				// is awaited before the response is sent), so writing the header here
				// covers the fill render too, not just later hits. On a HIT the header
				// is replayed from the persisted entry as before.
				data.headers = headers;
			}
			// A base-handler write failure must not crash the response: the header is
			// already on `data`, which Next sends for the fill render, so swallow and
			// warn (the page renders uncached) rather than turning a read-only-FS
			// write error into a 500.
			try {
				await super.set(key, data, ctx);
			} catch (error) {
				warnSetFailedOnce(error);
			}
		}
	}
	return StrictCspCache;
}
