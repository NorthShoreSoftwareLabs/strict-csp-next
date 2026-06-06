import type { StrictCspOptions } from "./types.js";

const DEFAULT_DIRECTIVES: Record<string, string[] | true> = {
	"default-src": ["'self'"],
	"base-uri": ["'self'"],
	"object-src": ["'none'"],
	"frame-ancestors": ["'none'"],
	"img-src": ["'self'", "blob:", "data:"],
	"font-src": ["'self'"],
	"form-action": ["'self'"],
	"upgrade-insecure-requests": true,
};

// A valid CSP directive name: a letter followed by letters, digits, or hyphens.
const DIRECTIVE_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;
// Characters that would split the header into extra directives or split the
// response itself. Rejecting them closes the policy-injection class of bug.
const UNSAFE_VALUE = /[;,\r\n]/;
// Sources we never let a caller add back, since the whole point is strictness.
// `unsafe-hashes` is included because it re-enables inline event handlers, which
// defeats a strict script policy just like `unsafe-inline`.
const BANNED_SCRIPT_SRC = new Set([
	"'unsafe-inline'",
	"'unsafe-eval'",
	"'unsafe-hashes'",
]);
// Directives that govern script execution. A banned source slipped into ANY of
// these re-opens inline scripts, because CSP3 browsers consult the more specific
// `-elem` / `-attr` directive (and fall back to `default-src`) instead of
// `script-src`. So the strip has to cover all of them, not just `script-src`.
const SCRIPT_DIRECTIVES = new Set([
	"script-src",
	"script-src-elem",
	"script-src-attr",
	"default-src",
]);

function assertSafeValue(name: string, value: string): void {
	if (UNSAFE_VALUE.test(value)) {
		throw new Error(
			`strict-csp-next: refusing to build a policy with an unsafe value in ` +
				`"${name}": ${JSON.stringify(value)} (contains ';', ',', CR, or LF)`,
		);
	}
}

function validateDirectives(directives: Record<string, string[] | true>): void {
	for (const [name, value] of Object.entries(directives)) {
		if (!DIRECTIVE_NAME.test(name)) {
			throw new Error(
				`strict-csp-next: invalid CSP directive name ${JSON.stringify(name)}`,
			);
		}
		if (value !== true) {
			for (const v of value) assertSafeValue(name, v);
		}
	}
}

/**
 * Drop any source-list entry that contains a banned token. Each entry is split
 * on whitespace first, so a single element packing two tokens together (e.g.
 * `"'self' 'unsafe-inline'"`) can't smuggle a banned source past an exact-match
 * check. A matching element is dropped whole; pass sources as separate array
 * elements (the normal shape) to keep the safe ones.
 */
function stripBannedSources(values: string[]): string[] {
	return values.filter(
		(v) =>
			!v
				.split(/\s+/)
				.some((tok) => BANNED_SCRIPT_SRC.has(tok.trim().toLowerCase())),
	);
}

/**
 * Return a copy of the caller's directives with banned sources removed from any
 * script-governing directive (`script-src`, `script-src-elem`,
 * `script-src-attr`, `default-src`). `script-src` itself is rebuilt by the
 * library, but the sanitized copy still flows through for the others.
 */
function sanitizeScriptDirectives(
	directives: Record<string, string[] | true>,
): Record<string, string[] | true> {
	const out: Record<string, string[] | true> = {};
	for (const [name, value] of Object.entries(directives)) {
		if (value !== true && SCRIPT_DIRECTIVES.has(name.toLowerCase())) {
			out[name] = stripBannedSources(value);
		} else {
			out[name] = value;
		}
	}
	return out;
}

/**
 * Build a Content-Security-Policy string for one response.
 *
 * `script-src` is owned by the library. The exact shape depends on what
 * credentials are available:
 *
 * - **SRI path** (`externalIntegrity` non-empty AND every external script
 *   hash-pinned, i.e. `uncoveredExternal === 0`): inline hashes + integrity
 *   hashes + `'strict-dynamic'`. No `'self'` — every initial script is
 *   hash-pinned, and strict-dynamic propagates trust to runtime chunks.
 *   CSP Evaluator sees green.
 * - **Partial-coverage fallback** (`externalIntegrity` non-empty but some
 *   external chunk lacks `integrity`): KEEP `'self'`, list the integrity hashes
 *   we do have, and do NOT force `'strict-dynamic'`. `'self'` covers the
 *   un-pinned same-origin chunk; dropping `'self'` here would block it under
 *   strict-dynamic and ship a broken page. This is the #2 safety gate.
 * - **Static fallback** (no nonce, no integrity hashes): `'self'` + inline
 *   hashes (+ optional `'strict-dynamic'`). External chunks covered by
 *   `'self'`; CSP Evaluator flags it.
 * - **Dynamic** (nonce present): `'self'` + inline hashes + per-request nonce
 *   (+ optional `'strict-dynamic'`).
 *
 * Caller additions to `script-src` are merged in, except `'unsafe-inline'`
 * and `'unsafe-eval'`, which are stripped so the strict guarantee holds. All
 * directive names and values are validated to prevent policy injection.
 *
 * @param externalIntegrity - SRI integrity hashes from `<script>` tags in
 *   prerendered HTML (e.g. `['sha256-abc']`). Pass `[]` or `undefined` when
 *   unavailable.
 * @param uncoveredExternal - Count of external `<script src>` tags on the route
 *   that lack an `integrity` attribute. When > 0, the SRI `'self'`-drop is
 *   suppressed. Omit (or `undefined`) to preserve the historical behavior of
 *   trusting `externalIntegrity` presence alone (treated as fully covered).
 */
