// --- localStorage access that never throws ---

// localStorage can throw (blocked site data, some private windows, sandboxed frames).
// Preferences are a convenience, so a failure just means defaults and nothing saved.
export function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function storageSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* not saved */ }
}

export function storageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* nothing to remove */ }
}

export function loadJsonPref(key, fallback) {
    try {
        const raw = storageGet(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}
