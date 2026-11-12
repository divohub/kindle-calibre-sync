// In-memory stub so bundled epubjs never references window.localStorage / sessionStorage.
const memoryStore = new Map<string, unknown>();

const localforageStub = {
	createInstance: () => ({
		getItem: async (key: string) => (memoryStore.has(key) ? memoryStore.get(key) : null),
		setItem: async (key: string, value: unknown) => {
			memoryStore.set(key, value);
			return value;
		},
		removeItem: async (key: string) => {
			memoryStore.delete(key);
		},
		clear: async () => {
			memoryStore.clear();
		},
		length: async () => memoryStore.size,
		keys: async () => Array.from(memoryStore.keys()),
		iterate: async () => undefined,
	}),
};

export default localforageStub;
