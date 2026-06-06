import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	countUncoveredExternalScripts,
	extractExternalIntegrity,
	extractInlineHashes,
} from "./hash.js";
import type {
	CspManifest,
	HashAlgorithm,
	RouteEntry,
	RouteMode,
} from "./types.js";

export { lookupRoute } from "./lookup.js";

/**
 * Resolve the Next.js build directory (`distDir`). Default is `.next`, but
 * `next.config` can rename it. Priority: an explicit `distDir`, then Next's
 * `__NEXT_DIST_DIR` (set in the proxy at runtime, so a custom dir is picked up
 * automatically), then `<projectDir>/.next`. An absolute `distDir` is used as
 * given; a relative one is resolved against `projectDir`.
 */
export function resolveDistDir(projectDir: string, distDir?: string): string {
	const d = distDir ?? process.env.__NEXT_DIST_DIR;
	if (d) return isAbsolute(d) ? d : join(projectDir, d);
	return join(projectDir, ".next");
}

interface PrerenderEntry {
	renderingMode?: string;
	experimentalPPR?: boolean;
	initialRevalidateSeconds?: number | false;
}

interface PrerenderManifest {
	routes?: Record<string, PrerenderEntry>;
}

/**
 * Read `basePath` / `assetPrefix` from the build's own manifests. Both are
 * `''` on a default deployment. `routes-manifest.json` carries `basePath`;
 * `required-server-files.json` carries the resolved config (including
 * `assetPrefix`) on server builds. For `output: 'export'` there is no
 * required-server-files, so `assetPrefix` falls back to ''.
 */
export function readAssetConfig(
	projectDir: string,
	distDir?: string,
): { basePath: string; assetPrefix: string } {
	const root = resolveDistDir(projectDir, distDir);
	let basePath = "";
	let assetPrefix = "";
	try {
		const routes = JSON.parse(
			readFileSync(join(root, "routes-manifest.json"), "utf8"),
		);
		if (typeof routes.basePath === "string") basePath = routes.basePath;
	} catch {
		// no routes-manifest (export builds may still have one); leave defaults
	}
	try {
		const rsf = JSON.parse(
			readFileSync(join(root, "required-server-files.json"), "utf8"),
		);
		const cfg = rsf?.config ?? {};
		if (typeof cfg.assetPrefix === "string") assetPrefix = cfg.assetPrefix;
		if (!basePath && typeof cfg.basePath === "string") basePath = cfg.basePath;
	} catch {
		// export builds have no required-server-files; assetPrefix stays ''
	}
	return { basePath, assetPrefix };
}

function readPrerenderManifest(
	projectDir: string,
	distDir?: string,
): PrerenderManifest {
	try {
		return JSON.parse(
			readFileSync(
				join(resolveDistDir(projectDir, distDir), "prerender-manifest.json"),
				"utf8",
			),
		) as PrerenderManifest;
	} catch {
		return {};
	}
}

// Note on basePath: routes are stored BARE (no basePath). The proxy looks up
// with `request.nextUrl.pathname`, which Next has already stripped of basePath,
// and `staticCspHeaders()` feeds `headers()` sources, which Next auto-prefixes
// with basePath. Prefixing here would double-count and cause misses, so we don't.

function classifyRoute(pm: PrerenderManifest, route: string): RouteMode {
	// Routes derived from the file tree never carry a trailing slash, but under
	// `trailingSlash: true` the prerender-manifest keys can. Try both forms so a
	// PPR/ISR route is never silently misclassified as static (which would drop
	// its nonce and break the streamed resume).
	const entry =
		pm.routes?.[route] ??
		(route === "/" ? undefined : pm.routes?.[`${route}/`]);
	if (!entry) return "static";
	if (entry.experimentalPPR || entry.renderingMode === "PARTIALLY_STATIC") {
		return "ppr";
	}
	if (typeof entry.initialRevalidateSeconds === "number") return "isr";
	return "static";
}

export const MANIFEST_FILENAME = "strict-csp-manifest.json";

/** Location of the generated manifest inside the build dir (honors `distDir`). */
export function manifestPath(projectDir: string, distDir?: string): string {
	return join(resolveDistDir(projectDir, distDir), MANIFEST_FILENAME);
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
			// Skip entries that vanish or can't be stat'd mid-scan.
		}
	}
	return out;
}

// A route-group segment like `(marketing)`: fully parenthesized, and NOT one of
// the intercepting markers `(.)` / `(..)` / `(...)` (those are dots-only inside).
const ROUTE_GROUP = /^\((?!\.+\))[^)]+\)$/;

