const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, ...args) => {
    const validChannels = [
      'virtual-camera:start',
      'virtual-camera:stop',
      'get-update-state',
      'check-for-updates',
      'download-update',
      'install-update',
      'open-release-page',
      'open-whatsapp-checkout'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Invalid channel: `));
  },
  on: (channel, listener) => {
    const validChannels = ['desktop-updater:state'];
    if (!validChannels.includes(channel) || typeof listener !== 'function') {
      return () => {};
    }

    const wrappedListener = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrappedListener);

    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
  isElectron: true,
  sendVirtualCameraFrame: (frame) => {
    ipcRenderer.send('virtual-camera:push-frame', frame);
  }
});

