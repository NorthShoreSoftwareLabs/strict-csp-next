import assert from "node:assert/strict";
import { test } from "node:test";
import {
	countExternalScripts,
	extractExternalIntegrity,
	extractInlineHashes,
	hashInlineScript,
} from "../dist/index.js";

test("hashInlineScript matches a known sha256 vector", () => {
	// sha256("") base64
	assert.equal(
		hashInlineScript(""),
		"'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
	);
});

test("hashInlineScript is deterministic and content-sensitive", () => {
	assert.equal(hashInlineScript("alert(1)"), hashInlineScript("alert(1)"));
	assert.notEqual(hashInlineScript("alert(1)"), hashInlineScript("alert(2)"));
});

test("extractInlineHashes hashes only executable bare inline scripts", () => {
	const html = [
		"<script>doThing()</script>", // hashed
		'<script src="/_next/x.js"></script>', // external, skipped
		'<script nonce="abc">already()</script>', // nonced, skipped
		'<script type="application/json">{"a":1}</script>', // inert, skipped
		'<script type="application/ld+json">{}</script>', // inert, skipped
		"<script></script>", // empty, skipped
	].join("\n");
	const hashes = extractInlineHashes(html);
	assert.equal(hashes.length, 1);
	assert.equal(hashes[0], hashInlineScript("doThing()"));
});

test("extractInlineHashes deduplicates identical scripts", () => {
	const html = "<script>x()</script><script>x()</script>";
	assert.equal(extractInlineHashes(html).length, 1);
});

test("tokenizer is not fooled by src= inside a quoted attribute value", () => {
	// The blind spot of a single regex: ` src=` lives inside data-foo's value, so
	// this is an EXECUTABLE bare inline script and must be hashed, not skipped.
	const html = '<script data-foo=" src=/evil.js ">evil()</script>';
	const hashes = extractInlineHashes(html);
	assert.equal(hashes.length, 1);
	assert.equal(hashes[0], hashInlineScript("evil()"));
});

test("tokenizer is not fooled by > inside a quoted attribute value", () => {
	// The `>` in data-x's value must not terminate the open tag early. The first
	// script is external (real src) and skipped; the second is hashed.
	const html =
		'<script src="/a.js" data-x="a>b"></script><script data-y="c>d">z()</script>';
	const hashes = extractInlineHashes(html);
	assert.equal(hashes.length, 1);
	assert.equal(hashes[0], hashInlineScript("z()"));
});

test("tokenizer skips a nonced script even with > in an attribute value", () => {
	const html = '<script nonce="n" data-x="a>b">covered()</script>';
	assert.equal(extractInlineHashes(html).length, 0);
});

test("a </scriptx string inside the body does not truncate the hash", () => {
	// The browser only closes on </script + [\s/>]; </scriptx is just body text.
	const body = 'a=1;b="</scriptx";c()';
	const html = `<script>${body}</script>`;
	const hashes = extractInlineHashes(html);
	assert.equal(hashes.length, 1);
	assert.equal(hashes[0], hashInlineScript(body));
});

test("a duplicate type attribute is read first-wins, like a browser", () => {
	// Browser uses the FIRST type (module = executable); we must hash it.
	const html = '<script type="module" type="application/json">run()</script>';
	const hashes = extractInlineHashes(html);
	assert.equal(hashes.length, 1);
	assert.equal(hashes[0], hashInlineScript("run()"));
});

test("a trailing solidus does not self-close a script element", () => {
	// <script/> is an open tag in HTML; the element runs until </script>.
	const html = "<script/>still()</script>";
	assert.equal(extractInlineHashes(html)[0], hashInlineScript("still()"));
});

test("extractExternalIntegrity returns integrity hashes from external scripts", () => {
	const html =
		'<script src="/a.js" integrity="sha256-abc123"></script>' +
		'<script src="/b.js" integrity="sha256-def456"></script>';
	const hashes = extractExternalIntegrity(html);
	assert.deepEqual(hashes, ["'sha256-abc123'", "'sha256-def456'"]);
});

test("extractExternalIntegrity skips non-executable types", () => {
	const html =
		'<script src="/a.js" integrity="sha256-abc"></script>' +
		'<script src="/d.json" integrity="sha256-xyz" type="application/json"></script>';
	const hashes = extractExternalIntegrity(html);
	assert.deepEqual(hashes, ["'sha256-abc'"]);
});

test("extractExternalIntegrity skips scripts without integrity", () => {
	const html = '<script src="/a.js"></script><script>inline()</script>';
	const hashes = extractExternalIntegrity(html);
	assert.deepEqual(hashes, []);
});

test("extractExternalIntegrity deduplicates identical hashes", () => {
	const html =
		'<script src="/a.js" integrity="sha256-dup"></script>' +
		'<script src="/a.js" integrity="sha256-dup"></script>';
	const hashes = extractExternalIntegrity(html);
	assert.deepEqual(hashes, ["'sha256-dup'"]);
});

test("countExternalScripts counts src-bearing script tags", () => {
	const html =
		'<script src="/a.js"></script>' +
		'<script src="/b.js"></script>' +
		"<script>inline()</script>";
	assert.equal(countExternalScripts(html), 2);
});

test("countExternalScripts skips non-executable types", () => {
	const html =
		'<script src="/a.js"></script>' +
		'<script src="/d.json" type="application/json"></script>';
	assert.equal(countExternalScripts(html), 1);
});

test("countExternalScripts returns 0 for inline-only pages", () => {
	assert.equal(countExternalScripts("<script>go()</script>"), 0);
});
