import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { checkHandlerWiring } from "../dist/index.js";

let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "scn-wiring-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Create an empty wiring file (e.g. "proxy.ts") at `base` relative to `dir`. */
function touch(base, rel = "") {
	const target = rel ? join(dir, rel) : dir;
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, base), "");
}

test("Next 15 with proxy-only warns and emits via console.warn", () => {
	touch("proxy.ts");
	const spy = mock.method(console, "warn", () => {});
	const warning = checkHandlerWiring(dir, 15);
	assert.match(warning ?? "", /proxy\.\*/);
	assert.match(warning, /middleware\.ts/);
	assert.equal(spy.mock.callCount(), 1);
	spy.mock.restore();
});

test("Next 15 with middleware-only does not warn", () => {
	touch("middleware.ts");
	const spy = mock.method(console, "warn", () => {});
	assert.equal(checkHandlerWiring(dir, 15), undefined);
	assert.equal(spy.mock.callCount(), 0);
	spy.mock.restore();
});

test("Next 16 with middleware-only warns", () => {
	touch("middleware.ts");
	const spy = mock.method(console, "warn", () => {});
	const warning = checkHandlerWiring(dir, 16);
	spy.mock.restore();
	assert.match(warning ?? "", /middleware\.\*/);
	assert.match(warning, /proxy\.ts/);
});

test("Next 16 with proxy-only does not warn", () => {
	touch("proxy.ts");
	assert.equal(checkHandlerWiring(dir, 16), undefined);
});

test("neither wiring file present does not warn (static-header-only setup)", () => {
	assert.equal(checkHandlerWiring(dir, 15), undefined);
	assert.equal(checkHandlerWiring(dir, 16), undefined);
});

test("undetectable Next version does nothing", () => {
	touch("proxy.ts");
	touch("middleware.ts");
	assert.equal(checkHandlerWiring(dir, undefined), undefined);
});

test("wiring file in src/ subdir is detected", () => {
	touch("proxy.mjs", "src");
	const warning = checkHandlerWiring(dir, 15);
	assert.match(warning ?? "", /proxy\.\*/);
});

test("both files present is ambiguous and does not warn", () => {
	touch("proxy.ts");
	touch("middleware.ts");
	assert.equal(checkHandlerWiring(dir, 15), undefined);
	assert.equal(checkHandlerWiring(dir, 16), undefined);
});

test("Next 17 (>=16) with middleware-only warns", () => {
	touch("middleware.tsx");
	const spy = mock.method(console, "warn", () => {});
	const warning = checkHandlerWiring(dir, 17);
	spy.mock.restore();
	assert.match(warning ?? "", /v17/);
});

test("Next 14 (<=15) with proxy-only warns", () => {
	touch("proxy.ts");
	const spy = mock.method(console, "warn", () => {});
	const warning = checkHandlerWiring(dir, 14);
	spy.mock.restore();
	assert.match(warning ?? "", /middleware\.ts/);
});
