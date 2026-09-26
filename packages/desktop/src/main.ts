import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

// ======================== 修复 Windows 控制台中文乱码 ========================
if (process.platform === 'win32') {
  try {
    if (process.stdout) process.stdout.setEncoding('utf8');
    if (process.stderr) process.stderr.setEncoding('utf8');
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';
  } catch (err) {
    console.error('[Desktop] 控制台编码设置失败:', err);
  }
}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args: unknown[]) => originalConsoleLog.call(console, '[Desktop]', ...args);
console.error = (...args: unknown[]) => originalConsoleError.call(console, '[Desktop]', ...args);

// ======================== 类型定义 ========================

interface DevServers {
  web: ChildProcess | null;
  orch: ChildProcess | null;
}

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

// ======================== 全局状态 ========================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let devServers: DevServers = { web: null, orch: null };
let isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// ======================== 窗口状态持久化 ========================

const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  try {
    if (fs.existsSync(windowStatePath)) {
      return JSON.parse(fs.readFileSync(windowStatePath, 'utf-8'));
    }
  } catch (err) {
    console.error('[Desktop] 窗口状态加载失败，使用默认值:', err);
  }
  return { width: 1400, height: 900, isMaximized: false };
}

function saveWindowState(state: WindowState): void {
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[Desktop] 窗口状态保存失败:', err);
  }
}

// ======================== 加载页面 HTML ========================

const loadingHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      background: #1e1e1e;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .container { text-align: center; }
    h1 { font-size: 24px; margin-bottom: 20px; }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #333;
      border-top-color: #4a9eff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { color: #888; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>AI Cowork</h1>
    <div class="spinner"></div>
    <div class="status" id="status">正在启动...</div>
  </div>
