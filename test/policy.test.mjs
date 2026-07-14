import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPolicy, cspHeaderName } from "../dist/index.js";

test("buildPolicy includes self, hashes, and nonce in script-src", () => {
	const csp = buildPolicy(["'sha256-abc'"], "NONCE123", {});
	assert.match(csp, /script-src 'self' 'sha256-abc' 'nonce-NONCE123'/);
	assert.match(csp, /default-src 'self'/);
	assert.match(csp, /object-src 'none'/);
});

test("buildPolicy omits the nonce when null (static route)", () => {
	const csp = buildPolicy(["'sha256-abc'"], null, {});
	assert.match(csp, /script-src 'self' 'sha256-abc'/);
	assert.doesNotMatch(csp, /nonce-/);
});

test("cspHeaderName respects report-only mode", () => {
	assert.equal(cspHeaderName({}), "content-security-policy");
	assert.equal(
		cspHeaderName({ mode: "report-only" }),
		"content-security-policy-report-only",
	);
});

test("buildPolicy merges custom directives and reportUri", () => {
	const csp = buildPolicy([], "n", {
		directives: { "connect-src": ["'self'", "https://api.example.com"] },
		reportUri: "/csp-report",
	});
	assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com/);
	assert.match(csp, /report-uri \/csp-report/);
});

test("buildPolicy rejects policy injection via directive values", () => {
	assert.throws(
		() =>
			buildPolicy([], "n", {
				directives: { "img-src": ["x; script-src 'unsafe-inline'"] },
			}),
		/unsafe value/,
	);
});

test("buildPolicy rejects injection via directive name and CRLF reportUri", () => {
	assert.throws(
		() =>
			buildPolicy([], "n", {
				directives: { "x; script-src 'unsafe-inline' #": true },
			}),
		/invalid CSP directive name/,
	);
	assert.throws(
		() => buildPolicy([], "n", { reportUri: "/r\r\nSet-Cookie: x=1" }),
		/unsafe value/,
	);
});

test("buildPolicy merges script-src additions but strips unsafe-inline/eval", () => {
	const csp = buildPolicy([], "n", {
		directives: {
			"script-src": [
				"https://cdn.example.com",
				"'unsafe-inline'",
				"'unsafe-eval'",
			],
		},
	});
	assert.match(csp, /script-src 'self' 'nonce-n' https:\/\/cdn\.example\.com/);
	// Only the script-src directive must be free of unsafe-inline/eval.
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.doesNotMatch(scriptSrc, /unsafe-inline/);
	assert.doesNotMatch(scriptSrc, /unsafe-eval/);
});

test("unsafe sources are stripped from script-src-elem/-attr and default-src", () => {
	const csp = buildPolicy([], "n", {
		directives: {
			"script-src-elem": ["https://cdn.example.com", "'unsafe-inline'"],
			"script-src-attr": ["'unsafe-inline'"],
			"default-src": ["'self'", "'unsafe-inline'"],
		},
	});
	const dir = (name) => csp.split("; ").find((d) => d.startsWith(name));
	assert.doesNotMatch(dir("script-src-elem"), /unsafe-inline/);
	assert.match(dir("script-src-elem"), /https:\/\/cdn\.example\.com/);
	assert.doesNotMatch(dir("script-src-attr"), /unsafe-inline/);
	assert.doesNotMatch(dir("default-src"), /unsafe-inline/);
});

test("script-src-elem/-attr mirror the computed script-src credentials", () => {
	// A caller who adds a more-specific script directive must not shadow the
	// library-owned script-src: CSP3 uses script-src-elem for <script> elements and
	// does not fall back, so the hashes + nonce have to be mirrored into it.
	const csp = buildPolicy(["'sha256-shell'"], "NONCE123", {
		directives: {
			"script-src-elem": ["https://cdn.example.com"],
			"script-src-attr": ["'none'"],
		},
	});
	const dir = (name) => csp.split("; ").find((d) => d.startsWith(name));
	const elem = dir("script-src-elem");
	assert.match(elem, /'self'/);
	assert.match(elem, /'sha256-shell'/);
	assert.match(elem, /'nonce-NONCE123'/);
	assert.match(elem, /https:\/\/cdn\.example\.com/); // caller's extra source kept
	const attr = dir("script-src-attr");
	assert.match(attr, /'sha256-shell'/);
	assert.match(attr, /'nonce-NONCE123'/);
	// `'none'` is dropped once real credentials are mirrored in (it is only valid
	// as the sole source; leftover `'none'` is ignored by browsers but flags tools).
	assert.doesNotMatch(attr, /'none'/);
});

