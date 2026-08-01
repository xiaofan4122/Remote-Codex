(function exposeTerminalKeyInput(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RemoteCodexTerminalKeyInput = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function isImeSwitchKeyEvent(event) {
    if (!event) return false;
    if (event.metaKey || event.altKey) return false;
    const key = String(event.key || '').toLowerCase();
    const code = String(event.code || '');
    const ctrlSpace = event.ctrlKey && !event.shiftKey && (
      key === ' ' ||
      key === 'spacebar' ||
      code === 'Space'
    );
    const ctrlShift = event.ctrlKey && event.shiftKey && (
      key === 'control' ||
      key === 'shift' ||
      code.startsWith('Control') ||
      code.startsWith('Shift')
    );
    return ctrlSpace || ctrlShift;
  }

  function isImeCompositionKeyEvent(event, compositionActive = false) {
    if (!event) return false;
    const keyCode = Number(event.keyCode || event.which || 0);
    return Boolean(
      compositionActive ||
      event.isComposing ||
      keyCode === 229 ||
      String(event.key || '') === 'Process'
    );
  }

  function shouldBypassTerminalKeyEvent(event, compositionActive = false) {
    if (isImeSwitchKeyEvent(event)) return true;
    if (!isImeCompositionKeyEvent(event, compositionActive)) return false;

    // xterm already handles keyCode 229 inside CompositionHelper, including its
    // textarea-change fallback. Let that path run unless Chromium also gives us
    // an explicit/tracked composition state that exposes the affected Sogou bug.
    const keyCode = Number(event?.keyCode || event?.which || 0);
    return keyCode !== 229 || Boolean(compositionActive || event?.isComposing);
  }

  return {
    isImeCompositionKeyEvent,
    isImeSwitchKeyEvent,
    shouldBypassTerminalKeyEvent
  };
}));
