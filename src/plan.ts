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

/**
 * Request headers a client must not control on the way into the render. An
 * inbound `Content-Security-Policy` would let a client choose the nonce Next
 * stamps (Next reads the nonce from this request header), and a stale `x-nonce`
 * would mislead app code that trusts it. The proxy re-sets the CSP (and x-nonce
 * when it mints one) after stripping.
 */
const CLIENT_CONTROLLED_REQUEST_HEADERS = [
	"content-security-policy",
	"content-security-policy-report-only",
	"x-nonce",
] as const;

/**
 * Return a copy of the request headers with client-controlled CSP / nonce
 * headers removed. Pure and runtime-agnostic (uses the global `Headers`), so it
 * is unit-testable and shared by the Node and Edge proxies.
 */
export function sanitizeRequestHeaders(headers: Headers): Headers {
	const out = new Headers(headers);
	for (const name of CLIENT_CONTROLLED_REQUEST_HEADERS) out.delete(name);
	return out;
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
	// The SRI `'self'`-drop applies to the static/ISR hash path only (the modes
	// documented on RouteEntry.externalIntegrity). Nonce-bearing routes (PPR /
	// dynamic) cover every script with the per-request nonce + strict-dynamic, so
	// they neither need nor should branch on integrity here. Passing integrity
	// only for the hash-only path keeps `buildPolicy`'s gating intent and the doc
	// aligned (#8a).
	const useIntegrity = !needsNonce;
	const policy = buildPolicy(
		entry?.shellHashes ?? [],
		nonce,
		options,
		useIntegrity ? entry?.externalIntegrity : undefined,
		useIntegrity ? entry?.uncoveredExternal : undefined,
	);

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
