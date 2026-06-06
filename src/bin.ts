#!/usr/bin/env node
import { runPostbuild } from "./postbuild.js";

function main(argv: string[]): void {
	const args = argv.slice(2);
	const command = args[0] ?? "postbuild";

	if (command === "-h" || command === "--help" || command === "help") {
		printHelp();
		return;
	}

	if (command !== "postbuild") {
		console.error(`strict-csp-next: unknown command "${command}"\n`);
		printHelp();
		process.exitCode = 1;
		return;
	}

	const failOnUncovered = !args.includes("--no-strict");
	const emitHeaders = args.includes("--emit-headers");
	const exportArg = args.find(
		(a) => a === "--export" || a.startsWith("--export="),
	);
	const exportDir = exportArg
		? exportArg.includes("=")
			? exportArg.slice("--export=".length)
			: "out"
		: undefined;
	const distArg = args.find((a) => a.startsWith("--dist-dir="));
	const distDir = distArg ? distArg.slice("--dist-dir=".length) : undefined;
	const backfillIntegrity = args.includes("--backfill");
	const coArg = args.find((a) => a.startsWith("--cross-origin="));
	const coRaw = coArg ? coArg.slice("--cross-origin=".length) : undefined;
	const crossOrigin =
		coRaw === "false"
			? false
			: coRaw === "anonymous" || coRaw === "use-credentials" || coRaw === "auto"
				? coRaw
				: undefined;
	const dirArg = args.find((a) => !a.startsWith("-") && a !== "postbuild");

	try {
		const result = runPostbuild({
			projectDir: dirArg,
			distDir,
			failOnUncovered,
			emitHeaders,
			exportDir,
			backfillIntegrity,
			crossOrigin,
		});
		console.log(
			`strict-csp-next: wrote ${result.manifestPath}\n` +
				`  ${result.routeCount} prerendered route(s), ${result.totalHashes} inline hash(es)`,
		);
		if (result.headersPath) {
			console.log(`  wrote static headers: ${result.headersPath}`);
		}
		if (result.standalonePath) {
			console.log(
				`  copied manifest into standalone bundle: ${result.standalonePath}`,
			);
		}
		if (result.exportFilesPatched !== undefined) {
			console.log(
				`  injected meta CSP into ${result.exportFilesPatched} exported HTML file(s)`,
			);
		}
		if (result.integrityBackfilled !== undefined) {
			console.log(
				`  backfilled integrity into ${result.integrityBackfilled} server prerender <script> tag(s)`,
			);
		}
		if (result.uncovered.length > 0) {
			console.warn(
				`  warning: ${result.uncovered.length} route(s) had uncovered inline scripts`,
			);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

function printHelp(): void {
	console.log(
		`strict-csp-next — generate the CSP hash manifest after a Next.js build\n\n` +
			`Usage:\n` +
			`  strict-csp-next postbuild [projectDir] [--no-strict]\n\n` +
			`Run it after \`next build\`:\n` +
			`  "build": "next build && strict-csp-next postbuild"\n\n` +
			`Options:\n` +
			`  --emit-headers     write .next/strict-csp-headers.json for static routes\n` +
			`  --export[=<dir>]   inject a <meta> CSP into exported HTML (output: 'export', default dir "out")\n` +
			`  --backfill         inject integrity into external <script src> tags Next left un-pinned\n` +
			`  --cross-origin=<v> auto|anonymous|use-credentials|false for backfilled tags (default auto)\n` +
			`  --dist-dir=<dir>   Next build dir if you set a custom distDir (default ".next")\n` +
			`  --no-strict        do not fail the build on uncovered inline scripts\n`,
	);
}

main(process.argv);
