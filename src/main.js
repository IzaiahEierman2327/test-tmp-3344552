'use strict';

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron');
const { AppController } = require('./app-controller');
const { EulerSessionCookieStore } = require('./euler-session-cookie-store');
const { JupyterManager } = require('./jupyter');
const { StateStore } = require('./state-store');
const { INSTALLED_MODE_MARKER, resolveStoragePaths } = require('./storage-paths');
const { WorkbenchService } = require('./workbench-service');

const TOOLBAR_HEIGHT = 64;
const STATUS_HEIGHT = 28;
const DIVIDER_WIDTH = 7;

let mainWindow = null;
let toolsWindow = null;
let leftView = null;
let rightView = null;
let controller = null;
let jupyter = null;
let workbench = null;
let stateStore = null;
let eulerSession = null;
let eulerSessionCookieStore = null;
let closing = false;
let storagePaths = null;
let storageBootstrapError = null;

function configureStorage() {
  const executablePath = app.getPath('exe');
  const installedMode = app.isPackaged && fsSync.existsSync(
    path.join(path.dirname(path.resolve(executablePath)), INSTALLED_MODE_MARKER)
  );

  const resolved = resolveStoragePaths({
    isPackaged: app.isPackaged,
    isInstalled: installedMode,
    executablePath,
    userDataPath: app.getPath('userData'),
    sessionDataPath: app.getPath('sessionData'),
    documentsPath: app.getPath('documents'),
  });

  if (resolved.portable) {
    for (const directory of [
      resolved.dataRoot,
      resolved.userDataRoot,
      resolved.sessionDataRoot,
      resolved.runtimeStateRoot,
      resolved.userPackagesRoot,
      resolved.settingsRoot,
      resolved.workspaceRoot,
      resolved.tempRoot,
      resolved.crashDumpsRoot,
    ]) {
      fsSync.mkdirSync(directory, { recursive: true });
    }

    app.setPath('userData', resolved.userDataRoot);
    app.setPath('sessionData', resolved.sessionDataRoot);
    app.setPath('crashDumps', resolved.crashDumpsRoot);
    process.env.TEMP = resolved.tempRoot;
    process.env.TMP = resolved.tempRoot;
    process.env.TMPDIR = resolved.tempRoot;
  }

  storagePaths = resolved;
}

try {
  configureStorage();
} catch (error) {
  storageBootstrapError = error;
}

function runtimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'python')
    : path.join(app.getAppPath(), 'runtime', 'python');
}

function appDataRoot() {
  return storagePaths.runtimeStateRoot;
}

function workspaceRoot() {
  return storagePaths.workspaceRoot;
}

function layoutViews() {
  if (!mainWindow || !leftView || !rightView) return;
  const [width, height] = mainWindow.getContentSize();
  const bodyHeight = Math.max(0, height - TOOLBAR_HEIGHT - STATUS_HEIGHT);
  const ratio = stateStore?.get().splitRatio ?? 0.45;
  const available = Math.max(0, width - DIVIDER_WIDTH);
  const leftWidth = Math.round(available * ratio);
  const rightWidth = Math.max(0, available - leftWidth);

  leftView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: leftWidth, height: bodyHeight });
  rightView.setBounds({
    x: leftWidth + DIVIDER_WIDTH,
    y: TOOLBAR_HEIGHT,
    width: rightWidth,
    height: bodyHeight,
  });
}

function configureEulerSession() {
  eulerSession = session.fromPartition('persist:project-euler-workbench-euler');
  eulerSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  return eulerSession;
}

function protectLocalWindow(window) {
  if (!window || window.isDestroyed()) return;
  const wc = window.webContents;
  const openExternal = (url) => {
    if (/^https?:/i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
  };
  const blockNavigation = (event, detailsOrUrl) => {
    const url = typeof detailsOrUrl === 'string' ? detailsOrUrl : detailsOrUrl?.url;
    event.preventDefault();
    openExternal(url);
  };
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', blockNavigation);
  wc.on('will-redirect', blockNavigation);
}

function assertToolsSender(event) {
  if (!toolsWindow || toolsWindow.isDestroyed() || event.sender !== toolsWindow.webContents) {
    throw new Error('Unauthorized tools IPC sender');
  }
}

function registerToolsHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertToolsSender(event);
    return handler(...args);
  });
}

