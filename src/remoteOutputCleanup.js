function stripRemoteCodexColorMarkers(text) {
  return String(text || '').replace(/<!--remote-codex-color:[^>]+-->/g, '');
}

function isWorkingRepaintGarbageLine(line) {
  const value = stripRemoteCodexColorMarkers(line).trim();
  if (/[\u3400-\u9fff]/.test(value)) return false;
  const compact = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (isWorkingRepaintFragmentCompact(compact)) return true;
  if (!/[•●]/.test(value)) return false;
  if (compact.length < 12) return false;

  const fragments = compact.match(
    /working|workin|worki|work|rking|king|ing|ngg|ng|codex|code|cod|odex|dex|apps|app|pps|wwo|wor|wrk/g
  ) || [];
  if (fragments.length < 3) return false;

  const fragmentChars = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
  const remainder = compact.replace(
    /working|workin|worki|work|rking|king|ing|ngg|ng|codex|code|cod|odex|dex|apps|app|pps|interrupt|interupt|esc|to|wr?k|wwo|wor|wrk|\d+s?|\d+/g,
    ''
  );

  return fragmentChars / compact.length >= 0.45 && remainder.length / compact.length <= 0.35;
}

function isWorkingRepaintFragmentCompact(compact) {
  const value = String(compact || '').toLowerCase();
  if (!value) return false;
  if (/^(?:ng|ing|king|rking|orking|wwo|wor|wrk|work|worki|workin|working)$/.test(value)) {
    return true;
  }
  if (/^(?:ingng|ngg\d*)$/.test(value)) return true;
  if (isMcpOrCodexRepaintFragmentCompact(value)) return true;
  if (value.length > 18) return false;
  if (!/(?:wwo|wor|wrk|ngg|rking|king|working|workin|worki)/.test(value)) return false;
  const remainder = value.replace(
    /working|workin|worki|work|rking|king|ing|ngg|ng|wwo|wor|wrk|interrupt|interupt|esc|to|\d+s?|\d+/g,
    ''
  );
  return remainder.length <= Math.max(1, Math.floor(value.length * 0.2));
}

function isMcpOrCodexRepaintFragmentCompact(compact) {
  const value = String(compact || '').toLowerCase();
  if (!value || value.length > 64) return false;
  if (!/(?:boot|mcp|codex|odex|dex|apps|pps)/.test(value)) return false;
  const fragments = value.match(
    /booting|bootin|boot|ooting|oting|ingmcp|mcpse|mcp|mc|ting|codex|code|cod|odex|dex|apps|app|pps/g
  ) || [];
  if (fragments.length === 0) return false;
  const fragmentChars = fragments.reduce((sum, fragment) => sum + fragment.length, 0);
  const remainder = value.replace(
    /booting|bootin|boot|ooting|oting|ingmcp|mcpse|mcp|mc|ting|server|ser|codex|code|cod|odex|dex|apps|app|pps|\d+/g,
    ''
  );
  return (
    fragmentChars / value.length >= 0.55 &&
    remainder.length <= Math.max(1, Math.floor(value.length * 0.25))
  );
}

function isLikelyStandaloneFileLine(line) {
  const value = String(line || '').trim();
  if (!value || value.length > 180) return false;
  return /^(?:\.[\w-]+|[\w@./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|css|html|py|sh|yml|yaml|toml|lock|txt))(?::\d+)?(?:\s+\d+)?(?:\s|$)/.test(value);
}

function isLikelyFileStatLine(line) {
  const value = String(line || '').trim();
  if (!value || value.length > 220) return false;
  return /^\d+\s+(?:\.[\w-]+|[\w@./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|css|html|py|sh|yml|yaml|toml|lock|txt))(?::\d+)?(?:\s|$)/.test(value);
}

function stripTerminalRepaintArtifacts(line) {
  let value = String(line || '').trimEnd();
  value = stripTrailingTerminalStatusNoise(value);
  value = stripTrailingWorkingRepaintFragments(value);
  value = stripTrailingTerminalStatusNoise(value);
  value = value.replace(/([。！？；?])(?:[A-Za-z0-9]{1,2})$/u, '$1');
  value = value.replace(
    /\s*(?:W?orking|W?orkin|W?orki|W?ork|orking|rking|king|ing|ng)+[•●]+\s*$/i,
    ''
  );
  return value.trimEnd();
}

function stripTrailingTerminalStatusNoise(value) {
  let text = String(value || '').trimEnd();
  for (let index = 0; index < 3; index += 1) {
    const next = text.replace(
      /\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*•\s*esc\s*to\s*(?:interrupt|interupt)\)?(?:\s*[•●]?\s*(?:(?:Working|Workin|Worki|Work|WWo|Wrk|Wor|Wo|W|orking|rking|king|ing)\d*|ingng\d*|ngg?\d*)\s*)*[•●]*\s*$/i,
      ''
    ).trimEnd();
    if (next === text) break;
    text = next;
  }
  return text;
}

function stripTrailingWorkingRepaintFragments(value) {
  const text = String(value || '').trimEnd();
  const match = text.match(
    /(?:[•●]?\s*(?:(?:Working|Workin|Worki|Work|WWo|Wrk|Wor|Wo|W|orking|rking|king|ing)\d*|ingng\d*|ngg?\d*)\s*)+$/i
  );
  if (!match) return text;

  const before = text.slice(0, match.index);
  const fragment = match[0];
  if (!before) return text;
  const compact = fragment.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const strongFragment =
    /[•●]/.test(fragment) ||
    compact.length >= 6 ||
    /(?:working|workin|worki|rking|ingng|ngg|wrk)/.test(compact);
  const attachedToCjkText =
    /[\u3400-\u9fff。！？；：，、]$/.test(before) && !/^\s/.test(fragment);
  if (!strongFragment && !attachedToCjkText) return text;
  if (!/[\u3400-\u9fff]/.test(before) && !/[•●]/.test(fragment)) return text;
  return before.trimEnd();
}

module.exports = {
  isLikelyFileStatLine,
  isLikelyStandaloneFileLine,
  isWorkingRepaintFragmentCompact,
  isWorkingRepaintGarbageLine,
  stripRemoteCodexColorMarkers,
  stripTerminalRepaintArtifacts,
  stripTrailingTerminalStatusNoise,
  stripTrailingWorkingRepaintFragments
};
