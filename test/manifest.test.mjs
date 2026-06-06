import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	clearManifestCache,
	generateManifest,
	loadManifest,
	runPostbuild,
	staticCspHeaders,
} from "../dist/index.js";

let dir;
const inline = "<script>self.__next_f=[]</script>";
const bundle = '<script src="/_next/x.js" integrity="sha256-abc123"></script>';

before(() => {
	dir = mkdtempSync(join(tmpdir(), "scn-"));
	const app = join(dir, ".next", "server", "app");
	// A range of route shapes, including the ones the HIGH bugs missed.
	const pages = {
		"index.html": inline + bundle, // /
		"blog/index.html": inline + bundle, // /blog (nested index)
		"(marketing)/about.html": inline, // /about (route group stripped)
		"docs/getting-started.html": inline, // /docs/getting-started
		"_not-found.html": inline, // skipped
	};
	for (const [rel, html] of Object.entries(pages)) {
		const file = join(app, rel);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, html);
	}
	writeFileSync(
		join(dir, ".next", "prerender-manifest.json"),
		JSON.stringify({
			routes: {
				"/blog": { renderingMode: "PARTIALLY_STATIC", experimentalPPR: true },
				"/docs/getting-started": { initialRevalidateSeconds: 60 },
			},
		}),
	);
});

after(() => {
	clearManifestCache();
	rmSync(dir, { recursive: true, force: true });
});

test("generateManifest derives routes, strips groups, handles nested index", () => {
	const m = generateManifest(dir);
	const routes = m.routes.map((r) => r.route);
	assert.deepEqual(routes, ["/", "/about", "/blog", "/docs/getting-started"]);
	assert.ok(!routes.includes("/_not-found"));
	assert.ok(!routes.some((r) => r.includes("(marketing)")));
});

test("classifyRoute maps ppr / isr / static from prerender-manifest", () => {
	const m = generateManifest(dir);
	const mode = (route) => m.routes.find((r) => r.route === route)?.mode;
	assert.equal(mode("/blog"), "ppr");
	assert.equal(mode("/docs/getting-started"), "isr");
	assert.equal(mode("/"), "static");
	assert.equal(mode("/about"), "static");
});

test("postbuild self-check covers nested-index routes and passes on clean output", () => {
	const result = runPostbuild({ projectDir: dir, failOnUncovered: true });
	assert.equal(result.routeCount, 4);
	assert.equal(result.uncovered.length, 0);
});

test("loadManifest caches per projectDir and clears", () => {
	clearManifestCache();
	const a = loadManifest(dir);
	assert.ok(a);
	assert.equal(loadManifest(dir), a); // cached identity
	clearManifestCache();
	assert.notEqual(loadManifest(dir), a); // re-read after clear
});

test("loadManifest does not cache a miss (retries until written)", () => {
	const fresh = mkdtempSync(join(tmpdir(), "scn-miss-"));
	try {
		clearManifestCache();
		assert.equal(loadManifest(fresh), null); // no manifest yet
		// Write one AFTER the miss; a cached null would pin this to null forever.
		mkdirSync(join(fresh, ".next"), { recursive: true });
		writeFileSync(
			join(fresh, ".next", "strict-csp-manifest.json"),
			JSON.stringify({ version: 1, algorithm: "sha256", routes: [] }),
		);
		const m = loadManifest(fresh);
		assert.ok(m, "a transient miss must not be cached");
		assert.equal(m.version, 1);
	} finally {
		clearManifestCache();
		rmSync(fresh, { recursive: true, force: true });
	}
});

