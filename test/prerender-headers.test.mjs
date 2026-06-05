import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	clearManifestCache,
	extractInlineHashes,
	injectPrerenderMetaCsp,
} from "../dist/index.js";

let dir;
const inline = "<script>self.__next_f.push([1,'x'])</script>";

function meta(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

before(() => {
	dir = mkdtempSync(join(tmpdir(), "pre-"));
	const app = join(dir, ".next", "server", "app");
	// route -> [html file, meta file contents]
	const routes = {
		index: { stale: false }, // / static
		"isr/index": { stale: true }, // /isr isr, has a stale CSP to replace
		"blog/index": { stale: false }, // /blog ppr (must be skipped)
	};
	for (const [rel, opts] of Object.entries(routes)) {
		const htmlFile = join(app, `${rel}.html`);
		mkdirSync(join(htmlFile, ".."), { recursive: true });
		writeFileSync(htmlFile, inline);
		const headers = { "x-nextjs-stale-time": "300" };
		if (opts.stale) headers["content-security-policy"] = "default-src 'none'";
		writeFileSync(
			join(app, `${rel}.meta`),
			JSON.stringify({ headers, segmentPaths: ["/_tree"] }),
		);
	}
	writeFileSync(
		join(dir, ".next", "prerender-manifest.json"),
		JSON.stringify({
			routes: {
				"/isr": { initialRevalidateSeconds: 60 },
				"/blog": { experimentalPPR: true },
			},
		}),
	);
});

after(() => {
	clearManifestCache();
	rmSync(dir, { recursive: true, force: true });
});

test("injectPrerenderMetaCsp patches static and isr meta, skips ppr", () => {
	const { patched } = injectPrerenderMetaCsp(dir);
	assert.deepEqual([...patched].sort(), ["/", "/isr"]);

	const app = join(dir, ".next", "server", "app");
	const expected = `script-src 'self' ${extractInlineHashes(inline).join(" ")}`;

	const staticMeta = meta(join(app, "index.meta"));
	assert.ok(staticMeta.headers["content-security-policy"].includes(expected));
	// Untouched sibling header and other meta fields are preserved.
	assert.equal(staticMeta.headers["x-nextjs-stale-time"], "300");
	assert.deepEqual(staticMeta.segmentPaths, ["/_tree"]);

	// The stale CSP on the isr route is replaced, not appended: the old
	// `default-src 'none'` is gone (buildPolicy sets `default-src 'self'`), and
	// there is exactly one CSP value (a string, not an array of two).
	const isrMeta = meta(join(app, "isr/index.meta"));
	assert.ok(isrMeta.headers["content-security-policy"].includes(expected));
	assert.ok(
		isrMeta.headers["content-security-policy"].includes("default-src 'self'"),
	);
	assert.equal(typeof isrMeta.headers["content-security-policy"], "string");

	// PPR route is left alone: it carries a per-request nonce from the proxy, and
	// a fixed meta policy would conflict.
	const pprMeta = meta(join(app, "blog/index.meta"));
	assert.equal(pprMeta.headers["content-security-policy"], undefined);
});

test("injectPrerenderMetaCsp routeFilter scopes which routes are patched", () => {
	clearManifestCache();
	const { patched } = injectPrerenderMetaCsp(dir, {
		routeFilter: (route) => route.startsWith("/isr"),
	});
	assert.deepEqual(patched, ["/isr"]);
});

test("injectPrerenderMetaCsp honors report-only", () => {
	clearManifestCache();
	injectPrerenderMetaCsp(dir, { mode: "report-only" });
	const app = join(dir, ".next", "server", "app");
	const isrMeta = meta(join(app, "isr/index.meta"));
	assert.ok(isrMeta.headers["content-security-policy-report-only"]);
});
