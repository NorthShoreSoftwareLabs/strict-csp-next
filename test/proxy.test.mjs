import assert from "node:assert/strict";
import { test } from "node:test";
// planCsp is the pure decision core of the proxy. Testing it here exercises the
// security-critical branches (nonce, no-store, report-only, skipStatic) in
// milliseconds, without needing the Next.js runtime that the e2e matrix covers.
import { planCsp } from "../dist/index.js";

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

test("each request gets a unique nonce", () => {
	const a = planCsp(manifest, "/blog").nonce;
	const b = planCsp(manifest, "/blog").nonce;
	assert.notEqual(a, b);
	// URL-safe base64: no +, /, or =.
	assert.doesNotMatch(a, /[+/=]/);
});
