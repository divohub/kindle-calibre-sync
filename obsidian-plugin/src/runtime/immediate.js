// Modern Obsidian Desktop (Chromium) natively provides queueMicrotask.
// Replacing the legacy immediate package eliminates script.onreadystatechange fallbacks.
module.exports = function immediate(callback) {
	queueMicrotask(callback);
};
