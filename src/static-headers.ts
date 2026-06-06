import { buildPolicy, cspHeaderName } from "./policy.js";
import type { CspManifest, StrictCspOptions } from "./types.js";

export interface CspHeaderEntry {
	/** Path pattern, in the shape Next.js `headers()` and `vercel.json` expect. */
	source: string;
	headers: Array<{ key: string; value: string }>;
}

export interface StaticHeadersOptions {
	/**
	 * Include `isr` routes in the static header set. Leave it `true` (the default)
	 * to freeze their build-time hashes in the CDN header, which only holds while
	 * the inline data is stable across revalidations. Set it to `false` when you
	 * cover `isr` routes with the cache handler (`withStrictCspCache` from
	 * `strict-csp-next/cache-handler`), which recomputes the hashes on every
	 * revalidation so changing data never breaks the policy. Setting both for the
	 * same route would leave a stale, frozen header competing with the correct one.
	 */
	includeIsr?: boolean;
}

/**
 * Build static CSP header entries for fully prerendered routes (`static`, and
 * `isr` unless `includeIsr` is `false`). These carry only hashes, no nonce, so
 * they can be served from the CDN with no per-request work. Wire them into
 * `vercel.json` or `next.config` `headers()`, and run the middleware with
 * `{ skipStatic: true }` so it does not also set a (conflicting) policy on those
 * routes.
 *
 * Dynamic and PPR routes are intentionally excluded: they need a per-request
 * nonce and must go through the middleware. ISR routes covered by the cache
 * handler should be excluded too, with `{ includeIsr: false }`.
 */
export function staticCspHeaders(
	manifest: CspManifest | null | undefined,
	options: StrictCspOptions = {},
	deliveryOptions: StaticHeadersOptions = {},
): CspHeaderEntry[] {
	if (!manifest) return [];
	const includeIsr = deliveryOptions.includeIsr ?? true;
	const headerName = cspHeaderName(options);
	return manifest.routes
		.filter((r) => r.mode === "static" || (includeIsr && r.mode === "isr"))
		.map((r) => ({
			source: r.route,
			headers: [
				{
					key: headerName,
					value: buildPolicy(r.shellHashes, null, options, r.externalIntegrity),
				},
			],
		}));
}
