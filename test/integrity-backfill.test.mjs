import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	backfillIntegrity,
	isCrossOrigin,
	makeAssetResolver,
} from "../dist/index.js";

let dir;
const CHUNK_A = "console.log('a')";
const CHUNK_B = "console.log('b')";

function sri(bytes, algo = "sha256") {
	return `${algo}-${createHash(algo).update(bytes).digest("base64")}`;
}

before(() => {
	dir = mkdtempSync(join(tmpdir(), "scn-bf-"));
	const chunks = join(dir, "_next", "static", "chunks");
	mkdirSync(chunks, { recursive: true });
	writeFileSync(join(chunks, "a.js"), CHUNK_A);
	writeFileSync(join(chunks, "b.js"), CHUNK_B);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("backfill injects integrity matching the on-disk hash", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html =
		'<script src="/_next/static/chunks/a.js" integrity="sha256-already"></script>' +
		'<script src="/_next/static/chunks/b.js" async=""></script>';
	const result = backfillIntegrity(html, { resolve });
	assert.equal(result.injected, 1); // only b.js was un-pinned
	const expected = sri(Buffer.from(CHUNK_B));
	assert.ok(
		result.html.includes(`integrity="${expected}"`),
		"b.js gets a disk-matching integrity",
	);
	assert.deepEqual(result.added, [`'${expected}'`]);
	// a.js keeps its existing integrity untouched.
	assert.ok(result.html.includes('integrity="sha256-already"'));
});

test("backfill is idempotent: a second pass injects nothing", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="/_next/static/chunks/a.js" async=""></script>';
	const once = backfillIntegrity(html, { resolve });
	assert.equal(once.injected, 1);
	const twice = backfillIntegrity(once.html, { resolve });
	assert.equal(twice.injected, 0);
	assert.equal(twice.html, once.html);
});

test("backfill skips a src it cannot resolve on disk", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="/_next/static/chunks/missing.js"></script>';
	const result = backfillIntegrity(html, { resolve });
	assert.equal(result.injected, 0);
	assert.equal(result.html, html);
});

test("backfill skips third-party absolute URLs (not hashable from disk)", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="https://cdn.other.com/x.js"></script>';
	const result = backfillIntegrity(html, { resolve });
	assert.equal(result.injected, 0);
});

test("crossOrigin auto: same-origin gets integrity only, no crossorigin", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="/_next/static/chunks/a.js"></script>';
	const result = backfillIntegrity(html, { resolve }); // no assetPrefix
	assert.match(result.html, /integrity="/);
	assert.doesNotMatch(result.html, /crossorigin/);
	assert.equal(result.crossOriginDetected, false);
});

test("crossOrigin auto: cross-origin assetPrefix adds crossorigin=anonymous", () => {
	const resolve = makeAssetResolver(dir, "export");
	// The tag src still resolves locally (assetPrefix is stripped first), but the
	// prefix being absolute marks it cross-origin.
	const html =
		'<script src="https://cdn.example.com/_next/static/chunks/a.js"></script>';
	const result = backfillIntegrity(html, {
		resolve,
		assetPrefix: "https://cdn.example.com",
	});
	assert.match(result.html, /integrity="/);
	assert.match(result.html, /crossorigin="anonymous"/);
	assert.equal(result.crossOriginDetected, true);
});

test("crossOrigin override 'use-credentials' is forced even same-origin", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="/_next/static/chunks/a.js"></script>';
	const result = backfillIntegrity(html, {
		resolve,
		crossOrigin: "use-credentials",
	});
	assert.match(result.html, /crossorigin="use-credentials"/);
});

test("crossOrigin false never adds crossorigin even cross-origin", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html =
		'<script src="https://cdn.example.com/_next/static/chunks/a.js"></script>';
	const result = backfillIntegrity(html, {
		resolve,
		assetPrefix: "https://cdn.example.com",
		crossOrigin: false,
	});
	assert.match(result.html, /integrity="/);
	assert.doesNotMatch(result.html, /crossorigin/);
	assert.equal(result.crossOriginDetected, false);
});

test("isCrossOrigin handles relative, protocol-relative, and absolute prefixes", () => {
	assert.equal(isCrossOrigin(undefined), false);
	assert.equal(isCrossOrigin(""), false);
	assert.equal(isCrossOrigin("/assets"), false); // relative same-origin
	assert.equal(isCrossOrigin("//cdn.example.com"), true); // protocol-relative
	assert.equal(isCrossOrigin("https://cdn.example.com"), true);
	assert.equal(isCrossOrigin("http://cdn.example.com"), true);
});

test("backfill respects basePath when resolving src", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="/app/_next/static/chunks/a.js"></script>';
	const result = backfillIntegrity(html, { resolve, basePath: "/app" });
	assert.equal(result.injected, 1);
	assert.ok(result.html.includes(`integrity="${sri(Buffer.from(CHUNK_A))}"`));
});

test("backfill handles a /> solidus tag without corrupting it", () => {
	const resolve = makeAssetResolver(dir, "export");
	const html = '<script src="/_next/static/chunks/a.js" async/>';
	const result = backfillIntegrity(html, { resolve });
	assert.equal(result.injected, 1);
	// integrity inserted before the `/`, solidus preserved.
	assert.match(result.html, /integrity="[^"]+"\s*\/>/);
});
