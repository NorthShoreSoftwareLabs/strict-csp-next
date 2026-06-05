import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The recommended proxy matcher, kept in sync with examples/matrix/proxy.js and
// the README. The file-based metadata names are anchored to a full path segment
// (the name must be followed by end of path, `.`, or `/`) so a real page that
// merely shares a prefix (/icons, /opengraph-image-gallery) is NOT excluded from
// the proxy. Excluding it would silently ship that page with no CSP at all, which
// is worse than the `no-store` the exclusion prevents.
const MATCHER =
	"/((?!api|_next/static|_next/image|favicon.ico|(?:opengraph-image|twitter-image|apple-icon|icon)(?:$|\\.|/)|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|json|webmanifest)$).*)";

// Mirrors how Next compiles `config.matcher.source` and tests it against a path.
const re = new RegExp(`^${MATCHER}$`);
const proxied = (pathname) => re.test(pathname);

test("real pages that share a prefix with a metadata route stay proxied", () => {
	// The regression this guards: prefix-matching `icon` / `opengraph-image`
	// excluded these and dropped their CSP entirely.
	for (const p of [
		"/icons",
		"/iconography",
		"/opengraph-image-gallery",
		"/twitter-images",
		"/about",
		"/blog/post",
	]) {
		assert.equal(proxied(p), true, `${p} should be proxied (must get a CSP)`);
	}
});

test("file-based metadata routes and static assets are excluded", () => {
	for (const p of [
		"/icon",
		"/icon.png",
		"/icon/0", // multiple icons via generateImageMetadata
		"/apple-icon",
		"/apple-icon.png",
		"/opengraph-image",
		"/opengraph-image.png",
		"/opengraph-image/0",
		"/twitter-image",
		"/sitemap.xml", // covered by the .xml extension rule
		"/robots.txt", // covered by the .txt extension rule
		"/manifest.webmanifest",
		"/favicon.ico",
		"/og.png",
		"/data.json",
	]) {
		assert.equal(proxied(p), false, `${p} should be excluded from the proxy`);
	}
});

test("api and Next internals are excluded", () => {
	for (const p of ["/api/users", "/_next/static/chunk.js", "/_next/image"]) {
		assert.equal(proxied(p), false, `${p} should be excluded`);
	}
});

test("every shipped copy of the matcher matches the tested pattern (no drift)", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	// The matcher is copy-pasted into several files because Next needs it as a
	// static literal in `config.matcher` (it can't be imported). Each holds it as
	// a JS string literal where every backslash is written doubled, so compare
	// against that source form by escaping the evaluated value's backslashes.
	const sourceForm = MATCHER.replace(/\\/g, "\\\\");
	for (const rel of [
		"examples/matrix/proxy.js",
		"README.md",
		"docs/deployment.md",
	]) {
		const text = readFileSync(join(root, rel), "utf8");
		assert.ok(
			text.includes(sourceForm),
			`${rel} matcher drifted from the tested pattern`,
		);
	}
});
