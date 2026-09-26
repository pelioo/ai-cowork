import { contextBridge, ipcRenderer } from 'electron';

// 暴露基础 API 到渲染进程（桌面端特有功能）
contextBridge.exposeInMainWorld('electronAPI', {
  // 应用信息
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  isDev: () => ipcRenderer.invoke('app:isDev'),

  // 窗口控制
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // 系统
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // 平台信息
  platform: process.platform,
});

declare global {
  interface Window {
    electronAPI?: {
      getVersion: () => Promise<string>;
      isDev: () => Promise<boolean>;
      minimize: () => Promise<void>;
      maximize: () => Promise<void>;
      close: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      openExternal: (url: string) => Promise<void>;
      platform: string;
    };
  }
}
