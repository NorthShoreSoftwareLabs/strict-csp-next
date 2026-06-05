import type { CspManifest, RouteEntry } from "./types.js";

/**
 * Pure route lookup with no filesystem access, so it is safe to import into
 * middleware running on any runtime. v0.1 matches concrete paths only; dynamic
 * segments fall through to the nonce-only policy, which is still strict.
 */
export function lookupRoute(
	manifest: CspManifest | null | undefined,
	pathname: string,
): RouteEntry | undefined {
	if (!manifest) return undefined;
	const normalized =
		pathname.length > 1 && pathname.endsWith("/")
			? pathname.slice(0, -1)
			: pathname;
	return manifest.routes.find((r) => r.route === normalized);
}