/**
 * Derive a URL route from a prerendered HTML file path under server/app.
 * Route-group segments like `(marketing)` are part of the file tree but not the
 * URL, so they are stripped. Parallel (`@slot`), intercepting (`(.)`), and i18n
 * routes are not handled in v0.1.
 */
function routeFromHtmlFile(appDir: string, file: string): string {
	const rel = relative(appDir, file).replace(/\.html$/, "");
	const segments = rel
		.split(sep)
		.filter((s) => s.length > 0 && !ROUTE_GROUP.test(s));
	let route = segments.join("/");
	if (route === "" || route === "index") return "/";
	if (route.endsWith("/index")) route = route.slice(0, -"/index".length);
	return `/${route}`;
}

/** A scanned route plus the source HTML file it came from (internal). */
export interface ScannedRoute extends RouteEntry {
	file: string;
}

/**
 * Scan the prerendered build output once, returning each route with the source
 * HTML file it was derived from. Both the manifest generator and the postbuild
 * self-check use this, so the self-check reads the exact file rather than
 * re-deriving a (lossy) path from the route.
 */
export function scanRoutes(
	projectDir: string,
	algorithm: HashAlgorithm = "sha256",
	distDir?: string,
): ScannedRoute[] {
	const appDir = join(resolveDistDir(projectDir, distDir), "server", "app");
	const files = walkHtml(appDir);
	const prerenderManifest = readPrerenderManifest(projectDir, distDir);

	const byRoute = new Map<string, ScannedRoute>();
	for (const file of files) {
		const route = routeFromHtmlFile(appDir, file);
		// Skip framework error pages; they are served outside normal routing.
		if (route === "/_not-found" || route === "/_global-error") continue;
		if (byRoute.has(route)) continue; // keep first on a collision
		const html = readFileSync(file, "utf8");
		const shellHashes = extractInlineHashes(html, algorithm);
		const externalIntegrity = extractExternalIntegrity(html);
		const uncoveredExternal = countUncoveredExternalScripts(html);
		const mode = classifyRoute(prerenderManifest, route);
		byRoute.set(route, {
			route,
			mode,
			shellHashes,
			externalIntegrity,
			uncoveredExternal,
			file,
		});
	}

	return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Scan a finished `.next` build and produce the CSP manifest: per route, the
 * hashes of the bare inline scripts in its prerendered HTML. Routes with no
 * prerendered HTML (purely dynamic) do not appear and fall through to the
 * nonce-only policy at request time.
 */
export function generateManifest(
	projectDir: string,
	algorithm: HashAlgorithm = "sha256",
	distDir?: string,
): CspManifest {
	const routes: RouteEntry[] = scanRoutes(projectDir, algorithm, distDir).map(
		({ route, mode, shellHashes, externalIntegrity, uncoveredExternal }) => ({
			route,
			mode,
			shellHashes,
			// Persist the SRI fields so CDN-terminal delivery (staticCspHeaders) and
			// the prerender-meta patch can gate `'self'` on real coverage. Omit the
			// integrity array when empty to keep the manifest lean.
			...(externalIntegrity && externalIntegrity.length > 0
				? { externalIntegrity }
				: {}),
			...(uncoveredExternal && uncoveredExternal > 0
				? { uncoveredExternal }
				: {}),
		}),
	);

	return {
		version: 1,
		nextVersion: detectNextVersion(projectDir),
		algorithm,
		routes,
	};
}

function detectNextVersion(projectDir: string): string | undefined {
	try {
		const pkg = JSON.parse(
			readFileSync(
				join(projectDir, "node_modules", "next", "package.json"),
				"utf8",
			),
		);
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

export function writeManifest(
	projectDir: string,
	manifest: CspManifest,
	distDir?: string,
): string {
	const path = manifestPath(projectDir, distDir);
	writeFileSync(path, JSON.stringify(manifest, null, 2));
	return path;
}

const manifestCache = new Map<string, CspManifest>();

/**
 * Read the manifest from disk, cached per build path for the process lifetime.
 * Only SUCCESSFUL reads are cached: a miss returns null without caching, so a
 * transient failure (a not-yet-written manifest, a slow cold start) does not pin
 * the process to the broken nonce-only path forever. Call `clearManifestCache()`
 * to force a re-read after a rebuild.
 */
export function loadManifest(
	projectDir: string = process.cwd(),
	distDir?: string,
): CspManifest | null {
	const path = manifestPath(projectDir, distDir);
	const cached = manifestCache.get(path);
	if (cached) return cached;
	let manifest: CspManifest | null;
	try {
		manifest = JSON.parse(readFileSync(path, "utf8")) as CspManifest;
	} catch {
		return null;
	}
	manifestCache.set(path, manifest);
	return manifest;
}

export function clearManifestCache(): void {
	manifestCache.clear();
}
