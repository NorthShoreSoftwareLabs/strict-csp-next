import { createRequire } from "node:module";
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
export type { ScriptToken } from "./hash.js";
export {
	countExternalScripts,
	countUncoveredExternalScripts,
	extractExternalIntegrity,
	extractInlineHashes,
	hashInlineScript,
	scanScripts,
} from "./hash.js";
export type {
	BackfillOptions,
	BackfillResult,
	CrossOriginOption,
} from "./integrity-backfill.js";
export {
	backfillIntegrity,
	isCrossOrigin,
	makeAssetResolver,
} from "./integrity-backfill.js";
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
	/**
	 * Hash algorithm for inline scripts and SRI. Default: "sha256". Drives the
	 * `experimental.sri.algorithm` Next uses to stamp integrity. The postbuild
	 * integrity backfill and inline-hash extraction default to the same value;
	 * pass the matching `algorithm` to `runPostbuild` so SRI and inline hashes
	 * never diverge across the two entry points (see runPostbuild / the bin).
	 */
	algorithm?: HashAlgorithm;
	// NOTE: report-only is NOT a `withStrictCsp` option. `withStrictCsp` only
	// shapes the Next.js config (it enables `experimental.sri`); the
	// enforce/report-only header name is chosen at delivery time, where the policy
	// is actually emitted. Set `mode: 'report-only'` on `StrictCspOptions` passed
	// to `createStrictCsp` (the proxy), `runPostbuild({ headerOptions })`,
	// `staticCspHeaders`, `injectPrerenderMetaCsp`, or the cache handler. Putting
	// it on the config wrapper would be a no-op, since that output never reaches
	// those calls. See the `mode` field on `StrictCspOptions`.
}

/**
 * Warn when SRI is being enabled on a Next.js older than 15.2.0. `experimental.sri`
 * only emits `integrity` on the Node.js runtime from 15.2.0; below that the config
 * key parses but does nothing on Node-rendered pages, so the strict zero-`'self'`
 * static path would ship without integrity and must fall back to
 * `script-src 'self'` + hashes.
 *
 * Detection is best-effort and never throws: read `next/package.json` inside a
 * try/catch, parse major.minor by hand (no semver dependency), and if anything
 * fails — package not resolvable, version missing or malformed — stay silent and
 * proceed. This runs during next.config evaluation (Node), so `require` is fine.
 */
function warnIfSriUnsupported(): void {
	try {
		const require = createRequire(import.meta.url);
		const { version } = require("next/package.json") as { version?: unknown };
		if (typeof version !== "string") return;
		const parts = version.split(".");
		const major = Number.parseInt(parts[0] ?? "", 10);
		const minor = Number.parseInt(parts[1] ?? "", 10);
		if (!Number.isFinite(major) || !Number.isFinite(minor)) return;
		if (major < 15 || (major === 15 && minor < 2)) {
			console.warn(
				`strict-csp-next: experimental.sri integrity is only emitted on the ` +
					`Node.js runtime from Next.js 15.2.0, but the installed Next is ` +
					`${version}. On this version the strict zero-'self' static path will ` +
					`not have integrity and must fall back to \`script-src 'self'\` + ` +
					`hashes. Upgrade to >= 15.2.0 to drop 'self' on static/ISR routes.`,
			);
		}
	} catch {
		// Version undetectable — proceed silently. Never break config evaluation.
	}
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
	// Enable SRI unless the user has explicitly configured it. Precedence: an
	// explicit `experimental.sri` the user set always wins — Next stamps integrity
	// using THAT algorithm, and the postbuild copies integrity literally, so SRI is
	// unaffected. But the inline-hash algorithm is configured independently (on
	// `runPostbuild` / the bin), so the two can silently diverge. Warn when the
	// caller passes an `algorithm` that does not match an explicit
	// `experimental.sri.algorithm`, so the policy's inline-hash and integrity
	// algorithms stay aligned (#8c).
	const existingSri = nextConfig.experimental?.sri;
	if (
		existingSri !== undefined &&
		options.algorithm &&
		typeof existingSri === "object" &&
		existingSri.algorithm &&
		existingSri.algorithm !== options.algorithm
	) {
		console.warn(
			`strict-csp-next: withStrictCsp({ algorithm: '${options.algorithm}' }) is ` +
				`ignored because experimental.sri.algorithm is already set to ` +
				`'${existingSri.algorithm}'. SRI integrity uses '${existingSri.algorithm}'; ` +
				`make sure runPostbuild uses the same algorithm so inline-script hashes ` +
				`and integrity hashes do not diverge.`,
		);
	}
	const sri = existingSri !== undefined ? existingSri : { algorithm };

	// SRI is about to be enabled unless the caller explicitly disabled it. Warn
	// defensively if the installed Next predates 15.2.0, where integrity is not
	// emitted (best-effort; never throws).
	if (sri) warnIfSriUnsupported();

	return {
		...nextConfig,
		experimental: {
			...nextConfig.experimental,
			sri,
		},
	};
}