function makeViews() {
  configureEulerSession();
  leftView = new WebContentsView({
    webPreferences: {
      partition: 'persist:project-euler-workbench-euler',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });

  rightView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.contentView.addChildView(leftView);
  mainWindow.contentView.addChildView(rightView);

  rightView.webContents.setWindowOpenHandler(({ url }) => {
    if (jupyter?.port && url.startsWith(`http://127.0.0.1:${jupyter.port}/`)) {
      rightView.webContents.loadURL(url).catch(console.error);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  rightView.webContents.on('will-navigate', (event, detailsOrUrl) => {
    const url = typeof detailsOrUrl === 'string' ? detailsOrUrl : detailsOrUrl.url;
    if (!url) return;
    const allowed = url.startsWith('data:text/html') ||
      (jupyter?.port && url.startsWith(`http://127.0.0.1:${jupyter.port}/`));
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
}

async function openTools(section = 'dashboard') {
  if (toolsWindow && !toolsWindow.isDestroyed()) {
    toolsWindow.show();
    toolsWindow.focus();
    toolsWindow.webContents.send('tools:section', section);
    return;
  }

  toolsWindow = new BrowserWindow({
    parent: mainWindow || undefined,
    width: 1040,
    height: 780,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: 'Project Euler Workbench Tools',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'tools-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  toolsWindow.setMenuBarVisibility(false);
  toolsWindow.on('closed', () => { toolsWindow = null; });
  await toolsWindow.loadFile(path.join(__dirname, 'ui', 'tools.html'));
  protectLocalWindow(toolsWindow);
  toolsWindow.webContents.send('tools:section', section);
  toolsWindow.show();
}

async function createWindow() {
  await Promise.all([
    fs.mkdir(workspaceRoot(), { recursive: true }),
    fs.mkdir(appDataRoot(), { recursive: true }),
    fs.mkdir(storagePaths.userPackagesRoot, { recursive: true }),
    fs.mkdir(storagePaths.settingsRoot, { recursive: true }),
  ]);

  stateStore = new StateStore(storagePaths.stateFile);
  await stateStore.load();

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    title: 'Project Euler Workbench',
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  protectLocalWindow(mainWindow);
  makeViews();
  layoutViews();

  eulerSessionCookieStore = new EulerSessionCookieStore({
    session: eulerSession,
    safeStorage,
    filePath: path.join(storagePaths.settingsRoot, 'euler-session-cookies.json'),
  });
  const restoredCookies = await eulerSessionCookieStore.restore();
  if (restoredCookies) console.info(`[euler-session] restored ${restoredCookies} session cookie(s)`);
  eulerSessionCookieStore.startAutoSave();

  mainWindow.on('resize', layoutViews);
  mainWindow.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    (async () => {
      try {
        await controller?.beforeClose();
      } catch (error) {
        console.error('Save before exit failed:', error);
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Could not save notebook',
          message: 'The current notebook could not be saved.',
          detail: `${error.message || error}\n\nKeep the app open to avoid losing unsaved work.`,
          buttons: ['Keep open', 'Close anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (choice.response === 0) {
          closing = false;
          return;
        }
      }

      try {
        await eulerSessionCookieStore?.shutdown();
      } catch (error) {
        // Login persistence is best-effort and must never trap the user in the
        // application if secure storage or Chromium storage flushing fails.
        console.warn(`[euler-session] final persistence failed: ${error.message || error}`);
      }

      try {
        await jupyter?.shutdown();
      } catch (error) {
        console.error('Jupyter shutdown error:', error);
      }

      if (toolsWindow && !toolsWindow.isDestroyed()) toolsWindow.destroy();
      if (leftView && !leftView.webContents.isDestroyed()) leftView.webContents.close();
      if (rightView && !rightView.webContents.isDestroyed()) rightView.webContents.close();
      leftView = null;
      rightView = null;
      controller = null;
      workbench = null;
      eulerSessionCookieStore = null;
      eulerSession = null;
      mainWindow.destroy();
      app.quit();
    })();
  });

  jupyter = new JupyterManager({
    runtimeRoot: runtimeRoot(),
    dataRoot: appDataRoot(),
    workspaceRoot: workspaceRoot(),
    userPackagesRoot: storagePaths.userPackagesRoot,
  });
  jupyter.attachView(rightView);

  controller = new AppController({
    leftView,
    rightView,
    window: mainWindow,
    workspaceRoot: workspaceRoot(),
    stateStore,
    jupyter,
  });
  controller.bindEvents();
  jupyter.setSubmitHandler((value) => controller.fillAnswer(value));

  workbench = new WorkbenchService({
    workspaceRoot: workspaceRoot(),
    settingsRoot: storagePaths.settingsRoot,
    packagesRoot: storagePaths.userPackagesRoot,
    jupyter,
    controller,
    safeStorage,
  });

  mainWindow.maximize();
  mainWindow.show();

  try {
    controller.message = 'Starting bundled Python and JupyterLab…';
    controller.pushUiState();
    await jupyter.start();
    await controller.restore();
  } catch (error) {
    console.error(error);
    controller.saveState = 'error';
    controller.message = error.message;
    controller.pushUiState();
    await jupyter.showPlaceholder(error.message).catch(() => {});
  }
}

function registerIpc() {
  ipcMain.handle('ui:get-state', () => controller?.getUiState() ?? null);
  ipcMain.handle('nav:back', () => controller?.goBack());
  ipcMain.handle('nav:forward', () => controller?.goForward());
  ipcMain.handle('nav:reload', () => controller?.reload());
  ipcMain.handle('nav:home', () => controller?.home());
  ipcMain.handle('action:save', () => controller?.saveRightNotebook('Saving notebook'));
  ipcMain.handle('action:run-all', () => controller?.runAllAndSave());
  ipcMain.handle('problem:set-status', (_event, status) => workbench?.setStatus(null, status));
  ipcMain.handle('tools:open', (_event, section) => openTools(section));

  registerToolsHandler('tools:context', () => workbench?.currentContext());
  registerToolsHandler('tools:dashboard', () => workbench?.dashboard());
  registerToolsHandler('tools:set-status', (problemId, status) => workbench?.setStatus(problemId, status));
  registerToolsHandler('tools:save-solution', (details) => workbench?.saveCurrentSolution(details || {}));
  registerToolsHandler('tools:snippets', () => workbench?.listSnippets());
  registerToolsHandler('tools:save-snippet', (details) => workbench?.saveActiveCellSnippet(details || {}));
  registerToolsHandler('tools:insert-snippet', (id) => workbench?.insertSnippet(id));
  registerToolsHandler('tools:remove-snippet', (id) => workbench?.removeSnippet(id));
  registerToolsHandler('tools:search', (query) => workbench?.search(query));
  registerToolsHandler('tools:statistics', () => workbench?.statistics());
  registerToolsHandler('tools:packages', () => workbench?.listPackages());
  registerToolsHandler('tools:package-install', (spec) => workbench?.installPackage(spec));
  registerToolsHandler('tools:package-uninstall', (name) => workbench?.uninstallPackage(name));
  registerToolsHandler('tools:kernel-restart', () => workbench?.restartKernel());
  registerToolsHandler('tools:ai-config', () => workbench?.getAIConfig());
  registerToolsHandler('tools:ai-save', (config) => workbench?.saveAIConfig(config || {}));
  registerToolsHandler('tools:ai-test', (config) => workbench?.testAI(config || {}));
  registerToolsHandler('tools:article-generate', (options) => workbench?.generateArticle(options || {}));
  registerToolsHandler('tools:articles', (problemId) => workbench?.listArticles(problemId));
  registerToolsHandler('tools:article-read', (problemId, articleId) => workbench?.readArticle(problemId, articleId));
  registerToolsHandler('tools:article-update', (problemId, articleId, update) => workbench?.updateArticle(problemId, articleId, update || {}));

  ipcMain.on('layout:set-split', (_event, value) => {
    const ratio = Math.min(0.8, Math.max(0.2, Number(value) || 0.45));
    stateStore?.patch({ splitRatio: ratio }).catch(console.error);
    layoutViews();
    controller?.pushUiState();
  });
}

app.whenReady().then(async () => {
  if (storageBootstrapError) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Storage initialization failed',
      message: 'Project Euler Workbench could not initialize its data folders.',
      detail: `${storageBootstrapError.message || storageBootstrapError}\n\nIf you are using the portable ZIP, extract or move the complete application to a writable folder and try again.`,
      buttons: ['Close'],
      noLink: true,
    });
    app.quit();
    return;
  }

  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !closing) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !closing) createWindow().catch(console.error);
});
