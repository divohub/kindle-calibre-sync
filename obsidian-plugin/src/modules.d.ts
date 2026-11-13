declare module "*.wasm" {
	const wasmBinary: Uint8Array;
	export default wasmBinary;
}

declare module "sql.js-fts5" {
	import sqlJs = require("sql.js");
	export = sqlJs;
}
