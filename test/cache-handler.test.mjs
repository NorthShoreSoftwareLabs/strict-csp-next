import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyCspHeader,
	cspHeaderForHtml,
	withStrictCspCache,
} from "../dist/cache-handler.js";
import { buildPolicy, extractInlineHashes } from "../dist/index.js";

const PAGE =
	"<html><body><script>self.__next_f.push([1,'a'])</script></body></html>";

test("cspHeaderForHtml hashes the document's executable inline scripts", () => {
	const { policy, headerName, driftReason } = cspHeaderForHtml(PAGE);
	assert.equal(headerName, "content-security-policy");
	assert.equal(driftReason, null);
	const expected = buildPolicy(extractInlineHashes(PAGE), null);
	assert.equal(policy, expected);
	assert.ok(policy.includes("'sha256-"));
});

test("cspHeaderForHtml tracks the bytes: changed inline data changes the policy", () => {
	// The whole point of the cache handler: ISR revalidation changes the inline
	// data, and the hash follows it. A frozen build-time header could not.
	const before = cspHeaderForHtml(PAGE).policy;
	const after = cspHeaderForHtml(
		PAGE.replace("[1,'a']", "[1,'totally-different-data']"),
	).policy;
	assert.notEqual(before, after);
});

test("cspHeaderForHtml honors report-only and algorithm options", () => {
	const { policy, headerName } = cspHeaderForHtml(PAGE, {
		mode: "report-only",
		algorithm: "sha512",
	});
	assert.equal(headerName, "content-security-policy-report-only");
	assert.ok(policy.includes("'sha512-"));
});

test("cspHeaderForHtml fails safe on script open/close imbalance (drift)", () => {
	// One <script> open, no </script> close: the byte-exact hasher cannot trust
	// this shape, so the policy must be null with a reason.
	const broken = "<html><script>oops()";
	const { policy, driftReason } = cspHeaderForHtml(broken);
	assert.equal(policy, null);
	assert.match(driftReason, /open tag|close tag/);
});

test("applyCspHeader strips any existing CSP (any case) and sets the canonical one", () => {
	const { headers, driftReason } = applyCspHeader(
		{
			"Content-Security-Policy": "default-src 'none'",
			"x-frame-options": "DENY",
		},
		PAGE,
	);
	assert.equal(driftReason, null);
	// The stale CSP is gone, the unrelated header is preserved.
	assert.equal(headers["Content-Security-Policy"], undefined);
	assert.equal(headers["x-frame-options"], "DENY");
	assert.equal(
		headers["content-security-policy"],
		buildPolicy(extractInlineHashes(PAGE), null),
	);
});

test("applyCspHeader omits the CSP header on drift, leaving others intact", () => {
	const { headers, driftReason } = applyCspHeader(
		{ "x-frame-options": "DENY", "content-security-policy": "stale" },
		"<script>unterminated()",
	);
	assert.ok(driftReason);
	assert.equal(headers["content-security-policy"], undefined);
	assert.equal(headers["x-frame-options"], "DENY");
});

// A minimal stand-in for a Next.js cache handler: records what `set` persists.
class FakeBaseCache {
	constructor() {
		this.persisted = [];
	}
	async set(key, data, ctx) {
		this.persisted.push({ key, data, ctx });
	}
	async get(_key) {
		return null;
	}
}

test("withStrictCspCache stamps a matching CSP onto cached APP_PAGE entries", async () => {
	const Wrapped = withStrictCspCache(FakeBaseCache);
	const handler = new Wrapped();
	await handler.set(
		"/blog",
		{ kind: "APP_PAGE", html: PAGE, headers: { "x-frame-options": "DENY" } },
		{ revalidate: 60 },
	);
	const [entry] = handler.persisted;
	assert.equal(entry.key, "/blog");
	assert.equal(entry.ctx.revalidate, 60); // ctx forwarded untouched
	assert.equal(entry.data.headers["x-frame-options"], "DENY"); // preserved
	assert.equal(
		entry.data.headers["content-security-policy"],
		buildPolicy(extractInlineHashes(PAGE), null),
	);
	// The base still receives the html unchanged, so the body it caches matches
	// the bytes the header was hashed from.
	assert.equal(entry.data.html, PAGE);
});

