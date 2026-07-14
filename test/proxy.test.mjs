import assert from "node:assert/strict";
import { test } from "node:test";
// planCsp is the pure decision core of the proxy. Testing it here exercises the
// security-critical branches (nonce, no-store, report-only, skipStatic) in
// milliseconds, without needing the Next.js runtime that the e2e matrix covers.
import { planCsp, sanitizeRequestHeaders } from "../dist/index.js";

const manifest = {
	version: 1,
	algorithm: "sha256",
	routes: [
		{ route: "/", mode: "static", shellHashes: ["'sha256-a'"] },
		{ route: "/blog", mode: "ppr", shellHashes: ["'sha256-b'"] },
		{ route: "/feed", mode: "isr", shellHashes: ["'sha256-c'"] },
	],
};

test("static route: hashes, no nonce, stays cacheable", () => {
	const p = planCsp(manifest, "/");
	assert.match(p.policy, /script-src 'self' 'sha256-a'/);
	assert.doesNotMatch(p.policy, /nonce-/);
	assert.equal(p.nonce, null);
	assert.equal(p.noStore, false);
	assert.equal(p.skip, false);
});

test("PPR route: shell hash + nonce, and no-store", () => {
	const p = planCsp(manifest, "/blog");
	assert.match(p.policy, /script-src 'self' 'sha256-b' 'nonce-[^']+'/);
	assert.ok(p.nonce);
	assert.equal(p.noStore, true);
});

test("unknown (dynamic) route: nonce, no hash, no-store", () => {
	const p = planCsp(manifest, "/whatever");
	assert.match(p.policy, /script-src 'self' 'nonce-[^']+'/);
	assert.doesNotMatch(p.policy, /sha256-/);
	assert.equal(p.noStore, true);
});

test("report-only: nonce set, but caching is NOT sacrificed", () => {
	const p = planCsp(manifest, "/blog", { mode: "report-only" });
	assert.equal(p.headerName, "content-security-policy-report-only");
	assert.ok(p.nonce);
	assert.equal(p.noStore, false);
});

test("skipStatic leaves static and isr routes untouched", () => {
	assert.equal(planCsp(manifest, "/", { skipStatic: true }).skip, true);
	assert.equal(planCsp(manifest, "/feed", { skipStatic: true }).skip, true);
});

test("skipStatic still covers PPR routes", () => {
	const p = planCsp(manifest, "/blog", { skipStatic: true });
	assert.equal(p.skip, false);
	assert.match(p.policy, /'nonce-[^']+'/);
});

test("a null manifest yields a nonce-only policy (still strict)", () => {
	const p = planCsp(null, "/blog");
	assert.match(p.policy, /script-src 'self' 'nonce-[^']+'/);
	assert.doesNotMatch(p.policy, /sha256-/);
	assert.equal(p.noStore, true);
});

test("Reporting-Endpoints is built from reportTo + endpoint", () => {
	const p = planCsp(manifest, "/blog", {
		reportTo: "csp",
		reportToEndpoint: "https://example.com/r",
	});
	assert.equal(p.reportingEndpoints, 'csp="https://example.com/r"');
});

test("Reporting-Endpoints rejects header-splitting values", () => {
	const p = planCsp(manifest, "/blog", {
		reportTo: "csp",
		reportToEndpoint: 'https://x/r"\r\nSet-Cookie: a=1',
	});
	assert.equal(p.reportingEndpoints, null);
});

test("PPR route ignores externalIntegrity: keeps 'self', nonce-covered (#8a)", () => {
	// The SRI 'self'-drop is the static/ISR hash path only. A nonce-bearing route
	// must NOT branch on integrity (the per-request nonce + strict-dynamic cover
	// every script), so 'self' and the nonce stay regardless of manifest integrity.
	const m = {
		version: 1,
		algorithm: "sha256",
		routes: [
			{
				route: "/app",
				mode: "ppr",
				shellHashes: ["'sha256-shell'"],
				externalIntegrity: ["'sha256-chunk'"],
				uncoveredExternal: 0,
			},
		],
	};
	const p = planCsp(m, "/app");
	const scriptSrc = p.policy
		.split("; ")
		.find((d) => d.startsWith("script-src"));
	assert.match(scriptSrc, /'self'/);
	assert.match(scriptSrc, /'nonce-[^']+'/);
	// It does not list the integrity hash (that is the static/ISR path's job).
	assert.doesNotMatch(scriptSrc, /'sha256-chunk'/);
});

test("static route with full SRI coverage drops 'self' via planCsp", () => {
	const m = {
		version: 1,
		algorithm: "sha256",
		routes: [
			{
				route: "/",
				mode: "static",
				shellHashes: ["'sha256-shell'"],
				externalIntegrity: ["'sha256-chunk'"],
				uncoveredExternal: 0,
			},
		],
	};
	const scriptSrc = planCsp(m, "/")
		.policy.split("; ")
		.find((d) => d.startsWith("script-src"));
	assert.doesNotMatch(scriptSrc, /'self'/);
	assert.match(scriptSrc, /'sha256-chunk'/);
	assert.match(scriptSrc, /'strict-dynamic'/);
});

test("static route with PARTIAL SRI coverage keeps 'self' via planCsp", () => {
	const m = {
		version: 1,
		algorithm: "sha256",
		routes: [
			{
				route: "/",
				mode: "static",
				shellHashes: ["'sha256-shell'"],
				externalIntegrity: ["'sha256-chunk'"],
				uncoveredExternal: 2,
			},
		],
	};
	const scriptSrc = planCsp(m, "/")
		.policy.split("; ")
		.find((d) => d.startsWith("script-src"));
	assert.match(scriptSrc, /'self'/);
	assert.doesNotMatch(scriptSrc, /'strict-dynamic'/);
});

test("sanitizeRequestHeaders strips client-controlled CSP and x-nonce", () => {
	const incoming = new Headers({
		"content-security-policy": "script-src 'unsafe-inline'",
		"content-security-policy-report-only": "script-src 'unsafe-inline'",
		"x-nonce": "attacker-chosen",
		"user-agent": "test", // an unrelated header is preserved
	});
	const clean = sanitizeRequestHeaders(incoming);
	assert.equal(clean.get("content-security-policy"), null);
	assert.equal(clean.get("content-security-policy-report-only"), null);
	assert.equal(clean.get("x-nonce"), null);
	assert.equal(clean.get("user-agent"), "test");
	// The input is not mutated (a fresh Headers is returned).
	assert.equal(incoming.get("x-nonce"), "attacker-chosen");
});

test("each request gets a unique nonce", () => {
	const a = planCsp(manifest, "/blog").nonce;
	const b = planCsp(manifest, "/blog").nonce;
	assert.notEqual(a, b);
	// URL-safe base64: no +, /, or =.
	assert.doesNotMatch(a, /[+/=]/);
});
