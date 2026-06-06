import { readFileSync, writeFileSync } from "node:fs";
import { scanRoutes } from "./manifest.js";
import { buildPolicy, cspHeaderName } from "./policy.js";
import type { HashAlgorithm, StrictCspOptions } from "./types.js";

export interface PrerenderMetaResult {
	/** Routes whose prerender `.meta` sidecar gained a CSP header. */
	patched: string[];
}

export interface PrerenderMetaOptions extends StrictCspOptions {
	/**
	 * Limit which routes are patched, by URL path (e.g. `/projects/strict-csp-next`).
	 * Return `true` to patch, `false` to skip. Mirror the cache handler's
	 * `routeFilter` so a site adopting the handler on one subtree only stamps the
	 * build prerender for that subtree, leaving the rest of the app's CSP intact.
	 * When omitted, every `static` / `isr` route is patched.
	 */
	routeFilter?: (route: string) => boolean;
}

/**
 * Inject the hash-only CSP into the prerender `.meta` sidecar of every `static`
 * and `isr` route, so Next serves the policy straight from its own cache on the
 * first request, with no `vercel.json` wiring and no proxy hop.
 *
 * This is the companion to the cache handler. The cache handler covers a route
 * once it revalidates at runtime; the build-time prerender that ships in the
 * build output is written by the build worker, which never runs the handler, so
 * its `.meta` has no policy until the first revalidation. Patching it here closes
 * that initial window. The hashes come from the same prerendered `.html` the
 * cache handler would hash, so the policy matches the bytes Next serves.
 *
 * Only `static` and `isr` routes are patched: `ppr` and `dynamic` carry a
 * per-request nonce from the proxy, and a fixed meta policy would conflict with
 * it. The self-check in `runPostbuild` still guards the hashes.
 */
export function injectPrerenderMetaCsp(
	projectDir: string = process.cwd(),
	options: PrerenderMetaOptions = {},
	distDir?: string,
): PrerenderMetaResult {
	const algorithm: HashAlgorithm = options.algorithm ?? "sha256";
	const headerName = cspHeaderName(options);
	const { routeFilter } = options;
	const patched: string[] = [];

	for (const route of scanRoutes(projectDir, algorithm, distDir)) {
		if (route.mode !== "static" && route.mode !== "isr") continue;
		if (routeFilter && !routeFilter(route.route)) continue;

		const metaPath = route.file.replace(/\.html$/, ".meta");
		let meta: { headers?: Record<string, unknown> };
		try {
			meta = JSON.parse(readFileSync(metaPath, "utf8"));
		} catch {
			continue; // no meta sidecar (or unreadable): nothing to patch
		}
		if (typeof meta !== "object" || meta === null) continue;

		const headers =
			meta.headers && typeof meta.headers === "object" ? meta.headers : {};
		// Replace any CSP already present (either case) so we never leave two.
		delete headers["content-security-policy"];
		delete headers["content-security-policy-report-only"];
		headers[headerName] = buildPolicy(
			route.shellHashes,
			null,
			options,
			route.externalIntegrity,
			route.uncoveredExternal,
		);
		meta.headers = headers;

		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		patched.push(route.route);
	}

	return { patched };
}
