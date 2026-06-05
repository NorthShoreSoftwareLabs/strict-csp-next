import type { NextConfig } from "next";

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
export { extractInlineHashes, hashInlineScript } from "./hash.js";
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

/**
 * Wrap your Next.js config. v0.1 is a stable pass-through extension point: the
 * build-time hashing runs via the `strict-csp-next postbuild` CLI and the
 * request-time policy via middleware. Future versions can move that wiring here
 * without changing this signature.
 *
 * @example
 * // next.config.mjs
 * import { withStrictCsp } from 'strict-csp-next'
 * export default withStrictCsp({ cacheComponents: true })
 */
export function withStrictCsp(nextConfig: NextConfig = {}): NextConfig {
	return nextConfig;
}
