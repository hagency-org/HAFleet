export function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

export function restoreEnv(snapshot) {
  if (!snapshot) return;
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
