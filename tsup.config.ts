import { defineConfig } from "tsup";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/proxy.ts",
		"src/proxy-edge.ts",
		"src/bin.ts",
		"src/cache-handler.ts",
	],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	target: "node18",
	splitting: false,
	sourcemap: true,
});