test("credential mirroring matches script directives case-insensitively", () => {
	// CSP directive names are case-insensitive, so `Script-Src-Elem` shadows
	// script-src in the browser just the same and must get the mirrored credentials.
	const csp = buildPolicy(["'sha256-shell'"], "NONCE123", {
		directives: { "Script-Src-Elem": ["https://cdn.example.com"] },
	});
	const elem = csp.split("; ").find((d) => d.startsWith("Script-Src-Elem"));
	assert.match(elem, /'sha256-shell'/);
	assert.match(elem, /'nonce-NONCE123'/);
	assert.match(elem, /https:\/\/cdn\.example\.com/);
});

test("Next's nonce reader finds the nonce even with a caller script-src-elem", () => {
	// Reproduces Next 15.5 / 16 getScriptNonceFromHeader: it takes the FIRST
	// `script-src*` directive (dir.startsWith('script-src')), which is
	// `script-src-elem` here because it sorts before `script-src`. Mirroring the
	// credentials means Next reads a valid nonce instead of undefined.
	const csp = buildPolicy(["'sha256-shell'"], "NONCEabc_-123", {
		directives: { "script-src-elem": ["'self'"] },
	});
	const CSP_NONCE_SOURCE_REGEX = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/;
	const directives = csp.split(";").map((d) => d.trim());
	const directive =
		directives.find((d) => d.startsWith("script-src")) ||
		directives.find((d) => d.startsWith("default-src"));
	assert.equal(directive.startsWith("script-src-elem"), true); // the shadowing one
	let nonce;
	for (const source of directive.split(/\s+/).slice(1)) {
		const m = source.trim().match(CSP_NONCE_SOURCE_REGEX);
		if (m) {
			nonce = m[1];
			break;
		}
	}
	assert.equal(nonce, "NONCEabc_-123");
});

test("unsafe-hashes is also stripped from script-src additions", () => {
	const csp = buildPolicy([], "n", {
		directives: {
			"script-src": ["'unsafe-hashes'", "https://cdn.example.com"],
		},
	});
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.doesNotMatch(scriptSrc, /unsafe-hashes/);
	assert.match(scriptSrc, /https:\/\/cdn\.example\.com/);
});

test("a space-packed element cannot smuggle a banned source past the strip", () => {
	const csp = buildPolicy([], "n", {
		directives: { "script-src": ["'self' 'unsafe-inline'"] },
	});
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.doesNotMatch(scriptSrc, /unsafe-inline/);
});

test("strictDynamic adds strict-dynamic to script-src", () => {
	const csp = buildPolicy(["'sha256-a'"], "n", { strictDynamic: true });
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.match(scriptSrc, /'strict-dynamic'/);
});

test("reportTo emits a report-to directive", () => {
	const csp = buildPolicy([], "n", { reportTo: "csp-endpoint" });
	assert.match(csp, /report-to csp-endpoint/);
});

test("dev keeps style-src unsafe-inline even with styleNonce, and adds unsafe-eval", () => {
	const prev = process.env.NODE_ENV;
	process.env.NODE_ENV = "development";
	try {
		const csp = buildPolicy([], "n", { styleNonce: true });
		assert.match(csp, /style-src 'self' 'unsafe-inline'/);
		const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
		assert.match(scriptSrc, /'unsafe-eval'/);
	} finally {
		process.env.NODE_ENV = prev;
	}
});

test("styleNonce uses the nonce for style-src when a nonce is present", () => {
	const nonced = buildPolicy([], "n", { styleNonce: true });
	assert.match(nonced, /style-src 'self' 'nonce-n'/);
	assert.doesNotMatch(nonced, /style-src[^;]*unsafe-inline/);
	// Without a nonce (static route), it falls back to unsafe-inline.
	const staticCsp = buildPolicy(["'sha256-a'"], null, { styleNonce: true });
	assert.match(staticCsp, /style-src 'self' 'unsafe-inline'/);
});

