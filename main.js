const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');

let win;
let apiProcess;
let setupProcess;
let stopRequested = false;
const port = 8000;
const appRoot = app.isPackaged ? process.resourcesPath : __dirname;
const serverScript = path.join(appRoot, 'airllm_openai_server.py');
const pythonEnv = path.join(app.getPath('userData'), 'python-env');
const venvPython = path.join(pythonEnv, 'bin', 'python');
const venvPip = [venvPython, '-m', 'pip'];

function send(type, data = {}) { if (win && !win.isDestroyed()) win.webContents.send('status', { type, ...data }); }
function createWindow() {
  win = new BrowserWindow({ width: 900, height: 720, minWidth: 680, minHeight: 580,
    backgroundColor: '#0b1110', title: 'AirLLM Desktop', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.on('closed', () => { win = null; });
}

function run(command, args, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUNBUFFERED: '1' } });
    setupProcess = child;
    let stderr = '';
    child.stdout.on('data', b => onData?.(b.toString()));
    child.stderr.on('data', b => { const s = b.toString(); stderr += s; onData?.(s); });
    child.on('error', reject);
    child.on('close', code => { setupProcess = null; code === 0 ? resolve() : reject(new Error(stderr.slice(-3000) || `İşlem ${code} koduyla sonlandı`)); });
  });
}

function checkApi() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, res => { res.resume(); resolve(res.statusCode === 200); });
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function readApiStatus() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/status`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.setTimeout(1000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function requestApiShutdown() {
  return new Promise(resolve => {
    const req = http.request(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST', timeout: 1200 }, res => {
      res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

let lastObservedApi = false;
async function refreshApiStatus() {
  const status = await readApiStatus();
  if (status) {
    lastObservedApi = true;
    send('server-state', { online: true, managed: Boolean(apiProcess), stopAllowed: true, ...status, url: `http://127.0.0.1:${port}/v1` });
    return;
  }
  const online = await checkApi();
  if (online) {
    lastObservedApi = true;
    send('server-state', { online: true, managed: Boolean(apiProcess), state: 'ready', message: 'API çalışıyor; etkinlik bilgisi için sunucuyu güncelleyin.', url: `http://127.0.0.1:${port}/v1` });
  } else if (lastObservedApi) {
    lastObservedApi = false;
    send('server-state', { online: false, state: 'offline', message: 'API bağlantısı kesildi.' });
  }
}