export function buildPolicy(
	shellHashes: string[],
	nonce: string | null,
	options: StrictCspOptions = {},
	externalIntegrity?: string[],
	uncoveredExternal?: number,
): string {
	const isDev = process.env.NODE_ENV === "development";
	const userDirectives = options.directives ?? {};
	validateDirectives(userDirectives);

	// Strip banned sources from EVERY script-governing directive a caller passed,
	// not just `script-src`, so `script-src-elem`/`script-src-attr`/`default-src`
	// can't be used to smuggle `'unsafe-inline'` back in.
	const sanitizedUserDirectives = sanitizeScriptDirectives(userDirectives);

	const userScriptSrc = Array.isArray(sanitizedUserDirectives["script-src"])
		? (sanitizedUserDirectives["script-src"] as string[])
		: [];

	const hasIntegrity = !!externalIntegrity && externalIntegrity.length > 0;
	// Full coverage means every external script tag is hash-pinned. An explicit
	// uncovered count gates the drop; when omitted, fall back to the historical
	// "presence implies coverage" behavior so older manifests still work.
	const fullyCovered =
		uncoveredExternal === undefined || uncoveredExternal === 0;
	const sriPath = hasIntegrity && fullyCovered;

	let scriptSrc: string[];
	if (sriPath) {
		// SRI path: every initial script is hash-pinned. No 'self' needed, and
		// strict-dynamic propagates trust to runtime chunks.
		scriptSrc = [
			...shellHashes,
			...(externalIntegrity ?? []),
			...(nonce ? [`'nonce-${nonce}'`] : []),
			"'strict-dynamic'",
			...userScriptSrc,
			...(isDev ? ["'unsafe-eval'"] : []),
		];
	} else if (hasIntegrity) {
		// Partial coverage (#2 safety gate): some external chunk has no integrity.
		// Keep 'self' so the un-pinned same-origin chunk still loads, list the
		// hashes we do have, and DO NOT force 'strict-dynamic' (it would make the
		// browser ignore 'self' and block that chunk).
		scriptSrc = [
			"'self'",
			...shellHashes,
			...(externalIntegrity ?? []),
			...(nonce ? [`'nonce-${nonce}'`] : []),
			...(options.strictDynamic ? ["'strict-dynamic'"] : []),
			...userScriptSrc,
			...(isDev ? ["'unsafe-eval'"] : []),
		];
	} else {
		scriptSrc = [
			"'self'",
			...shellHashes,
			...(nonce ? [`'nonce-${nonce}'`] : []),
			...(options.strictDynamic ? ["'strict-dynamic'"] : []),
			...userScriptSrc,
			...(isDev ? ["'unsafe-eval'"] : []),
		];
	}

	// Inline styles: 'unsafe-inline' by default (styled-jsx and CSS-in-JS need it).
	// Opt into nonced styles with `styleNonce: true` when a nonce is present. In
	// dev we always keep 'unsafe-inline' so the error overlay and fast-refresh
	// styles render.
	const styleSrc =
		options.styleNonce && nonce && !isDev
			? ["'self'", `'nonce-${nonce}'`]
			: ["'self'", "'unsafe-inline'"];

	const directives: Record<string, string[] | true> = {
		...DEFAULT_DIRECTIVES,
		...sanitizedUserDirectives,
		"style-src": styleSrc,
		"script-src": scriptSrc,
	};

	if (options.reportUri) {
		assertSafeValue("report-uri", options.reportUri);
		directives["report-uri"] = [options.reportUri];
	}

	if (options.reportTo) {
		assertSafeValue("report-to", options.reportTo);
		directives["report-to"] = [options.reportTo];
	}

	return Object.entries(directives)
		.map(([name, value]) =>
			value === true ? name : `${name} ${(value as string[]).join(" ")}`,
		)
		.join("; ");
}

// Directives that a <meta http-equiv> CSP cannot express (browsers ignore them
// when the policy is delivered via meta), so we drop them from the meta policy.
const META_INVALID = new Set([
	"frame-ancestors",
	"report-uri",
	"report-to",
	"sandbox",
]);

/**
 * A hashes-only policy suitable for a `<meta http-equiv>` tag in static export.
 * No nonce (there is no server), and directives invalid in meta are dropped.
 */
export function buildMetaPolicy(
	shellHashes: string[],
	options: StrictCspOptions = {},
	externalIntegrity?: string[],
	uncoveredExternal?: number,
): string {
	return buildPolicy(
		shellHashes,
		null,
		options,
		externalIntegrity,
		uncoveredExternal,
	)
		.split("; ")
		.filter((directive) => !META_INVALID.has(directive.split(" ")[0] ?? ""))
		.join("; ");
}

export const CSP_HEADER = "content-security-policy";
export const CSP_REPORT_ONLY_HEADER = "content-security-policy-report-only";

export function cspHeaderName(options: StrictCspOptions = {}): string {
	return options.mode === "report-only" ? CSP_REPORT_ONLY_HEADER : CSP_HEADER;
}
