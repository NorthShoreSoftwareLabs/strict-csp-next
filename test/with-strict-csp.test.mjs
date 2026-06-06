import assert from "node:assert/strict";
import { test } from "node:test";
import { withStrictCsp } from "../dist/index.js";

test("withStrictCsp enables experimental.sri with the default algorithm", () => {
	const cfg = withStrictCsp({});
	assert.deepEqual(cfg.experimental.sri, { algorithm: "sha256" });
});

test("withStrictCsp honors an explicit algorithm option", () => {
	const cfg = withStrictCsp({}, { algorithm: "sha384" });
	assert.deepEqual(cfg.experimental.sri, { algorithm: "sha384" });
});

test("withStrictCsp respects a user-set experimental.sri", () => {
	const cfg = withStrictCsp({ experimental: { sri: { algorithm: "sha512" } } });
	assert.deepEqual(cfg.experimental.sri, { algorithm: "sha512" });
});

test("withStrictCsp preserves other config and experimental keys", () => {
	const cfg = withStrictCsp({
		reactStrictMode: true,
		experimental: { cacheComponents: true },
	});
	assert.equal(cfg.reactStrictMode, true);
	assert.equal(cfg.experimental.cacheComponents, true);
	assert.deepEqual(cfg.experimental.sri, { algorithm: "sha256" });
});

test("withStrictCsp warns when option algorithm conflicts with explicit sri (#8c)", () => {
	const warnings = [];
	const orig = console.warn;
	console.warn = (msg) => warnings.push(msg);
	try {
		const cfg = withStrictCsp(
			{ experimental: { sri: { algorithm: "sha512" } } },
			{ algorithm: "sha256" },
		);
		// The explicit sri wins; the option is ignored.
		assert.deepEqual(cfg.experimental.sri, { algorithm: "sha512" });
	} finally {
		console.warn = orig;
	}
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ignored because experimental\.sri\.algorithm/);
	assert.match(warnings[0], /sha512/);
});

test("withStrictCsp does NOT warn when algorithms agree", () => {
	const warnings = [];
	const orig = console.warn;
	console.warn = (msg) => warnings.push(msg);
	try {
		withStrictCsp(
			{ experimental: { sri: { algorithm: "sha256" } } },
			{ algorithm: "sha256" },
		);
	} finally {
		console.warn = orig;
	}
	assert.equal(warnings.length, 0);
});
