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
	countUncoveredExternalScripts,
	extractExternalIntegrity,
} from "./hash.js";
import {
	backfillIntegrity,
	type CrossOriginOption,
	makeAssetResolver,
} from "./integrity-backfill.js";
import {
	detectNextVersion,
	generateManifest,
	MANIFEST_FILENAME,
	manifestPath,
	readAssetConfig,
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
	/**
	 * Inject `integrity` into external `<script src>` tags Next left un-pinned
	 * (the client-component chunks that fall through Next's bootstrap SRI), so the
	 * coverage gate can drop `'self'`. The library hashes each chunk's on-disk
	 * bytes (`base64(sha256(bytes))`, which matches Next's own integrity exactly)
	 * and writes the attribute into the prerendered HTML. Idempotent. Scoped to
	 * static/ISR prerendered output (export HTML and the server prerender HTML);
	 * dynamic/PPR nonce paths are never touched. Default: `false`.
	 */
	backfillIntegrity?: boolean;
	/**
	 * crossorigin handling for backfilled tags when assets are cross-origin (a
	 * CDN `assetPrefix` on another host). `'auto'` (default) injects
	 * `crossorigin="anonymous"` only for cross-origin assets and prints a CDN-CORS
	 * note; `'anonymous'` / `'use-credentials'` force the value; `false` never
	 * adds it. See `WithStrictCspOptions.sri.crossOrigin`.
	 */
	crossOrigin?: CrossOriginOption;
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
	/**
	 * Number of `<script>` tags that gained an `integrity` attribute from the
	 * backfill (across the server prerender HTML), if `backfillIntegrity`.
	 */
	integrityBackfilled?: number;
	routeCount: number;
	totalHashes: number;
	/** Total number of external script integrity hashes across all routes. */
	totalIntegrityHashes: number;
	/**
	 * A loud warning emitted when the CSP handler is wired in the wrong file for
	 * the installed Next.js major (a `proxy.*` on Next 15, or a `middleware.*` on
	 * Next 16+), which the framework silently ignores — shipping the app with no
	 * CSP. `undefined` when the wiring is unambiguous or undetectable.
	 */
	wiringWarning?: string;
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

	// Integrity backfill (#3/#4): top up the integrity attributes Next leaves off
	// the client-component chunks, so the coverage gate can legitimately drop
	// `'self'`. Runs FIRST, before the manifest, headers, prerender-meta, export
	// injection, and self-check all read the (now-covered) HTML. Scoped to
	// static/ISR prerendered HTML; dynamic/PPR (nonce path) is never touched.
	let integrityBackfilled: number | undefined;
	if (options.backfillIntegrity) {
		integrityBackfilled = backfillServerPrerender(
			projectDir,
			algorithm,
			distDir,
			distRoot,
			options.crossOrigin ?? "auto",
		);
	}

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
	// exported HTML file (hashes only, no nonce). When backfilling, the export
	// injector also tops up integrity on the shipped `out/` HTML before computing
	// the meta policy, so the policy lists the hashes that now appear in the tags.
	let exportFilesPatched: number | undefined;
	if (options.exportDir) {
		const assetConfig = readAssetConfig(projectDir, distDir);
		exportFilesPatched = injectMetaCsp(
			join(projectDir, options.exportDir),
			options.algorithm ?? algorithm,
			options.headerOptions,
			options.backfillIntegrity
				? {
						assetPrefix: assetConfig.assetPrefix,
						basePath: assetConfig.basePath,
						crossOrigin: options.crossOrigin ?? "auto",
					}
				: undefined,
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

		// External script integrity check: count external <script src> tags that
		// LACK an integrity attribute (per-tag, not a dedup-count equality, which
		// would false-pass on chunks shared across tags). ANY uncovered tag means
		// dropping 'self' under 'strict-dynamic' would block that chunk, so the
		// self-check trips on the per-tag shortfall, not only the all-zero case.
		const externalScripts = countExternalScripts(html);
		const integrityHashes = extractExternalIntegrity(html).length;
		const uncoveredExternal = countUncoveredExternalScripts(html);
		if (externalScripts > 0 && uncoveredExternal > 0) {
			// Distinguish "SRI never ran" from "SRI ran but coverage is partial" so
			// the advice is actionable in each case.
			reasons.push(
				integrityHashes === 0
					? `${externalScripts} external script(s) but no integrity attributes ` +
							`(enable experimental.sri in next.config or set it via withStrictCsp)`
					: `${uncoveredExternal} of ${externalScripts} external script(s) lack ` +
							`an integrity attribute (SRI is enabled but coverage is ` +
							`incomplete; run the integrity backfill to reach 100%)`,
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

	// Catch the silent "wrong wiring file" trap: Next 15 reads `middleware.ts`,
	// Next 16 reads `proxy.ts`. A mismatch is ignored by the framework with no
	// error, so the app ships with no CSP. Warn loudly (never throws).
	const nextVersion = manifest.nextVersion ?? detectNextVersion(projectDir);
	const nextMajor = nextVersion
		? Number.parseInt(nextVersion, 10)
		: undefined;
	const wiringWarning = checkHandlerWiring(
		projectDir,
		Number.isFinite(nextMajor) ? nextMajor : undefined,
	);

	return {
		manifestPath: path,
		headersPath,
		standalonePath,
		prerenderHeadersPatched,
		exportFilesPatched,
		integrityBackfilled,
		routeCount: manifest.routes.length,
		totalHashes,
		totalIntegrityHashes,
		wiringWarning,
		uncovered,
	};
}

/**
 * File extensions Next.js accepts for the `middleware` / `proxy` convention.
 */
const WIRING_EXTENSIONS = ["ts", "tsx", "js", "mjs", "cjs", "jsx"] as const;

/**
 * Return true if `<dir>/<base>.{ext}` exists for any accepted extension. Next
 * allows the wiring file at the project root or under a `src/` subdir, so both
 * are probed by the caller.
 */
function wiringFileExists(dir: string, base: string): boolean {
	return WIRING_EXTENSIONS.some((ext) =>
		existsSync(join(dir, `${base}.${ext}`)),
	);
}

/**
 * Guard against the silent "wrong wiring file" trap. Next 15 runs the CSP
 * handler from `middleware.ts`; Next 16 renamed the convention to `proxy.ts`.
 * If the handler lives in the file the installed major does NOT read, the
 * framework ignores it with no error and the app ships with no CSP.
 *
 * Warns ONLY on an unambiguous mismatch — a `proxy.*` on Next 15 with no
 * `middleware.*`, or a `middleware.*` on Next 16+ with no `proxy.*`. It never
 * warns merely because a file is absent (static-header-only setups legitimately
 * have neither), and stays silent when `nextMajor` is undefined. Scans the
 * project root and a `src/` subdir. Returns the warning string (or `undefined`)
 * for testability and also emits it via `console.warn`. Never throws.
 */
export function checkHandlerWiring(
	projectDir: string,
	nextMajor: number | undefined,
): string | undefined {
	if (nextMajor === undefined) return undefined;

	const srcDir = join(projectDir, "src");
	const hasMiddleware =
		wiringFileExists(projectDir, "middleware") ||
		wiringFileExists(srcDir, "middleware");
	const hasProxy =
		wiringFileExists(projectDir, "proxy") ||
		wiringFileExists(srcDir, "proxy");

	let warning: string | undefined;
	if (nextMajor <= 15 && hasProxy && !hasMiddleware) {
		warning =
			`strict-csp-next: found a \`proxy.*\` file but the installed Next.js is ` +
			`v${nextMajor}, which ignores it — rename it to \`middleware.ts\` with ` +
			`\`export const config = { runtime: 'nodejs' }\`, or the app ships no CSP.`;
	} else if (nextMajor >= 16 && hasMiddleware && !hasProxy) {
		warning =
			`strict-csp-next: found a \`middleware.*\` file but the installed Next.js ` +
			`is v${nextMajor}, which renamed the convention to \`proxy.ts\` — rename ` +
			`it, or the CSP handler will not run and the app ships no CSP.`;
	}

	if (warning) console.warn(warning);
	return warning;
}

/**
 * Backfill integrity into the server prerender HTML (`<distDir>/server/app`) for
 * static/ISR routes. Resolves each un-pinned `<script src>` to its on-disk chunk
 * under `<distDir>/static`, hashes the bytes, and writes the attribute back into
 * the `.html`. Idempotent; PPR/dynamic routes are skipped (they carry a nonce).
 * Returns the total number of tags backfilled.
 */
function backfillServerPrerender(
	projectDir: string,
	algorithm: HashAlgorithm,
	distDir: string | undefined,
	distRoot: string,
	crossOrigin: CrossOriginOption,
): number {
	const { assetPrefix, basePath } = readAssetConfig(projectDir, distDir);
	// Server mode: assetRoot is the dist root; the resolver rewrites the `/_next`
	// URL segment to `<distRoot>` (so `/_next/static/...` -> `<distRoot>/static/...`).
	const resolve = makeAssetResolver(distRoot, "server");
	let total = 0;
	let crossOriginDetected = false;
	for (const route of scanRoutes(projectDir, algorithm, distDir)) {
		// Only static/ISR prerendered output. PPR/dynamic use the per-request nonce
		// and must not be patched.
		if (route.mode !== "static" && route.mode !== "isr") continue;
		let html: string;
		try {
			html = readFileSync(route.file, "utf8");
		} catch {
			continue;
		}
		const result = backfillIntegrity(html, {
			algorithm,
			assetPrefix,
			basePath,
			crossOrigin,
			resolve,
		});
		if (result.injected > 0) {
			writeFileSync(route.file, result.html);
			total += result.injected;
		}
		if (result.crossOriginDetected) crossOriginDetected = true;
	}
	if (crossOriginDetected && total > 0) {
		console.warn(
			`strict-csp-next: chunks are served from ${assetPrefix} (cross-origin). ` +
				`Added crossorigin="anonymous" to ${total} backfilled <script> tag(s). ` +
				`Your CDN MUST return \`Access-Control-Allow-Origin\` for these files or ` +
				`the browser will block them as SRI failures.`,
		);
	}
	return total;
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
