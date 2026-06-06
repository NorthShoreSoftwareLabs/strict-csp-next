import {
	copyFileSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	closeTagCount,
	coarseExecutableCount,
	countExternalScripts,
	countInlineScripts,
	extractExternalIntegrity,
} from "./hash.js";
import {
	generateManifest,
	MANIFEST_FILENAME,
	manifestPath,
	resolveDistDir,
	scanRoutes,
	writeManifest,
} from "./manifest.js";
import { injectPrerenderMetaCsp } from "./prerender-headers.js";
import { injectMetaCsp } from "./static-export.js";
import { staticCspHeaders } from "./static-headers.js";
import type { HashAlgorithm, StrictCspOptions } from "./types.js";

export interface PostbuildOptions {
	projectDir?: string;
	algorithm?: HashAlgorithm;
	/**
	 * Next.js build directory if you set a custom `distDir` in `next.config`.
	 * Default: `.next`. A relative value is resolved against `projectDir`.
	 */
	distDir?: string;
	/** Throw if any prerendered route has an inline script left uncovered. */
	failOnUncovered?: boolean;
	/**
	 * Also write `.next/strict-csp-headers.json` with static-route CSP header
	 * entries for CDN-terminal delivery (wire into vercel.json / next.config).
	 */
	emitHeaders?: boolean;
	/** Policy options applied to the emitted static headers. */
	headerOptions?: StrictCspOptions;
	/**
	 * Inject the hash-only CSP into the prerender `.meta` sidecar of every
	 * `static` and `isr` route, so Next serves the policy from its own cache on
	 * the first request with no `vercel.json` wiring. Pair this with the cache
	 * handler (`withStrictCspCache`), which covers the same routes once they
	 * revalidate at runtime; this closes the build-time-prerender window before
	 * the first revalidation. Uses `headerOptions`. Default: `false`.
	 */
	patchPrerenderHeaders?: boolean;
	/**
	 * For `output: 'export'`: the static export directory (e.g. "out"). When set,
	 * a `<meta http-equiv="Content-Security-Policy">` with per-page inline hashes
	 * is injected into every exported HTML file, so the site is strict-CSP under a
	 * CDN with no server and no header config. Pair with `experimental.sri` for
	 * external-bundle integrity.
	 */
	exportDir?: string;
}

export interface PostbuildResult {
	manifestPath: string;
	headersPath?: string;
	/** Where the manifest was copied for `output: 'standalone'`, if detected. */
	standalonePath?: string;
	/** Routes whose prerender `.meta` gained a CSP, if `patchPrerenderHeaders`. */
	prerenderHeadersPatched?: string[];
	/** Number of exported HTML files a meta CSP was injected into, if exportDir. */
	exportFilesPatched?: number;
	routeCount: number;
	totalHashes: number;
	/** Total number of external script integrity hashes across all routes. */
	totalIntegrityHashes: number;
	/**
	 * Routes where the independent signals disagree, signaling a likely
	 * missed/misparsed script (drift): the tokenizer count, the independent coarse
	 * regex count, and the structural open/close-tag balance. Also covers
	 * external scripts missing integrity attributes.
	 */
	uncovered: Array<{
		route: string;
		inlineScripts: number;
		coarseScripts: number;
		reason: string;
		/** Number of external `<script src>` tags found, if checked. */
		externalScripts?: number;
		/** Number of integrity hashes extracted, if checked. */
		integrityHashes?: number;
	}>;
}

/**
 * Run after `next build`. Scans the prerendered output, writes the CSP manifest,
 * and runs the self-check: every executable inline script in every prerendered
 * route must be represented by a hash. A mismatch means Next emitted a script
 * shape we did not cover (e.g. after an upgrade), and is surfaced loudly.
 */