ipcMain.handle('start-model', async (_event, { model, token }) => {
  if (apiProcess) return { ok: false, error: 'Model sunucusu zaten bu uygulama tarafından çalıştırılıyor.' };
  if (!model?.trim()) return { ok: false, error: 'Hugging Face model adresini girin.' };
  if (await checkApi()) {
    lastObservedApi = true;
    send('server-state', { online: true, managed: false, state: 'ready', message: 'API zaten çalışıyor; mevcut sunucuya bağlanıldı.', url: `http://127.0.0.1:${port}/v1` });
    return { ok: true, alreadyRunning: true, url: `http://127.0.0.1:${port}/v1` };
  }
  const modelRef = model.trim();
  stopRequested = false;
  try {
    send('progress', { message: 'Python ortamı hazırlanıyor…' });
    if (!fs.existsSync(venvPython)) {
      // Prefer known Python 3.11 locations. The desktop launcher PATH often
      // omits ~/.local/bin, even when Python 3.11 is installed by uv.
      const candidates = [
        process.env.AIRLLM_PYTHON,
        path.join(os.homedir(), '.local/bin/python3.11'),
        '/usr/bin/python3.11',
        '/usr/bin/python3.12',
        '/usr/bin/python3.13',
        'python3.11',
      ].filter(Boolean);
      let py;
      for (const candidate of candidates) {
        if (candidate.includes('/')) {
          if (fs.existsSync(candidate)) { py = candidate; break; }
        } else {
          const probe = await new Promise(resolve => {
            const p = spawn('sh', ['-lc', `command -v ${candidate}`]);
            let out = ''; p.stdout.on('data', b => out += b.toString());
            p.on('close', () => resolve(out.trim() || null)); p.on('error', () => resolve(null));
          });
          if (probe) { py = probe; break; }
        }
      }
      if (!py) throw new Error('Python 3.11, 3.12 veya 3.13 bulunamadı. Python 3.11 kurun, ardından uygulamayı yeniden başlatın.');
      send('progress', { message: `Sanal Python ortamı oluşturuluyor (${py})…` });
      await run(py, ['-m', 'venv', pythonEnv], s => send('log', { text: s }));
    }
    send('progress', { message: 'Gerekli Python paketleri kuruluyor…' });
    await run(venvPython, ['-m', 'ensurepip', '--upgrade'], s => send('log', { text: s }));
    await run(venvPython, ['-m', 'pip', 'install', '-r', path.join(appRoot, 'requirements.txt')], s => {
      send('log', { text: s });
      const match = s.match(/(\d{1,3})%/);
      if (match) send('progress', { message: `Bağımlılıklar indiriliyor… ${match[1]}%` });
    });
    send('progress', { message: 'Model indiriliyor ve AirLLM hazırlanıyor… bu işlem model boyutuna göre uzun sürebilir.' });
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    if (token?.trim()) env.HF_TOKEN = token.trim();
    const serverArgs = [serverScript, '--model', modelRef, '--host', '127.0.0.1', '--port', String(port)];
    apiProcess = spawn(venvPython, serverArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const processServerOutput = buffer => {
      const text = buffer.toString();
      send('log', { text });
      if (text.includes('Model yükleniyor:')) send('progress', { stage: 'model', message: 'Model ayarları okunuyor…' });
      const shard = text.match(/Loading shard\s+(\d+)\s*\/\s*(\d+)/i);
      if (shard) send('model-progress', { stage: 'weights', message: `Ağırlık parçaları yükleniyor · ${shard[1]}/${shard[2]} · bu parça diske hazırlanıyor`, percent: Math.round(Number(shard[1]) / Number(shard[2]) * 100) });
      const tqdm = text.match(/(\d{1,3})%\|[^\n]*?(\d+)\s*\/\s*(\d+)\s*\[/);
      if (tqdm && Number(tqdm[3]) > 1) {
        const percent = Number(tqdm[1]);
        const message = /Loading shard|Fetching/.test(text)
          ? `Model dosyası indiriliyor/yükleniyor · ${percent}%`
          : `AirLLM katmanları hazırlanıyor · ${tqdm[2]}/${tqdm[3]}`;
        send('model-progress', { stage: /Loading shard|Fetching/.test(text) ? 'weights' : 'layers', message, percent });
      }
      if (text.includes('Model hazır.')) send('progress', { stage: 'server', message: 'Model hazır; API başlatılıyor…' });
    };
    apiProcess.stdout.on('data', processServerOutput);
    apiProcess.stderr.on('data', processServerOutput);
    apiProcess.on('error', e => { send('error', { message: e.message }); apiProcess = null; });
    apiProcess.on('close', code => { apiProcess = null; send('stopped', { code }); });
    let ready = false;
    for (let i = 0; i < 2400; i++) {
      if (!apiProcess) throw new Error('Sunucu model yüklerken kapandı. Günlükteki hata ayrıntılarına bakın.');
      if (await checkApi()) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ready) throw new Error('Sunucu 40 dakika içinde hazır olmadı.');
    send('ready', { url: `http://127.0.0.1:${port}/v1`, model: modelRef });
    return { ok: true, url: `http://127.0.0.1:${port}/v1` };
  } catch (e) {
    if (stopRequested) {
      stopRequested = false;
      send('stopped');
      return { ok: false, stopped: true, error: 'İşlem durduruldu.' };
    }
    send('error', { message: e.message });
    if (apiProcess) { apiProcess.kill('SIGTERM'); apiProcess = null; }
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop-model', async () => {
  stopRequested = true;
  if (setupProcess) {
    setupProcess.kill('SIGTERM');
    setupProcess = null;
  }
  if (apiProcess) {
    const child = apiProcess;
    apiProcess = null;
    child.kill('SIGTERM');
    send('stopped');
    return true;
  }
  if (await checkApi()) {
    const requested = await requestApiShutdown();
    if (requested) {
      for (let i = 0; i < 20; i++) {
        if (!(await checkApi())) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      send('stopped');
      return true;
    }
    stopRequested = false;
    send('error', { message: 'Çalışan API durdurma isteğini kabul etmedi.' });
    return false;
  }
  stopRequested = false;
  send('stopped');
  return true;
});
ipcMain.handle('get-settings', () => {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch { return {}; }
});
ipcMain.handle('save-settings', (_e, data) => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(data, null, 2));
  return true;
});
app.whenReady().then(() => {
  createWindow();
  refreshApiStatus();
  setInterval(refreshApiStatus, 1500);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (apiProcess) apiProcess.kill('SIGTERM'); if (setupProcess) setupProcess.kill('SIGTERM'); if (process.platform !== 'darwin') app.quit(); });
