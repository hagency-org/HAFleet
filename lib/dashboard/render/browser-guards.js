export const DASHBOARD_BROWSER_GUARDS_SCRIPT = `
function safeStorage(name) {
  try {
    const store = window[name];
    if (!store) return null;
    return store;
  } catch {
    return null;
  }
}

function storageGet(store, key, fallback = '') {
  try {
    return store ? store.getItem(key) : fallback;
  } catch {
    return fallback;
  }
}

function storageSet(store, key, value) {
  try {
    if (store) store.setItem(key, value);
  } catch {}
}

function connectDashboardStream(register) {
  try {
    if (typeof EventSource !== 'function') return null;
    const stream = new EventSource('/api/stream');
    if (typeof register === 'function') register(stream);
    return stream;
  } catch {
    return null;
  }
}
`;