export function runPostbuild(options: PostbuildOptions = {}): PostbuildResult {
	const projectDir = options.projectDir ?? process.cwd();
	const algorithm = options.algorithm ?? "sha256";
	const distDir = options.distDir;
	const distRoot = resolveDistDir(projectDir, distDir);
	// The build dir's own name (`.next`, or a custom `distDir`); the standalone
	// bundle preserves it.
	const distName = basename(distRoot);

	const manifest = generateManifest(projectDir, algorithm, distDir);
	const path = writeManifest(projectDir, manifest, distDir);

	let headersPath: string | undefined;
	if (options.emitHeaders) {
		headersPath = join(distRoot, "strict-csp-headers.json");
		writeFileSync(
			headersPath,
			JSON.stringify(
				staticCspHeaders(manifest, options.headerOptions),
				null,
				2,
			),
		);
	}

	// output: 'standalone' ships a minimal bundle under <distDir>/standalone that
	// does not include our manifest. Copy it next to the bundle's server.js (which
	// may be nested in a monorepo layout) so the proxy finds it at runtime; the
	// standard Docker `COPY <distDir>/standalone ./` then carries it along.
	let standalonePath: string | undefined;
	const standaloneRoot = join(distRoot, "standalone");
	if (existsSync(standaloneRoot)) {
		const serverDir = findStandaloneServerDir(standaloneRoot) ?? standaloneRoot;
		standalonePath = join(serverDir, distName, MANIFEST_FILENAME);
		mkdirSync(dirname(standalonePath), { recursive: true });
		copyFileSync(path, standalonePath);
	}

	// Inject the hash-only policy into the prerender .meta sidecars so Next serves
	// it from its own cache on the first request (before any runtime revalidation
	// runs the cache handler). Covers static and isr routes only.
	let prerenderHeadersPatched: string[] | undefined;
	if (options.patchPrerenderHeaders) {
		prerenderHeadersPatched = injectPrerenderMetaCsp(
			projectDir,
			options.headerOptions,
			distDir,
		).patched;
	}

	// output: 'export' has no server, so inject the policy as a <meta> into each
	// exported HTML file (hashes only, no nonce).
	let exportFilesPatched: number | undefined;
	if (options.exportDir) {
		exportFilesPatched = injectMetaCsp(
			join(projectDir, options.exportDir),
			options.algorithm ?? algorithm,
			options.headerOptions,
		);
	}

	// Self-check from the exact source files (not a re-derived path), comparing
	// independent counts to catch drift in Next.js script emission.
	const uncovered: PostbuildResult["uncovered"] = [];
	let totalHashes = 0;
	let totalIntegrityHashes = 0;

	for (const route of scanRoutes(projectDir, algorithm, distDir)) {
		totalHashes += route.shellHashes.length;
		totalIntegrityHashes += route.externalIntegrity?.length ?? 0;
		let html: string;
		try {
			html = readFileSync(route.file, "utf8");
		} catch {
			continue;
		}
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

		// External script integrity check: count external <script src> tags vs.
		// integrity attributes. A mismatch means some chunks lack SRI coverage,
		// which would leave them uncovered if 'self' is dropped.
		const externalScripts = countExternalScripts(html);
		const integrityHashes = extractExternalIntegrity(html).length;
		if (externalScripts > 0 && integrityHashes === 0) {
			reasons.push(
				`${externalScripts} external script(s) but no integrity attributes ` +
					`(enable experimental.sri in next.config or set it via withStrictCsp)`,
			);
		}

		if (reasons.length > 0) {
			uncovered.push({
				route: route.route,
				inlineScripts,
				coarseScripts,
				reason: reasons.join("; "),
				externalScripts: externalScripts > 0 ? externalScripts : undefined,
				integrityHashes: externalScripts > 0 ? integrityHashes : undefined,
			});
		}
	}

	if (uncovered.length > 0 && options.failOnUncovered) {
		const detail = uncovered.map((u) => `  ${u.route}: ${u.reason}`).join("\n");
		throw new Error(
			`strict-csp-next: script coverage mismatch (possible uncovered ` +
				`scripts). This usually means a Next.js change altered script ` +
				`emission or SRI is not enabled.\n${detail}`,
		);
	}

	return {
		manifestPath: path,
		headersPath,
		standalonePath,
		prerenderHeadersPatched,
		exportFilesPatched,
		routeCount: manifest.routes.length,
		totalHashes,
		totalIntegrityHashes,
		uncovered,
	};
}

/**
 * Find the directory holding the standalone bundle's `server.js` (skipping
 * node_modules). Next nests this under the workspace-relative path in a
 * monorepo, so we locate it rather than assuming the bundle root.
 */
function findStandaloneServerDir(root: string): string | undefined {
	const queue: string[] = [root];
	while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name === "server.js") return dir;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name !== "node_modules") {
				queue.push(join(dir, entry.name));
			}
		}
	}
	return undefined;
}

export { manifestPath };
