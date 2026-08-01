(function exposeTerminalFileDrop(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RemoteCodexTerminalFileDrop = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const SAFE_UNQUOTED_PATH = /^\/[A-Za-z0-9_@%+=:,./-]+$/;
  const TERMINAL_CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

  function dataTransferHasFiles(dataTransfer) {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    if (types.includes('Files')) return true;
    return Array.from(dataTransfer.items || []).some((item) => item?.kind === 'file');
  }

  function isSafeDroppedPath(value) {
    return (
      typeof value === 'string' &&
      value.startsWith('/') &&
      value.length > 1 &&
      !TERMINAL_CONTROL_CHARACTER.test(value)
    );
  }

  function quoteDroppedPath(value) {
    if (!isSafeDroppedPath(value)) return '';
    if (SAFE_UNQUOTED_PATH.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  function buildDroppedFilePaste(paths) {
    const quotedPaths = [];
    const seen = new Set();
    for (const value of Array.isArray(paths) ? paths : []) {
      const quoted = quoteDroppedPath(value);
      if (!quoted || seen.has(value)) continue;
      seen.add(value);
      quotedPaths.push(quoted);
    }
    return quotedPaths.length > 0 ? `${quotedPaths.join(' ')} ` : '';
  }

  return {
    buildDroppedFilePaste,
    dataTransferHasFiles,
    isSafeDroppedPath,
    quoteDroppedPath
  };
}));
