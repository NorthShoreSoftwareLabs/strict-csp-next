import type { NextConfig } from "next";
import type { HashAlgorithm } from "./types.js";

export type {
	AppliedCspHeader,
	CspHeaderForHtml,
	WithStrictCspCacheOptions,
} from "./cache-handler.js";
export {
	applyCspHeader,
	cspHeaderForHtml,
	withStrictCspCache,
} from "./cache-handler.js";
export {
	countExternalScripts,
	extractExternalIntegrity,
	extractInlineHashes,
	hashInlineScript,
} from "./hash.js";
export { lookupRoute } from "./lookup.js";
export {
	clearManifestCache,
	generateManifest,
	loadManifest,
	manifestPath,
	writeManifest,
} from "./manifest.js";
export type { CspPlan, CspPlanOptions } from "./plan.js";
export { generateNonce, planCsp } from "./plan.js";
export { buildMetaPolicy, buildPolicy, cspHeaderName } from "./policy.js";
export type { PostbuildOptions, PostbuildResult } from "./postbuild.js";
export { runPostbuild } from "./postbuild.js";
export type {
	PrerenderMetaOptions,
	PrerenderMetaResult,
} from "./prerender-headers.js";
export { injectPrerenderMetaCsp } from "./prerender-headers.js";
export { injectMetaCsp } from "./static-export.js";
export type {
	CspHeaderEntry,
	StaticHeadersOptions,
} from "./static-headers.js";
export { staticCspHeaders } from "./static-headers.js";
export type {
	CspManifest,
	HashAlgorithm,
	RouteEntry,
	RouteMode,
	StrictCspOptions,
} from "./types.js";

export interface WithStrictCspOptions {
	/** Hash algorithm for inline scripts and SRI. Default: "sha256". */
	algorithm?: HashAlgorithm;
	/** Enforce the policy or only report violations. Default: "enforce". */
	mode?: "enforce" | "report-only";
}

/**
 * Wrap your Next.js config. Enables `experimental.sri` automatically so static
 * and ISR routes get integrity hashes on their `<script>` tags, allowing the
 * library to produce a fully strict CSP with zero `'self'` host-allowlisting.
 *
 * @example
 * // next.config.mjs
 * import { withStrictCsp } from 'strict-csp-next'
 * export default withStrictCsp({ cacheComponents: true })
 *
 * @example
 * // With a custom hash algorithm
 * export default withStrictCsp({ cacheComponents: true }, { algorithm: 'sha384' })
 */
export function withStrictCsp(
	nextConfig: NextConfig = {},
	options: WithStrictCspOptions = {},
): NextConfig {
	const algorithm = options.algorithm ?? "sha256";
	// Enable SRI unless the user has explicitly configured it.
	const existingSri = nextConfig.experimental?.sri;
	const sri = existingSri !== undefined ? existingSri : { algorithm };

	return {
		...nextConfig,
		experimental: {
			...nextConfig.experimental,
			sri,
		},
	};
}
