import { epubWithoutScripts } from "./build-security.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { readFile, copyFile, access } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv.includes("production");

await build({
	entryPoints: [resolve(__dirname, "src/main.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2021",
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((name) => `node:${name}`),
	],
	loader: {
		".wasm": "binary",
	},
	plugins: [epubWithoutScripts],
	alias: {
		"jszip/dist/jszip": resolve(__dirname, "node_modules/jszip/lib/index.js"),
		jszip: resolve(__dirname, "node_modules/jszip/lib/index.js"),
		"readable-stream": resolve(__dirname, "node_modules/jszip/lib/readable-stream-browser.js"),
		localforage: resolve(__dirname, "src/runtime/localforage.ts"),
		immediate: resolve(__dirname, "src/runtime/immediate.js"),
		setimmediate: resolve(__dirname, "src/runtime/setimmediate.ts"),
	},
	outfile: resolve(__dirname, "main.js"),
	treeShaking: true,
	sourcemap: prod ? false : "inline",
	logLevel: "info",
});

const bundle = await readFile(resolve(__dirname, "main.js"), "utf8");
if (/createElement\(["']script["']\)|new Function\(|\beval\(|\blocalStorage\b|\bsessionStorage\b/.test(bundle)) {
	throw new Error("Security check failed: unsafe runtime construct detected in main.js");
}

// Optional local vault deployment when running in developer environment
const localVaultPluginDir = "/home/divo/Documents/obsidiane-private/.obsidian/plugins/kindle-calibre-sync";
try {
	await access(localVaultPluginDir);
	for (const f of ["main.js", "manifest.json", "styles.css"]) {
		await copyFile(resolve(__dirname, f), resolve(localVaultPluginDir, f));
	}
} catch {
	// Skip local vault copy in CI or external environments
}
