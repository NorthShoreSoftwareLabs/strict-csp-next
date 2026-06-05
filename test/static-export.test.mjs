import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	buildMetaPolicy,
	hashInlineScript,
	injectMetaCsp,
} from "../dist/index.js";

test("buildMetaPolicy has hashes, no nonce, and drops meta-invalid directives", () => {
	const csp = buildMetaPolicy(["'sha256-abc'"], {});
	assert.match(csp, /script-src 'self' 'sha256-abc'/);
	assert.doesNotMatch(csp, /nonce-/);
	assert.doesNotMatch(csp, /frame-ancestors/);
	assert.doesNotMatch(csp, /report-uri/);
});

let dir;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "exp-"));
	writeFileSync(
		join(dir, "index.html"),
		"<!doctype html><html><head><title>x</title></head><body>" +
			"<script>self.__next_f=[]</script>" +
			'<script src="/_next/a.js"></script>' +
			"</body></html>",
	);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("injectMetaCsp inserts a meta CSP covering the inline script", () => {
	const patched = injectMetaCsp(dir);
	assert.equal(patched, 1);
	const html = readFileSync(join(dir, "index.html"), "utf8");
	assert.match(
		html,
		/<meta http-equiv="Content-Security-Policy"[^>]*data-strict-csp>/,
	);
	// The inline script's hash is present; the external one is not hashed.
	assert.ok(html.includes(hashInlineScript("self.__next_f=[]")));
});

test("injectMetaCsp is idempotent (one meta tag after re-run)", () => {
	injectMetaCsp(dir);
	injectMetaCsp(dir);
	const html = readFileSync(join(dir, "index.html"), "utf8");
	const count = (html.match(/http-equiv="Content-Security-Policy"/g) || [])
		.length;
	assert.equal(count, 1);
});
