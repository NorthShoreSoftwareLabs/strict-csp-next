import { type NextRequest, NextResponse } from "next/server";
import { loadManifest, manifestPath } from "./manifest.js";
import { planCsp, sanitizeRequestHeaders } from "./plan.js";
import type { CspManifest, StrictCspOptions } from "./types.js";

export interface StrictCspProxyOptions extends StrictCspOptions {
	/**
	 * Pass the manifest directly instead of reading
	 * `.next/strict-csp-manifest.json` from disk. On Vercel this is the reliable
	 * path: import the committed manifest so it is traced into the function
	 * bundle, rather than relying on a runtime disk read of `process.cwd()`.
	 */
	manifest?: CspManifest;
	/** Project root used to locate the manifest. Defaults to `process.cwd()`. */
	projectDir?: string;
	/**
	 * Next.js build directory if you set a custom `distDir` in `next.config`.
	 * Default: `.next`, but the proxy auto-detects Next's `__NEXT_DIST_DIR` at
	 * runtime, so you usually do not need to set this.
	 */
	distDir?: string;
	/**
	 * Skip routes delivered by static CSP headers (`static` and `isr`). Set this
	 * to `true` when you wire `staticCspHeaders()` into `vercel.json` /
	 * `next.config` so the proxy does not set a conflicting policy on routes the
	 * CDN already covers. Default: `false`.
	 */
	skipStatic?: boolean;
}

let warnedMissingManifest = false;

function warnMissingManifestOnce(options: StrictCspProxyOptions): void {
	if (warnedMissingManifest) return;
	warnedMissingManifest = true;
	// A null manifest means every prerendered route loses its shell hashes and
	// PPR/static pages stop hydrating, silently. This is the classic Vercel
	// failure: the manifest written by `postbuild` is not traced into the
	// function bundle. Make it loud so it is diagnosable. See README "Vercel".
	console.warn(
		`strict-csp-next: no CSP manifest found at ` +
			`${manifestPath(options.projectDir ?? process.cwd(), options.distDir)}. ` +
			`Prerendered routes will fall back to a nonce-only policy, which breaks ` +
			`hydration on static/PPR shells. On Vercel, import the manifest and pass ` +
			`it via createStrictCsp({ manifest }), or add it to ` +
			`outputFileTracingIncludes. On Next.js 15, run the middleware on the ` +
			`Node.js runtime (\`runtime: 'nodejs'\`, stable in 15.5) so the manifest ` +
			`disk read works; the proxy imports Node built-ins and cannot run on ` +
			`Edge. See the README.`,
	);
}

/**
 * Create the strict-CSP proxy. Works as the Next.js 16 `proxy.ts` export (which
 * always runs on the Node.js runtime) and as a Next.js 15 `middleware.ts`
 * export. Per request it looks up the route's build-time inline-script hashes
 * and, for routes with request-time output (dynamic / PPR), a fresh nonce, then
 * sets `script-src 'self' <hashes> 'nonce-...'` on BOTH the request header (so
 * the Next.js render/resume stamps the nonce) and the response header. Static
 * and ISR routes are covered by hashes alone and stay cacheable.
 *
 * On Next.js 15, middleware must run on the Node.js runtime:
 * `export const config = { runtime: 'nodejs' }` (stable in 15.5). The proxy
 * module statically imports `node:fs` (via the manifest loader) and so cannot
 * run on the Edge runtime; there is no Edge-safe path even when the manifest is
 * passed in. (Nonces are minted with Web Crypto, `globalThis.crypto`, which is
 * available on both runtimes and is not the constraint.)
 */
export function createStrictCsp(options: StrictCspProxyOptions = {}) {
	return function strictCsp(request: NextRequest): NextResponse {
		const manifest =
			options.manifest ?? loadManifest(options.projectDir, options.distDir);
		if (!manifest) warnMissingManifestOnce(options);

		const plan = planCsp(manifest, request.nextUrl.pathname, options);

		// Drop client-controlled request headers (inbound CSP / x-nonce) before the
		// render sees them; the CSP and x-nonce this proxy owns are re-set below. On
		// the skip path they stay stripped.
		const requestHeaders = sanitizeRequestHeaders(request.headers);

		// When static routes are served via CDN headers, leave the policy untouched
		// (but still forward the sanitized request headers).
		if (plan.skip) {
			return NextResponse.next({ request: { headers: requestHeaders } });
		}

		// Next reads the nonce from the request CSP header at render time.
		requestHeaders.set("content-security-policy", plan.policy!);
		if (plan.nonce) requestHeaders.set("x-nonce", plan.nonce);

		const response = NextResponse.next({
			request: { headers: requestHeaders },
		});
		response.headers.set(plan.headerName, plan.policy!);
		if (plan.noStore) response.headers.set("cache-control", "no-store");
		if (plan.reportingEndpoints) {
			response.headers.set("reporting-endpoints", plan.reportingEndpoints);
		}
		return response;
	};
}

/** Ready-to-use proxy with defaults. Reads the manifest from disk. */
export const strictCsp = createStrictCsp();