test("routes stay bare even under basePath (proxy strips it at lookup)", () => {
	// Next strips basePath from request.nextUrl.pathname before the proxy sees it,
	// and auto-prefixes headers() sources, so the manifest must hold bare routes.
	const bp = mkdtempSync(join(tmpdir(), "scn-bp-"));
	try {
		const app = join(bp, ".next", "server", "app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "index.html"), inline);
		mkdirSync(join(app, "blog"), { recursive: true });
		writeFileSync(join(app, "blog", "index.html"), inline);
		writeFileSync(
			join(bp, ".next", "routes-manifest.json"),
			JSON.stringify({ basePath: "/app" }),
		);
		const routes = generateManifest(bp).routes.map((r) => r.route);
		assert.deepEqual(routes, ["/", "/blog"]);
	} finally {
		rmSync(bp, { recursive: true, force: true });
	}
});

function appDirWith(html) {
	const d = mkdtempSync(join(tmpdir(), "scn-sc-"));
	const app = join(d, ".next", "server", "app");
	mkdirSync(app, { recursive: true });
	writeFileSync(join(app, "index.html"), html);
	return d;
}

test("self-check throws on an open/close <script> imbalance", () => {
	// Two opens, one close: the structural signal must catch the truncation.
	const d = appDirWith("<head></head><script>x()</script><script>y()");
	try {
		assert.throws(
			() => runPostbuild({ projectDir: d, failOnUncovered: true }),
			/close tag|mismatch/i,
		);
		const { uncovered } = runPostbuild({
			projectDir: d,
			failOnUncovered: false,
		});
		assert.equal(uncovered.length, 1);
		assert.match(uncovered[0].reason, /open tag\(s\) but 1 <\/script> close/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("self-check does NOT flag a harmless empty <script></script>", () => {
	const d = appDirWith("<head></head><script></script><script>go()</script>");
	try {
		const { uncovered } = runPostbuild({
			projectDir: d,
			failOnUncovered: true,
		});
		assert.equal(uncovered.length, 0);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("self-check does NOT flag an empty-bodied external script", () => {
	const d = appDirWith(
		'<head></head><script src="/a.js" integrity="sha256-def456"></script><script>go()</script>',
	);
	try {
		const { uncovered } = runPostbuild({
			projectDir: d,
			failOnUncovered: true,
		});
		assert.equal(uncovered.length, 0);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("self-check flags partial SRI coverage (7 external tags, 5 with integrity)", () => {
	// Mirror the export example: 7 external <script src> tags, only 5 carry an
	// integrity attribute. Two un-pinned chunks must be flagged as a per-tag
	// shortfall (NOT the old all-zero threshold, which would pass).
	const tags = [
		'<script src="/_next/a.js" integrity="sha256-a"></script>',
		'<script src="/_next/b.js" integrity="sha256-b"></script>',
		'<script src="/_next/c.js" integrity="sha256-c"></script>',
		'<script src="/_next/d.js" integrity="sha256-d"></script>',
		'<script src="/_next/e.js" integrity="sha256-e"></script>',
		'<script src="/_next/f.js" async=""></script>', // un-pinned
		'<script src="/_next/g.js" async=""></script>', // un-pinned
	].join("");
	const d = appDirWith(`<head></head>${inline}${tags}`);
	try {
		assert.throws(
			() => runPostbuild({ projectDir: d, failOnUncovered: true }),
			/2 of 7 external script\(s\) lack an integrity attribute/,
		);
		const { uncovered } = runPostbuild({
			projectDir: d,
			failOnUncovered: false,
		});
		assert.equal(uncovered.length, 1);
		assert.equal(uncovered[0].externalScripts, 7);
		assert.equal(uncovered[0].integrityHashes, 5);
		assert.match(uncovered[0].reason, /coverage is\s+incomplete/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("partial coverage: the route's policy keeps 'self' and no strict-dynamic", () => {
	const tags =
		'<script src="/_next/a.js" integrity="sha256-a"></script>' +
		'<script src="/_next/b.js"></script>'; // un-pinned
	const d = appDirWith(`<head></head>${inline}${tags}`);
	try {
		const m = generateManifest(d);
		const route = m.routes.find((r) => r.route === "/");
		assert.equal(route.uncoveredExternal, 1);
		// The emitted static header must keep 'self' and omit strict-dynamic.
		const entries = staticCspHeaders(m);
		const value = entries[0].headers[0].value;
		const scriptSrc = value.split("; ").find((s) => s.startsWith("script-src"));
		assert.match(scriptSrc, /'self'/);
		assert.doesNotMatch(scriptSrc, /'strict-dynamic'/);
		assert.match(scriptSrc, /'sha256-a'/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("full coverage: the route's policy drops 'self' and forces strict-dynamic", () => {
	const tags =
		'<script src="/_next/a.js" integrity="sha256-a"></script>' +
		'<script src="/_next/b.js" integrity="sha256-b"></script>';
	const d = appDirWith(`<head></head>${inline}${tags}`);
	try {
		const m = generateManifest(d);
		const route = m.routes.find((r) => r.route === "/");
		assert.ok(!route.uncoveredExternal); // 0, omitted from the manifest
		const entries = staticCspHeaders(m);
		const value = entries[0].headers[0].value;
		const scriptSrc = value.split("; ").find((s) => s.startsWith("script-src"));
		assert.doesNotMatch(scriptSrc, /'self'/);
		assert.match(scriptSrc, /'strict-dynamic'/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});

test("classification tolerates trailing-slash prerender-manifest keys", () => {
	// Under trailingSlash:true the manifest key can be "/blog/"; the route derived
	// from the file tree is "/blog". A PPR route must not be misread as static.
	const ts = mkdtempSync(join(tmpdir(), "scn-ts-"));
	try {
		const app = join(ts, ".next", "server", "app", "blog");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "index.html"), inline);
		writeFileSync(
			join(ts, ".next", "prerender-manifest.json"),
			JSON.stringify({ routes: { "/blog/": { experimentalPPR: true } } }),
		);
		const m = generateManifest(ts);
		assert.equal(m.routes.find((r) => r.route === "/blog")?.mode, "ppr");
	} finally {
		rmSync(ts, { recursive: true, force: true });
	}
});

test("a custom distDir is honored end-to-end (generate, write, load)", () => {
	const d = mkdtempSync(join(tmpdir(), "scn-dist-"));
	try {
		const app = join(d, "build", "server", "app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "index.html"), `<head></head>${inline}`);
		// Generate + write into the custom dir; nothing under .next.
		const m = generateManifest(d, "sha256", "build");
		assert.equal(m.routes.length, 1);
		const written = runPostbuild({
			projectDir: d,
			distDir: "build",
			failOnUncovered: true,
		});
		assert.match(
			written.manifestPath,
			/[/\\]build[/\\]strict-csp-manifest\.json$/,
		);
		clearManifestCache();
		// Default (.next) can't find it; the custom dir can.
		assert.equal(loadManifest(d), null);
		assert.ok(loadManifest(d, "build"));
	} finally {
		clearManifestCache();
		rmSync(d, { recursive: true, force: true });
	}
});

test("the proxy auto-detects distDir from __NEXT_DIST_DIR", () => {
	const d = mkdtempSync(join(tmpdir(), "scn-env-"));
	const prev = process.env.__NEXT_DIST_DIR;
	try {
		const dist = join(d, "build");
		mkdirSync(dist, { recursive: true });
		writeFileSync(
			join(dist, "strict-csp-manifest.json"),
			JSON.stringify({ version: 1, algorithm: "sha256", routes: [] }),
		);
		clearManifestCache();
		process.env.__NEXT_DIST_DIR = dist; // absolute, as Next sets it
		assert.ok(loadManifest(d), "should resolve via __NEXT_DIST_DIR");
	} finally {
		if (prev === undefined) delete process.env.__NEXT_DIST_DIR;
		else process.env.__NEXT_DIST_DIR = prev;
		clearManifestCache();
		rmSync(d, { recursive: true, force: true });
	}
});

test("route-group regex keeps intercepting markers, strips real groups", () => {
	const ig = mkdtempSync(join(tmpdir(), "scn-ig-"));
	try {
		const app = join(ig, ".next", "server", "app");
		mkdirSync(join(app, "(shop)"), { recursive: true });
		writeFileSync(join(app, "(shop)", "cart.html"), inline); // /cart
		const routes = generateManifest(ig).routes.map((r) => r.route);
		assert.deepEqual(routes, ["/cart"]);
	} finally {
		rmSync(ig, { recursive: true, force: true });
	}
});
