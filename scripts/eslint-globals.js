/*
 * The globals `no-undef` must not flag.
 *
 * Hand-written rather than pulled from the `globals` package, which would be a second dependency for a
 * list this short. Each entry is here because this repository's code actually uses it — a global added
 * "just in case" is a hole in the one rule this config runs.
 */
const node = [
  'process', 'Buffer', 'console', '__dirname', '__filename', 'module', 'require', 'exports', 'global',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone',
];

const web = [
  // Present in modern Node and used directly by this codebase.
  'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'MessageChannel', 'performance',
  'crypto', 'btoa', 'atob', 'WebSocket',
];

export default Object.fromEntries([...node, ...web].map((name) => [name, 'readonly']));
