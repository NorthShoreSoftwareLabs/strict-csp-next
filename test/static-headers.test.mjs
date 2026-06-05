import assert from "node:assert/strict";
import { test } from "node:test";
import { staticCspHeaders } from "../dist/index.js";

const manifest = {
	version: 1,
	algorithm: "sha256",
	routes: [
		{ route: "/", mode: "static", shellHashes: ["'sha256-a'"] },
		{ route: "/news", mode: "isr", shellHashes: ["'sha256-b'"] },
		{ route: "/app", mode: "ppr", shellHashes: ["'sha256-c'"] },
		{ route: "/api-page", mode: "dynamic", shellHashes: [] },
	],
};

test("staticCspHeaders emits only static and isr routes", () => {
	const entries = staticCspHeaders(manifest);
	assert.deepEqual(entries.map((e) => e.source).sort(), ["/", "/news"]);
});

test("static header values carry hashes but no nonce", () => {
	const entries = staticCspHeaders(manifest);
	for (const e of entries) {
		const value = e.headers[0].value;
		assert.match(value, /script-src 'self' 'sha256-/);
		assert.doesNotMatch(value, /nonce-/);
		assert.equal(e.headers[0].key, "content-security-policy");
	}
});

test("report-only mode changes the header key", () => {
	const entries = staticCspHeaders(manifest, { mode: "report-only" });
	assert.equal(
		entries[0].headers[0].key,
		"content-security-policy-report-only",
	);
});

test("null manifest yields no entries", () => {
	assert.deepEqual(staticCspHeaders(null), []);
});