test("SRI path: externalIntegrity omits self, includes hashes and strict-dynamic", () => {
	const csp = buildPolicy(
		["'sha256-abc'"],
		null,
		{},
		["'sha256-xyz'", "'sha256-def'"],
		0, // every external tag is pinned (explicit full coverage)
	);
	// No 'self' — scripts are hash-pinned.
	assert.doesNotMatch(csp, /script-src[^;]*'self'/);
	// Inline hashes present.
	assert.match(csp, /'sha256-abc'/);
	// Integrity hashes present.
	assert.match(csp, /'sha256-xyz'/);
	assert.match(csp, /'sha256-def'/);
	// strict-dynamic is auto-enabled for runtime chunk propagation.
	assert.match(csp, /'strict-dynamic'/);
});

test("SRI path: empty externalIntegrity falls back to self", () => {
	const csp = buildPolicy(["'sha256-abc'"], null, {}, []);
	assert.match(csp, /script-src 'self' 'sha256-abc'/);
	assert.doesNotMatch(csp, /'strict-dynamic'/);
});

test("SRI path: undefined externalIntegrity falls back to self", () => {
	const csp = buildPolicy(["'sha256-abc'"], null, {});
	assert.match(csp, /script-src 'self' 'sha256-abc'/);
});

test("SRI path with nonce keeps nonce alongside integrity hashes", () => {
	const csp = buildPolicy(
		["'sha256-shell'"],
		"NONCE",
		{},
		["'sha256-chunk'"],
		0, // explicit full coverage
	);
	assert.match(csp, /'nonce-NONCE'/);
	assert.match(csp, /'sha256-chunk'/);
	assert.match(csp, /'strict-dynamic'/);
	assert.doesNotMatch(csp, /script-src[^;]*'self'/);
});

test("coverage gate: partial SRI coverage keeps 'self' and drops strict-dynamic", () => {
	// 5 integrity hashes but 2 external tags un-pinned (mirrors the export example:
	// 7 external tags, 5 covered). 'self' MUST stay so the 2 un-pinned same-origin
	// chunks still load, and strict-dynamic must NOT be forced (it would make the
	// browser ignore 'self' and block them).
	const csp = buildPolicy(
		["'sha256-inline'"],
		null,
		{},
		["'sha256-a'", "'sha256-b'", "'sha256-c'", "'sha256-d'", "'sha256-e'"],
		2, // uncoveredExternal
	);
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.match(scriptSrc, /'self'/);
	assert.doesNotMatch(scriptSrc, /'strict-dynamic'/);
	// The hashes we do have are still listed.
	assert.match(scriptSrc, /'sha256-a'/);
	assert.match(scriptSrc, /'sha256-inline'/);
});

test("coverage gate: zero uncovered drops 'self' and forces strict-dynamic", () => {
	const csp = buildPolicy(
		["'sha256-inline'"],
		null,
		{},
		["'sha256-a'", "'sha256-b'"],
		0, // every external tag is pinned
	);
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.doesNotMatch(scriptSrc, /'self'/);
	assert.match(scriptSrc, /'strict-dynamic'/);
	assert.match(scriptSrc, /'sha256-a'/);
});

test("coverage gate (fail-safe): externalIntegrity present + uncovered undefined keeps 'self'", () => {
	// Integrity hashes present but the uncovered count is unknown (undefined). We
	// cannot prove full coverage, so the fail-safe keeps 'self' and does NOT force
	// 'strict-dynamic' — never drop 'self' on unproven coverage.
	const csp = buildPolicy(["'sha256-inline'"], null, {}, ["'sha256-a'"]);
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.match(scriptSrc, /'self'/);
	assert.doesNotMatch(scriptSrc, /'strict-dynamic'/);
	// The hashes we do have are still listed.
	assert.match(scriptSrc, /'sha256-a'/);
	assert.match(scriptSrc, /'sha256-inline'/);
});
