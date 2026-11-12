// Modern Obsidian Desktop shim for setimmediate (used by JSZip) without Function() or script elements.
const scope = globalThis as unknown as {
	setImmediate?: unknown;
	clearImmediate?: unknown;
};

if (!scope.setImmediate) {
	scope.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
		if (typeof callback !== "function") {
			throw new TypeError("A callback function is required.");
		}
		return window.setTimeout(() => callback(...args), 0);
	};
}

if (!scope.clearImmediate) {
	scope.clearImmediate = (handle: number) => window.clearTimeout(handle);
}

export {};
