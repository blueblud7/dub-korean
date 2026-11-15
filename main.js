// DUB Korean — Electron 진입점: 내장 서버를 켜고 그 주소를 앱 창에 띄운다.
const { app, BrowserWindow, session, shell, systemPreferences, dialog } = require('electron');
const path = require('path');

app.setName('DUB Korean');
app.setAboutPanelOptions({ applicationName: 'DUB Korean', applicationVersion: require('./package.json').version, copyright: 'Copyright © 혜리쌤', credits: 'Created by Mrs. Chun 혜리쌤' });
process.env.PORT = process.env.PORT || '47831';

// 자동 테스트용 (평소에는 꺼져 있음): 파일을 가짜 마이크로 쓰고, 원격 디버깅 포트로 앱을 제어
if (process.env.DUB_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  if (process.env.DUB_FAKE_MIC !== '1') app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.DUB_FAKE_MIC);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}
if (process.env.DUB_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.DUB_DEBUG_PORT);
// 설치된 앱: 사용자 데이터/결과물을 쓰기 가능한 위치에 두고, 첫 실행 때 구성요소 자동 설치
if (app.isPackaged) {
  process.env.DUB_DATA = process.env.DUB_DATA || path.join(app.getPath('userData'), 'data');
  process.env.DUB_OUT = process.env.DUB_OUT || path.join(app.getPath('videos'), 'DUB Korean');
  process.env.DUB_AUTOSETUP = '1';
}
require('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1040, height: 820, minWidth: 720, minHeight: 600,
    title: 'DUB Korean', icon: path.join(__dirname, 'assets', 'icon.png'), show: !process.env.DUB_HEADLESS, backgroundColor: '#0d0e13',
    webPreferences: { contextIsolation: true },
  });
  const sysLang = (app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en');
  win.loadURL(`http://localhost:${process.env.PORT}/?lang=${encodeURIComponent(sysLang)}`);
  // 다운로드 링크 등 외부 이동은 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  // 마이크(녹음)만 허용
  session.defaultSession.setPermissionRequestHandler((_, perm, cb) => cb(perm === 'media'));
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  createWindow();
  // macOS 마이크 권한: 거부 상태면 녹음이 무음으로 나오므로 미리 요청/안내
  if (process.platform === 'darwin' && !process.env.DUB_FAKE_MIC) {
    const st = systemPreferences.getMediaAccessStatus('microphone');
    const ok = st === 'granted' || (st === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
    if (!ok) dialog.showMessageBox({ type: 'warning', ...((app.getPreferredSystemLanguages()[0] || app.getLocale()).startsWith('ko')
      ? { message: '마이크 권한이 꺼져 있습니다', detail: '시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 이 앱(Electron)을 허용한 뒤 앱을 다시 실행하세요.' }
      : { message: 'Microphone access is turned off', detail: 'Allow this app (Electron) under System Settings → Privacy & Security → Microphone, then relaunch the app.' }) });
  }
  app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow());
});
app.on('window-all-closed', () => app.quit());