</body>
</html>
`;

// ======================== 窗口创建 ========================

function createMainWindow(): void {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'AI Cowork',
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', () => {
    if (mainWindow) {
      const bounds = mainWindow.getBounds();
      saveWindowState({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: mainWindow.isMaximized(),
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 开发模式：先显示加载页
  if (isDev) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadingHTML));
    mainWindow.webContents.openDevTools();
  } else {
    // 生产模式：加载打包后的前端
    mainWindow.loadFile(path.join(__dirname, '../web/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });
}

// ======================== 端口检测 ========================

function waitForPort(port: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const { Socket } = require('net');
    const startTime = Date.now();

    const check = () => {
      const socket = new Socket();
      socket.setTimeout(500);
      socket.on('connect', () => {
        socket.destroy();
        console.log(`端口 ${port} 就绪`);
        resolve();
      });
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() - startTime > timeout) {
          reject(new Error(`端口 ${port} 等待超时`));
        } else {
          setTimeout(check, 200);
        }
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - startTime > timeout) {
          reject(new Error(`端口 ${port} 连接失败`));
        } else {
          setTimeout(check, 200);
        }
      });
      socket.connect(port, '127.0.0.1');
    };

    check();
  });
}

// ======================== 启动开发服务器 ========================

function startDevServers(): Promise<void> {
  return new Promise(async (resolve) => {
    console.log('启动开发服务器...');

    const rootDir = path.join(__dirname, '../..');

    // 启动 orchestrator (3001)
    console.log('启动 orchestrator :3001...');
    devServers.orch = spawn('npm', ['run', 'dev:orch'], {
      cwd: rootDir,
      shell: true,
      stdio: 'pipe',
    });

    devServers.orch.on('error', (err) => {
      console.error('[orchestrator] 进程启动失败:', err);
      stopDevServers();
    });

    devServers.orch.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('[orchestrator] 进程异常退出, code:', code);
      }
    });

    devServers.orch.stdout?.on('data', (data: Buffer) => {
      process.stdout.write('[orchestrator] ' + data.toString('utf8'));
    });

    devServers.orch.stderr?.on('data', (data: Buffer) => {
      process.stderr.write('[orchestrator] ' + data.toString('utf8'));
    });

    devServers.orch.stdout?.on('close', () => {
      console.log('[orchestrator] stdout 已关闭');
    });

    devServers.orch.stderr?.on('close', () => {
      console.log('[orchestrator] stderr 已关闭');
    });

    // 启动 web (3000)
    console.log('启动 web :3000...');
    devServers.web = spawn('npm', ['run', 'dev:web'], {
      cwd: rootDir,
      shell: true,
      stdio: 'pipe',
    });

    devServers.web.on('error', (err) => {
      console.error('[web] 进程启动失败:', err);
      stopDevServers();
    });

    devServers.web.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('[web] 进程异常退出, code:', code);
      }
    });

    devServers.web.stdout?.on('data', (data: Buffer) => {
      process.stdout.write('[web] ' + data.toString('utf8'));
    });

    devServers.web.stderr?.on('data', (data: Buffer) => {
      process.stderr.write('[web] ' + data.toString('utf8'));
    });

    devServers.web.stdout?.on('close', () => {
      console.log('[web] stdout 已关闭');
    });

    devServers.web.stderr?.on('close', () => {
      console.log('[web] stderr 已关闭');
    });

    // 等待服务器就绪
    try {
      console.log('等待服务器就绪...');
      await Promise.all([
        waitForPort(3001, 60000),
        waitForPort(3000, 60000),
      ]);
      console.log('所有服务器就绪');
      resolve();
    } catch (err) {
      console.error('服务器启动失败:', err);
      resolve();
    }
  });
}

function stopDevServers(): void {
  if (devServers.orch) {
    // Windows 下 SIGINT 比 SIGTERM 更可靠
    devServers.orch.kill('SIGINT');
    devServers.orch = null;
  }
  if (devServers.web) {
    devServers.web.kill('SIGINT');
    devServers.web = null;
  }
}

// ======================== URL 安全验证 ========================

function safeOpenExternal(url: string): boolean {
  // ★ 安全修复：统一 URL 协议白名单验证，防止恶意协议攻击
  try {
    const parsed = new URL(url);
    const allowedProtocols = ['https:', 'http:'];
    if (!allowedProtocols.includes(parsed.protocol)) {
      console.warn('[安全] 阻止不安全的 URL 协议:', parsed.protocol, url);
      return false;
    }
    shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('[安全] openExternal 参数无效:', err);
    return false;
  }
}

// ======================== IPC 处理器 ========================

function setupIpcHandlers(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:isDev', () => isDev);
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized());
  ipcMain.handle('shell:openExternal', (_event, url: string) => safeOpenExternal(url));
}

// ======================== 应用菜单 ========================

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-session'),
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    { label: '帮助', submenu: [{ label: '关于', click: () => { const { dialog } = require('electron'); dialog.showMessageBox({ type: 'info', title: '关于 AI Cowork', message: `AI Cowork v${app.getVersion()}`, detail: '基于 LLM 的结对编程工作台' }); } }] },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ======================== 系统托盘 ========================

function createTray(): void {
  // 创建简单的托盘图标（16x16 数据 URI）
  const iconPath = path.join(__dirname, '../build/icon.png');
  let trayIcon: Electron.NativeImage;

  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // 无图标时创建简单纯色图标
    trayIcon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADgSURBVDiNpZMxDoJAEEXfLhZewAvYeAEbr+ABbLyAB7DxAh7AxtpYUFh4ACsvYOUBLK0LC4sYxMZuNpvJJpP8ZDKzL4D/wgJ4AHdgXUTkG5FXoAM4vM+ADnAHNkAZ+AH2QFfE9oE+sAfWwBroAz1g7r1eA2OgB3SAkfe+4X0L9ICJ977h/Qj0gKn3fuR9AHSAqfd+5H0AtIGZ937kfQy0gan3fuR9DDSAqfd+5H0M1ICp937kfQJUgIn3fuR9AlSAX93xV3sG/4wL0N5xY/8AAAAASUVORK5CYII='
    );
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('AI Cowork');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ======================== 应用生命周期 ========================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    console.log('AI Cowork 启动中...');
    console.log('开发模式:', isDev);
    console.log('Electron 版本:', process.versions.electron);

    // 创建窗口（显示加载页）
    createMainWindow();
    setupIpcHandlers();
    createMenu();
    createTray();

    // 开发模式下启动服务器
    if (isDev) {
      await startDevServers();
      // 服务器就绪后加载真实页面
      mainWindow?.loadURL('http://localhost:3000');
    }

    console.log('启动完成');
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      stopDevServers();
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  app.on('before-quit', () => {
    stopDevServers();
  });
}
