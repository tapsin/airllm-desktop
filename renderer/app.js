const $ = id => document.getElementById(id);
const model = $('model'), token = $('token'), start = $('start'), stop = $('stop');
let busy = false;
function state(kind, text) { $('state').textContent = text; $('lamp').parentElement.className = `status ${kind}`; }
function log(text) {
  const box = $('log');
  if (box.textContent.startsWith('Kurulum ve')) box.textContent = '';
  box.textContent += text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
  box.scrollTop = box.scrollHeight;
}
function setBusy(value) { busy = value; start.disabled = value; stop.disabled = !value; model.disabled = value; $('track').className = value ? 'track active' : 'track'; }
function showOnline(event) {
  $('api').classList.remove('hidden');
  $('url').textContent = event.url || 'http://127.0.0.1:8000/v1';
  const managed = Boolean(event.managed);
  start.disabled = managed;
  stop.disabled = !(managed || event.stopAllowed);
  model.disabled = managed;
  busy = managed && !['ready', 'error'].includes(event.state);
  if (event.state === 'generating') {
    state('busy', 'Yanıt üretiliyor');
    $('progress').textContent = event.message || 'Model yanıt üretiyor ve Open WebUI’ye aktarıyor.';
    $('track').className = 'track active';
  } else if (event.state === 'error') {
    state('error', 'İstek hatası');
    $('progress').textContent = event.message || 'Yanıt üretiminde hata oluştu.';
    $('track').className = 'track';
  } else {
    state('ready', managed ? 'API aktif · bekliyor' : 'API aktif');
    $('progress').textContent = managed ? (event.message || 'Model hazır; yeni istek bekliyor.') : (event.message || 'Dışarıdan başlatılmış API çalışıyor.');
    $('track').className = 'track done';
  }
}
window.airllm.onStatus(event => {
  if (event.type === 'progress') { $('progress').textContent = event.message; state('busy', 'Hazırlanıyor'); setBusy(true); }
  if (event.type === 'model-progress') {
    $('progress').textContent = event.message;
    $('percent').textContent = `${event.percent}%`;
    $('track').className = 'track determinate';
    $('bar').style.width = `${Math.max(0, Math.min(100, event.percent))}%`;
    state('busy', 'Model hazırlanıyor');
  }
  if (event.type === 'log') log(event.text);
  if (event.type === 'ready') { showOnline({ ...event, state: 'ready', message: 'Model hazır; Open WebUI istekleri bekleniyor.' }); busy = false; }
  if (event.type === 'server-state' && event.online) showOnline(event);
  if (event.type === 'server-state' && !event.online) { state('', 'API kapalı'); $('progress').textContent = event.message || 'Model sunucusu durdu.'; $('track').className = 'track'; $('api').classList.add('hidden'); start.disabled = false; stop.disabled = true; model.disabled = false; busy = false; }
  if (event.type === 'error') { state('error', 'Hata'); $('progress').textContent = event.message; $('track').className = 'track'; setBusy(false); }
  if (event.type === 'stopped') { state('', 'Durduruldu'); $('progress').textContent = 'Model sunucusu durduruldu.'; $('track').className = 'track'; $('api').classList.add('hidden'); setBusy(false); }
});
window.airllm.settings().then(s => { if (s.model) model.value = s.model; });
start.addEventListener('click', async () => {
  if (busy) return;
  await window.airllm.save({ model: model.value.trim() });
  $('progress').textContent = 'Kurulum başlatılıyor…'; $('track').className = 'track active'; $('api').classList.add('hidden'); state('busy', 'Başlatılıyor'); setBusy(true);
  const result = await window.airllm.start(model.value, token.value);
  if (!result.ok) { state('error', 'Hata'); $('progress').textContent = result.error; setBusy(false); }
});
stop.addEventListener('click', async () => {
  stop.disabled = true;
  $('progress').textContent = 'Sunucu/kurulum durduruluyor…';
  state('busy', 'Durduruluyor');
  const result = await window.airllm.stop();
  if (!result) stop.disabled = false;
});
$('copy').addEventListener('click', async () => { await navigator.clipboard.writeText($('url').textContent); $('copy').textContent = 'Kopyalandı'; setTimeout(() => $('copy').textContent = 'Adresi kopyala', 1500); });