test("withStrictCspCache mutates the SAME value object Next sends (covers cache-fill MISS)", async () => {
	// Load-bearing for the cache-fill MISS: on a MISS, Next streams the response
	// from the very value object it passes to set() (its `headers` is shared by
	// reference with the entry being cached, and set() is awaited before the
	// response is sent). So the header MUST be written onto that object in place;
	// a copy would be cached but never reach the fill render's response. This test
	// fails if a future refactor goes back to `{ ...data, headers }`.
	const Wrapped = withStrictCspCache(FakeBaseCache);
	const handler = new Wrapped();
	const value = {
		kind: "APP_PAGE",
		html: PAGE,
		headers: { "x-nextjs-stale-time": "300" },
	};
	await handler.set("/p", value, {});
	// The original object handed in is mutated, not replaced.
	assert.equal(handler.persisted[0].data, value);
	assert.equal(
		value.headers["content-security-policy"],
		buildPolicy(extractInlineHashes(PAGE), null),
	);
	assert.equal(value.headers["x-nextjs-stale-time"], "300"); // siblings preserved
});

test("withStrictCspCache passes non-APP_PAGE entries through untouched", async () => {
	const Wrapped = withStrictCspCache(FakeBaseCache);
	const handler = new Wrapped();
	const fetchValue = { kind: "FETCH", data: { body: "x" } };
	await handler.set("key", fetchValue, {});
	assert.deepEqual(handler.persisted[0].data, fetchValue);
});

test("withStrictCspCache swallows a base set() failure (no 500 on read-only FS)", async () => {
	// A serverless host with a read-only filesystem makes the base handler's write
	// throw. The wrapper must not let that crash the response: the header is
	// already written, so it resolves (page renders uncached) rather than throwing.
	class ThrowingCache {
		async set() {
			throw new Error("EROFS: read-only file system");
		}
		async get() {
			return null;
		}
	}
	const Wrapped = withStrictCspCache(ThrowingCache);
	const handler = new Wrapped();
	const value = { kind: "APP_PAGE", html: PAGE, headers: {} };
	await handler.set("/x", value, {}); // must not throw
	assert.equal(
		value.headers["content-security-policy"],
		buildPolicy(extractInlineHashes(PAGE), null),
	);
});

test("withStrictCspCache routeFilter scopes which routes get a policy", async () => {
	const Wrapped = withStrictCspCache(FakeBaseCache, {
		routeFilter: (key) => key.startsWith("/projects/"),
	});
	const handler = new Wrapped();
	// In scope: header stamped.
	const inScope = { kind: "APP_PAGE", html: PAGE, headers: {} };
	await handler.set("/projects/strict-csp-next", inScope, {});
	assert.ok(inScope.headers["content-security-policy"]);
	// Out of scope: left untouched, so the app's existing CSP is preserved.
	const outScope = { kind: "APP_PAGE", html: PAGE, headers: { "x-keep": "1" } };
	await handler.set("/about", outScope, {});
	assert.equal(outScope.headers["content-security-policy"], undefined);
	assert.equal(outScope.headers["x-keep"], "1");
});

test("withStrictCspCache forwards options to the policy", async () => {
	const Wrapped = withStrictCspCache(FakeBaseCache, { strictDynamic: true });
	const handler = new Wrapped();
	await handler.set("/x", { kind: "APP_PAGE", html: PAGE }, {});
	assert.ok(
		handler.persisted[0].data.headers["content-security-policy"].includes(
			"'strict-dynamic'",
		),
	);
});
