export type HashAlgorithm = "sha256" | "sha384" | "sha512";

/**
 * How a route is rendered, which determines which credential covers its inline
 * scripts:
 * - `static`  : fully prerendered. All inline scripts are baked at build and
 *               covered by their hashes. No nonce needed.
 * - `ppr`     : partial prerender / Cache Components. The prerendered shell's
 *               bare inline scripts are covered by hashes; everything the
 *               request-time resume streams is covered by the per-request nonce.
 * - `isr`     : prerendered with revalidation. With the build-time static header,
 *               the hashes only hold while the inline data is stable across
 *               revalidations. Cover it with the cache handler
 *               (`withStrictCspCache`) to recompute the hashes on every
 *               revalidation, so changing data never breaks the policy (see README).
 * - `dynamic` : rendered per request. Every inline script is covered by the
 *               per-request nonce.
 */
export type RouteMode = "static" | "isr" | "ppr" | "dynamic";

export interface RouteEntry {
	/** URL path, e.g. "/" or "/blog" (concrete paths only in v0.1). */
	route: string;
	mode: RouteMode;
	/**
	 * CSP source expressions for the bare inline scripts found in this route's
	 * prerendered HTML, e.g. ["'sha256-...'"]. Empty for purely dynamic routes.
	 */
	shellHashes: string[];
	/**
	 * CSP source expressions for external `<script src>` tags, extracted from
	 * the `integrity` attribute added by Next.js when `experimental.sri` is
	 * enabled (and topped up by the postbuild integrity backfill). Each entry is
	 * ready to use in `script-src` (e.g. `'sha256-abc123'`). Deduplicated.
	 *
	 * The policy omits `'self'` and forces `'strict-dynamic'` only when this is
	 * non-empty AND `uncoveredExternal` is 0 — i.e. every external script on the
	 * route is hash-pinned. With any un-pinned external chunk, the policy keeps
	 * the safe `'self' <inline> <integrity>` shape (no `'strict-dynamic'`) so the
	 * un-pinned same-origin chunk still loads. Absent or empty for routes without
	 * integrity attributes.
	 */
	externalIntegrity?: string[];
	/**
	 * Count of executable external `<script src>` tags on this route that LACK an
	 * `integrity` attribute (per-tag, not deduped by file). The coverage gate in
	 * `buildPolicy` drops `'self'` ONLY when this is an explicit `0` (fail-safe).
	 * Absent means "coverage unknown" and is treated as NOT fully covered, so the
	 * policy keeps `'self'`. The manifest therefore persists this field (even at 0)
	 * whenever `externalIntegrity` is present, so the fully-covered route still
	 * drops `'self'` after the manifest round-trip.
	 */
	uncoveredExternal?: number;
}

export interface CspManifest {
	version: 1;
	/** Next.js version the manifest was generated against, for drift diagnostics. */
	nextVersion?: string;
	algorithm: HashAlgorithm;
	routes: RouteEntry[];
}

export interface StrictCspOptions {
	/** Enforce the policy or only report violations. Default: "enforce". */
	mode?: "enforce" | "report-only";
	/**
	 * Extra directives merged into the policy. A value of `true` emits a
	 * valueless directive (e.g. `upgrade-insecure-requests`). Arrays are joined
	 * with spaces. Additions to `script-src` are merged with the library-managed
	 * sources, except `'unsafe-inline'` / `'unsafe-eval'`, which are stripped so
	 * the strict guarantee holds. Names and values containing `;`, `,`, CR, or LF
	 * are rejected to prevent policy injection.
	 */
	directives?: Record<string, string[] | true>;
	/** If set, adds a `report-uri` directive (deprecated, but widely supported). */
	reportUri?: string;
	/**
	 * If set, adds a `report-to <group>` directive. Pair it with a
	 * `Reporting-Endpoints` response header (the proxy sets this for you when
	 * `reportToEndpoint` is also provided) for modern violation reporting.
	 */
	reportTo?: string;
	/**
	 * The URL for the `report-to` group. When both `reportTo` and
	 * `reportToEndpoint` are set, the proxy emits a `Reporting-Endpoints:
	 * <group>="<url>"` response header. Ignored by static-header / meta delivery.
	 */
	reportToEndpoint?: string;
	/**
	 * Add `'strict-dynamic'` to `script-src`. The hashed shell scripts and the
	 * per-request nonce then propagate trust to scripts they inject, so loaders
	 * like Google Tag Manager, Segment, and `next/script` work without
	 * host-allowlisting each origin. Note: CSP3 browsers ignore host and `'self'`
	 * allowlists in `script-src` once `'strict-dynamic'` is present (hashes and
	 * nonces still apply). Default: false.
	 */
	strictDynamic?: boolean;
	/**
	 * Cover inline styles with the per-request nonce instead of the default
	 * `style-src 'unsafe-inline'`. Only takes effect on routes that have a nonce
	 * (dynamic / PPR). Default: false.
	 */
	styleNonce?: boolean;
	/** Hash algorithm for inline-script hashes. Default: "sha256". */
	algorithm?: HashAlgorithm;
}
