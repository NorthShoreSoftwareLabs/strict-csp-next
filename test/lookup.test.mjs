import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupRoute } from "../dist/index.js";

const manifest = {
	version: 1,
	algorithm: "sha256",
	routes: [
		{ route: "/", mode: "static", shellHashes: ["'sha256-a'"] },
		{ route: "/blog", mode: "ppr", shellHashes: ["'sha256-b'"] },
	],
};

test("lookupRoute matches exact paths", () => {
	assert.equal(lookupRoute(manifest, "/")?.mode, "static");
	assert.equal(lookupRoute(manifest, "/blog")?.mode, "ppr");
});

test("lookupRoute normalizes a trailing slash", () => {
	assert.equal(lookupRoute(manifest, "/blog/")?.route, "/blog");
});

test("lookupRoute returns undefined for misses and null manifest", () => {
	assert.equal(lookupRoute(manifest, "/missing"), undefined);
	assert.equal(lookupRoute(null, "/"), undefined);
});
