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
	const csp = buildPolicy(["'sha256-abc'"], null, {}, [
		"'sha256-xyz'",
		"'sha256-def'",
	]);
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
	const csp = buildPolicy(["'sha256-shell'"], "NONCE", {}, ["'sha256-chunk'"]);
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

test("coverage gate: omitted uncovered preserves historical presence-based drop", () => {
	// Older manifests carry no uncovered count; presence of integrity implies full
	// coverage (the prior behavior), so 'self' is dropped.
	const csp = buildPolicy(["'sha256-inline'"], null, {}, ["'sha256-a'"]);
	const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
	assert.doesNotMatch(scriptSrc, /'self'/);
	assert.match(scriptSrc, /'strict-dynamic'/);
});
