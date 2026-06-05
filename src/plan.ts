import { lookupRoute } from "./lookup.js";
import { buildPolicy, cspHeaderName } from "./policy.js";
import type { CspManifest, StrictCspOptions } from "./types.js";

export interface CspPlanOptions extends StrictCspOptions {
	/** Skip routes covered by CDN-terminal static headers (`static` / `isr`). */
	skipStatic?: boolean;
}

export interface CspPlan {
	/** True when the route should be left untouched (skipStatic hit). */
	skip: boolean;
	/** The policy string, or null when `skip` is true. */
	policy: string | null;
	/** The per-request nonce, or null for hash-only (static) routes. */
	nonce: string | null;
	/** Response header name (enforce vs report-only). */
	headerName: string;
	/** Whether the response must be `Cache-Control: no-store`. */
	noStore: boolean;
	/** `Reporting-Endpoints` header value, or null. */
	reportingEndpoints: string | null;
}

/** URL-safe base64 nonce (no `+` `/` `=`), 128 bits of entropy. */
export function generateNonce(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * The pure decision core of the proxy: given a manifest, a pathname, and the
 * options, decide the policy, whether a nonce is needed, the header name, and
 * whether the response must avoid caching. No `next/server` dependency, so it is
 * directly unit-testable. `createStrictCsp` wires this onto the request/response.
 */
export function planCsp(
	manifest: CspManifest | null | undefined,
	pathname: string,
	options: CspPlanOptions = {},
): CspPlan {
	const entry = lookupRoute(manifest, pathname);
	const headerName = cspHeaderName(options);

	if (
		options.skipStatic &&
		(entry?.mode === "static" || entry?.mode === "isr")
	) {
		return {
			skip: true,
			policy: null,
			nonce: null,
			headerName,
			noStore: false,
			reportingEndpoints: null,
		};
	}

	const needsNonce = !entry || entry.mode === "ppr" || entry.mode === "dynamic";
	const nonce = needsNonce ? generateNonce() : null;
	const policy = buildPolicy(entry?.shellHashes ?? [], nonce, options);

	// Only ENFORCED nonced responses must avoid caching. In report-only nothing is
	// blocked, so a replayed nonce can't be exploited and caching is fine.
	const noStore = nonce !== null && options.mode !== "report-only";

	let reportingEndpoints: string | null = null;
	if (
		options.reportTo &&
		options.reportToEndpoint &&
		!/[\r\n"]/.test(options.reportTo) &&
		!/[\r\n"]/.test(options.reportToEndpoint)
	) {
		reportingEndpoints = `${options.reportTo}="${options.reportToEndpoint}"`;
	}

	return {
		skip: false,
		policy,
		nonce,
		headerName,
		noStore,
		reportingEndpoints,
	};
}
