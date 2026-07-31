function configureSingleInstance({ app, getMainWindow, logger = console }) {
  const acquired = Boolean(app.requestSingleInstanceLock());
  if (!acquired) {
    app.quit();
    return false;
  }

  app.on('second-instance', (_event, _argv, workingDirectory) => {
    logger.event?.('app.second_instance.focused', {
      workingDirectory: String(workingDirectory || '')
    });
    const window = getMainWindow?.();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}

module.exports = {
  configureSingleInstance
};
