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

// The more-specific script directives a caller may set. CSP3 browsers consult
// these for `<script>` elements / inline handlers and do NOT fall back to
// `script-src`, so the library-owned credentials must be mirrored into whichever
// of these the caller defines. Matched case-insensitively, since CSP directive
// names are case-insensitive (a `Script-Src-Elem` shadows `script-src` too).
const MORE_SPECIFIC_SCRIPT_DIRECTIVES = new Set([
	"script-src-elem",
	"script-src-attr",
]);

/** Dedupe a source list, preserving first-seen order. */
function dedupeSources(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

function assertSafeValue(name: string, value: string): void {
	if (UNSAFE_VALUE.test(value)) {
		throw new Error(
			`strict-csp-next: refusing to build a policy with an unsafe value in ` +
				`"${name}": ${JSON.stringify(value)} (contains ';', ',', CR, or LF)`,
		);
	}
}

// A manifest-sourced script token (an inline-shell hash or an external integrity
// hash) is spread verbatim into `script-src` and joined into the header. The
// manifest is a trusted build artifact, but every token is validated anyway (#23)
// so a corrupt or tampered manifest cannot inject a directive or re-open an
// unsafe-* source regardless of provenance. Stricter than `assertSafeValue`: it
// also rejects INNER WHITESPACE, since a single token packing
// `'sha256-x' 'unsafe-inline'` would otherwise smuggle a second source past the
// space-join.
const UNSAFE_SCRIPT_TOKEN = /[\s;,]/;

function assertSafeScriptToken(name: string, value: string): void {
	if (
		UNSAFE_SCRIPT_TOKEN.test(value) ||
		BANNED_SCRIPT_SRC.has(value.trim().toLowerCase())
	) {
		throw new Error(
			`strict-csp-next: refusing to build a policy with an unsafe ${name} token ` +
				`from the manifest: ${JSON.stringify(value)} (must be a single hash ` +
				`source with no whitespace, ';', ',', CR, LF, or unsafe-* keyword)`,
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
 * and `'unsafe-eval'`, which are stripped so the strict guarantee holds. A
 * caller-supplied `script-src-elem` / `script-src-attr` has the computed
 * `script-src` sources mirrored into it, so the more-specific directive cannot
 * shadow `script-src` and drop the hashes/nonce. All directive names and values
 * are validated to prevent policy injection.
 *
 * @param externalIntegrity - SRI integrity hashes from `<script>` tags in
 *   prerendered HTML (e.g. `['sha256-abc']`). Pass `[]` or `undefined` when
 *   unavailable.
 * @param uncoveredExternal - Count of external `<script src>` tags on the route
 *   that lack an `integrity` attribute. The SRI `'self'`-drop fires ONLY when this
 *   is explicitly `0` (provably full coverage). Any positive count, or `undefined`
 *   (coverage unknown), keeps `'self'` and suppresses forced `'strict-dynamic'` —
 *   the fail-safe default.
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

	// Defense-in-depth (#23): the manifest is a trusted build artifact, but its
	// hash/integrity tokens are spread into `script-src` below, so validate each
	// one with the same rigor as caller directives before it reaches the header.
	for (const v of shellHashes) assertSafeScriptToken("shellHashes", v);
	if (externalIntegrity) {
		for (const v of externalIntegrity) {
			assertSafeScriptToken("externalIntegrity", v);
		}
	}

	// Strip banned sources from EVERY script-governing directive a caller passed,
	// not just `script-src`, so `script-src-elem`/`script-src-attr`/`default-src`
	// can't be used to smuggle `'unsafe-inline'` back in.
	const sanitizedUserDirectives = sanitizeScriptDirectives(userDirectives);

	const userScriptSrc = Array.isArray(sanitizedUserDirectives["script-src"])
		? (sanitizedUserDirectives["script-src"] as string[])
		: [];

	const hasIntegrity = !!externalIntegrity && externalIntegrity.length > 0;
	// Full coverage means every external script tag is hash-pinned. Fail-safe: the
	// 'self'-drop fires ONLY on an explicit `uncoveredExternal === 0`. If integrity
	// is present but the uncovered count is unknown (`undefined`), we CANNOT prove
	// full coverage, so we keep 'self' and do not force 'strict-dynamic' — the same
	// safe partial-coverage path. Trusting presence alone would re-open the bug
	// where a manifest with non-empty hashes but partial coverage drops 'self'.
	const fullyCovered = uncoveredExternal === 0;
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

	// If a caller set `script-src-elem` / `script-src-attr`, it would otherwise
	// shadow the library-owned `script-src`: CSP3 browsers use the more-specific
	// directive for script elements/attributes and never fall back to `script-src`,
	// so those inline scripts would lose their hashes and nonce and be blocked. It
	// also breaks Next's nonce reader, which takes the FIRST `script-src*` directive
	// it finds (`dir.startsWith('script-src')`) and would read the credential-less
	// one, so the render stamps no nonce. Mirror the computed `script-src` sources
	// into any such directive the caller set (their extra sources kept, deduped) so
	// the strict credentials travel with the more-specific directive too. Iterate
	// the caller's real keys so mixed-case names (`Script-Src-Elem`) are covered.
	for (const name of Object.keys(directives)) {
		if (!MORE_SPECIFIC_SCRIPT_DIRECTIVES.has(name.toLowerCase())) continue;
		const userValue = directives[name];
		if (!Array.isArray(userValue)) continue;
		// Drop `'none'`: it only means "block everything" as the SOLE source. Once we
		// add the library credentials the list has other sources, where browsers
		// ignore `'none'` but CSP tooling flags it. The library guarantees the app's
		// own scripts run, so the credentials win over a caller's `'none'`.
		const extras = userValue.filter((v) => v.trim().toLowerCase() !== "'none'");
		directives[name] = dedupeSources([...scriptSrc, ...extras]);
	}

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
