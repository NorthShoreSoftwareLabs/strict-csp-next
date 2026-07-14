import { type NextRequest, NextResponse } from "next/server";
import { planCsp } from "./plan.js";
import type { CspManifest, StrictCspOptions } from "./types.js";

export interface StrictCspEdgeOptions extends StrictCspOptions {
	/**
	 * The CSP manifest, imported by the caller and passed in. On the Edge runtime
	 * there is no disk read: `import manifest from './.next/strict-csp-manifest.json'
	 * with { type: 'json' }` in your `middleware.js` and hand it here. Absent, the
	 * proxy falls back to a nonce-only policy (no per-route shell hashes), which is
	 * safe but breaks hydration on static/PPR shells — so pass it.
	 */
	manifest?: CspManifest;
	/**
	 * Skip routes delivered by static CSP headers (`static` and `isr`). Set this to
	 * `true` when you wire `staticCspHeaders()` into `vercel.json` / `next.config`
	 * so the proxy does not set a conflicting policy on routes the CDN already
	 * covers. Default: `false`.
	 */
	skipStatic?: boolean;
}

/**
 * Edge-safe strict-CSP middleware for the Next.js Edge runtime.
 *
 * This is the Edge counterpart to `createStrictCsp` from
 * `strict-csp-next/proxy`. Its entire import graph reaches NO Node built-ins:
 * it imports only `next/server`, the pure `planCsp` decision core (which uses
 * `globalThis.crypto.getRandomValues` for the nonce), and the shared types.
 * `strict-csp-next/proxy` cannot run on Edge because it statically imports
 * `node:fs` (manifest disk read) and `node:crypto` (nonce); this entry drops
 * both by requiring the manifest to be imported and passed in via
 * `options.manifest` — it never touches the disk.
 *
 * Per request it looks up the route's build-time inline-script hashes and, for
 * routes with request-time output (dynamic / PPR), a fresh nonce, then sets
 * `script-src 'self' <hashes> 'nonce-...'` on BOTH the request header (so the
 * Next.js render/resume stamps the nonce) and the response header. Static and
 * ISR routes are covered by hashes alone and stay cacheable.
 *
 * Use it in a Next.js 15 `middleware.js` on the Edge runtime (do NOT set
 * `runtime: 'nodejs'`):
 *
 * ```js
 * import { createStrictCspEdge } from 'strict-csp-next/proxy-edge'
 * import manifest from './.next/strict-csp-manifest.json' with { type: 'json' }
 * export const middleware = createStrictCspEdge({ manifest })
 * ```
 */
export function createStrictCspEdge(options: StrictCspEdgeOptions = {}) {
	return function strictCspEdge(request: NextRequest): NextResponse {
		// Edge-safe: the manifest is imported and passed in by the caller. When it
		// is absent, planCsp falls back to a nonce-only policy — we never read disk.
		const manifest = options.manifest ?? null;

		const plan = planCsp(manifest, request.nextUrl.pathname, options);

		// When static routes are served via CDN headers, leave them untouched.
		if (plan.skip) return NextResponse.next();

		const requestHeaders = new Headers(request.headers);
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
