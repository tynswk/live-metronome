'use strict';
/* Live Metronome — 画面全体フラッシュ + 任意で音 + PDF譜面
   タイミングは Web Audio の currentTime を唯一の時計として扱う。
   setInterval / rAF はスケジューラを叩くだけで、拍の時刻決定には使わない。 */

const VERSION = '1.0.0';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ============================ state ============================ */

const DEFAULTS = {
  bpm: 120, beats: 4, unit: 4, div: 1,
  accents: [2, 1, 1, 1],
  soundOn: true, vol: 80,
  colBg: '#0b0b0d', colBeat: '#1f6feb', colAccent: '#ff3b30',
  flashOnlyAccent: false, flashLen: 50,
  restartOnSwitch: true, keepAwake: true, tapToToggle: true,
  split: 60, pdfFirst: true, scrollSpeed: 0, autoScroll: false,
  presets: [
    { name: '', bpm: 120, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 },
    { name: '', bpm: 0, beats: 4, unit: 4 }
  ],
  activePreset: -1
};

const KEY = 'lm.state.v1';
let st;
try {
  st = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  if (!Array.isArray(st.presets) || st.presets.length !== 8) st.presets = DEFAULTS.presets;
  if (!Array.isArray(st.accents)) st.accents = DEFAULTS.accents;
} catch (e) { st = Object.assign({}, DEFAULTS); }

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {}
  }, 250);
}

function fixAccents() {
  const a = st.accents.slice(0, st.beats);
  while (a.length < st.beats) a.push(1);
  if (a.length) a[0] = a[0] === 0 ? 0 : 2;
  st.accents = a;
}
fixAccents();

/* ============================ audio ============================ */

const AHEAD = 0.16;   // 何秒先まで音を予約するか
const TICK = 25;      // スケジューラ起動間隔(ms)

const eng = {
  ctx: null, master: null, buf: { acc: null, beat: null, sub: null },
  running: false, nextTime: 0, beat: 0, sub: 0,
  queue: [], last: null, lastColor: ''
};

function mkClick(ctx, freq, dur, amp) {
  const n = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  const tau = dur * 0.22;
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate;
    d[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / tau) * amp;
  }
  // 頭のクリック感（ごく短いノイズ）
  const nn = Math.min(n, Math.ceil(ctx.sampleRate * 0.002));
  for (let i = 0; i < nn; i++) d[i] += (Math.random() * 2 - 1) * 0.25 * amp * (1 - i / nn);
  return b;
}

function initAudio() {
  if (eng.ctx) return eng.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  const g = ctx.createGain();
  g.gain.value = st.soundOn ? st.vol / 100 : 0;
  g.connect(ctx.destination);
  eng.ctx = ctx; eng.master = g;
  eng.buf.acc = mkClick(ctx, 2000, 0.055, 0.9);
  eng.buf.beat = mkClick(ctx, 1250, 0.05, 0.7);
  eng.buf.sub = mkClick(ctx, 1250, 0.03, 0.28);
  // iOS: 無音を1発鳴らしてアンロック
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  s.connect(g); s.start(0);
  return ctx;
}

function beatDur() { return 60 / st.bpm; }

function playBuf(buf, t) {
  const s = eng.ctx.createBufferSource();
  s.buffer = buf;
  s.connect(eng.master);
  s.start(t);
}

function scheduler() {
  if (!eng.running || !eng.ctx) return;
  const now = eng.ctx.currentTime;
  // バックグラウンド復帰などで大きく遅れたら位相を作り直す（詰まった音の連発を防ぐ）
  if (eng.nextTime < now - 0.2) { eng.nextTime = now + 0.03; eng.sub = 0; }
  const step = beatDur() / st.div;
  let guard = 0;
  while (eng.nextTime < now + AHEAD && guard++ < 64) {
    const isBeat = eng.sub === 0;
    const acc = st.accents[eng.beat] | 0;
    if (isBeat) {
      if (acc === 2) playBuf(eng.buf.acc, eng.nextTime);
      else if (acc === 1) playBuf(eng.buf.beat, eng.nextTime);
      eng.queue.push({ t: eng.nextTime, beat: eng.beat });
    } else if (acc !== 0) {
      playBuf(eng.buf.sub, eng.nextTime);
    }
    eng.nextTime += step;
    eng.sub++;
    if (eng.sub >= st.div) { eng.sub = 0; eng.beat = (eng.beat + 1) % st.beats; }
  }
  drain(now);
}

/* 「今どの拍か」の確定。rAF が止まっていても溜まらないよう、こちらでも消化する。 */
function drain(now) {
  while (eng.queue.length && eng.queue[0].t <= now) eng.last = eng.queue.shift();
}

/* スケジューラ駆動：Worker（タブが非アクティブでも止まりにくい）と rAF の二重掛け。
   scheduler() は冪等なので二重に呼ばれても拍は増えない。 */
let ticker = null;
try {
  const src = "let id=null;onmessage=e=>{if(e.data==='start'){if(!id)id=setInterval(()=>postMessage(0)," + TICK + ")}else{clearInterval(id);id=null}}";
  ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  ticker.onmessage = scheduler;
} catch (e) { ticker = null; }
let fallbackTimer = 0;

function start() {
  initAudio();
  if (eng.ctx.state !== 'running') eng.ctx.resume();
  eng.running = true;
  eng.beat = 0; eng.sub = 0;
  eng.queue.length = 0; eng.last = null;
  eng.nextTime = eng.ctx.currentTime + 0.08;
  if (ticker) ticker.postMessage('start');
  else fallbackTimer = setInterval(scheduler, TICK);
  requestWake();
  $('#playBtn').classList.add('on');
  $('#playBtn').firstElementChild.firstElementChild.setAttribute('href', '#i-stop');
  scheduler();
}

function stop() {
  eng.running = false;
  if (ticker) ticker.postMessage('stop');
  clearInterval(fallbackTimer);
  eng.queue.length = 0; eng.last = null;
  paint(st.colBg);
  markDot(-1);
  releaseWake();
  $('#playBtn').classList.remove('on');
  $('#playBtn').firstElementChild.firstElementChild.setAttribute('href', '#i-play');
}

function toggle() { eng.running ? stop() : start(); }

/* ============================ visual ============================ */

const flashPane = $('#flashPane');
function paint(c) {
  if (eng.lastColor === c) return;
  eng.lastColor = c;
  flashPane.style.backgroundColor = c;
}

let dotEls = [];
function buildDots() {
  const box = $('#dots');
  box.textContent = '';
  dotEls = [];
  for (let i = 0; i < st.beats; i++) {
    const el = document.createElement('i');
    if (st.accents[i] === 2) el.className = 'acc';
    box.appendChild(el);
    dotEls.push(el);
  }
}
let litDot = -1;
function markDot(i) {
  if (litDot === i) return;
  if (litDot >= 0 && dotEls[litDot]) dotEls[litDot].classList.remove('on');
  if (i >= 0 && dotEls[i]) dotEls[i].classList.add('on');
  litDot = i;
}

let scrollAcc = 0, lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);

  if (eng.running && eng.ctx) {
    scheduler();
    const now = eng.ctx.currentTime;
    drain(now);
    if (eng.last) {
      const dur = Math.max(0.03, beatDur() * (st.flashLen / 100));
      const on = (now - eng.last.t) < dur;
      const acc = eng.last.beat === 0 || st.accents[eng.last.beat] === 2;
      if (on && (!st.flashOnlyAccent || acc)) paint(acc ? st.colAccent : st.colBeat);
      else paint(st.colBg);
      markDot(eng.last.beat);
    }
  }

  // PDF 自動スクロール
  if (st.autoScroll && st.scrollSpeed > 0 && eng.running && pdfDoc) {
    const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0;
    scrollAcc += st.scrollSpeed * dt;
    if (scrollAcc >= 1) {
      const px = Math.floor(scrollAcc);
      scrollAcc -= px;
      pdfScroll.scrollTop += px;
    }
  }
  lastFrame = ts;
}
requestAnimationFrame(frame);

/* ============================ wake lock ============================ */

let wake = null;
async function requestWake() {
  if (!st.keepAwake || !('wakeLock' in navigator) || wake) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch (e) { wake = null; }
}
function releaseWake() { if (wake) { try { wake.release(); } catch (e) {} wake = null; } }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (eng.ctx && eng.ctx.state !== 'running') eng.ctx.resume();
  if (eng.running) { requestWake(); scheduler(); }
});
window.addEventListener('pageshow', () => { if (eng.ctx && eng.running) eng.ctx.resume(); });

/* ============================ UI ============================ */

function refresh() {
  $('#bpmBig').textContent = st.bpm;
  $('#bpmRange').value = st.bpm;
  $('#bpmOut').textContent = st.bpm;
  const u = st.unit === 12 ? '4.' : st.unit;
  $('#meterLabel').textContent = st.beats + '/' + u;
  $('#meterOut').textContent = st.beats + '/' + u;
  $('#beatsVal').textContent = st.beats;
  segSet('#unitSeg', 'unit', st.unit);
  segSet('#divSeg', 'div', st.div);
  $('#soundOn').checked = st.soundOn;
  $('#volRange').value = st.vol; $('#volOut').textContent = st.vol;
  $('#colBg').value = st.colBg; $('#colBeat').value = st.colBeat; $('#colAccent').value = st.colAccent;
  $('#flashOnlyAccent').checked = st.flashOnlyAccent;
  $('#flashLen').value = st.flashLen; $('#flashLenOut').textContent = st.flashLen + '%';
  $('#restartOnSwitch').checked = st.restartOnSwitch;
  $('#keepAwake').checked = st.keepAwake;
  $('#tapToToggle').checked = st.tapToToggle;
  $('#scrollSpeed').value = st.scrollSpeed; $('#scrollOut').textContent = st.scrollSpeed;
  $('#scrollToggle').classList.toggle('on', st.autoScroll);
  document.documentElement.style.setProperty('--split', st.split + '%');
  $('#stage').classList.toggle('swapped', !st.pdfFirst);
  if (!eng.running) paint(st.colBg);
  const p = st.presets[st.activePreset];
  $('#presetName').textContent = p && p.bpm ? p.name : '';
}

function segSet(sel, attr, val) {
  $$(sel + ' button').forEach(b => b.classList.toggle('on', +b.dataset[attr] === val));
}

function setBpm(v, fromUser) {
  st.bpm = clamp(Math.round(v), 20, 300);
  if (fromUser) { st.activePreset = -1; renderPresets(); }
  refresh(); save();
}

function setBeats(n) {
  st.beats = clamp(n, 1, 16);
  fixAccents();
  if (eng.beat >= st.beats) eng.beat = 0;
  buildDots(); buildAccentEditor(); refresh(); save();
}

function buildAccentEditor() {
  const box = $('#accentEdit');
  box.textContent = '';
  for (let i = 0; i < st.beats; i++) {
    const b = document.createElement('button');
    const v = st.accents[i] | 0;
    b.dataset.v = v;
    b.textContent = v === 2 ? '強' : v === 1 ? '弱' : '–';
    b.addEventListener('click', () => {
      st.accents[i] = (st.accents[i] + 2) % 3; // 2->1->0->2
      buildAccentEditor(); buildDots(); save();
    });
    box.appendChild(b);
  }
}

/* ---- presets ---- */

function renderPresets() {
  const box = $('#presets');
  box.textContent = '';
  st.presets.forEach((p, i) => {
    const b = document.createElement('button');
    if (!p.bpm) {
      b.className = 'empty';
      b.innerHTML = '<b>+</b><span>空き</span>';
    } else {
      b.innerHTML = '<b>' + p.bpm + '</b><span>' + (p.name || (p.beats + '/' + (p.unit === 12 ? '4.' : p.unit))) + '</span>';
      if (i === st.activePreset) b.classList.add('active');
    }
    let timer = 0, longPressed = false;
    const down = () => { longPressed = false; timer = setTimeout(() => { longPressed = true; openEditor(i); }, 500); };
    const up = () => { clearTimeout(timer); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    b.addEventListener('click', () => {
      if (longPressed) return;
      if (!p.bpm) { openEditor(i); return; }
      applyPreset(i);
    });
    box.appendChild(b);
  });
}

function applyPreset(i) {
  const p = st.presets[i];
  if (!p || !p.bpm) return;
  st.bpm = p.bpm; st.beats = clamp(p.beats || 4, 1, 16); st.unit = p.unit || 4;
  if (Array.isArray(p.accents) && p.accents.length === st.beats) st.accents = p.accents.slice();
  else fixAccents();
  st.activePreset = i;
  buildDots(); buildAccentEditor(); renderPresets(); refresh(); save();
  if (eng.running && st.restartOnSwitch) {
    eng.beat = 0; eng.sub = 0;
    eng.queue.length = 0;
    eng.nextTime = eng.ctx.currentTime + 0.05;
    scheduler();
  }
}

let editIdx = -1;
function openEditor(i) {
  editIdx = i;
  const p = st.presets[i];
  $('#edTitle').textContent = 'プリセット ' + (i + 1);
  $('#edName').value = p.name || '';
  $('#edBpm').value = p.bpm || st.bpm;
  $('#edBeats').value = p.beats || st.beats;
  segSet('#edUnitSeg', 'unit', p.unit || st.unit);
  $('#editor').hidden = false;
}
function closeEditor() { $('#editor').hidden = true; editIdx = -1; }

$('#edUnitSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  segSet('#edUnitSeg', 'unit', +b.dataset.unit);
});
$('#edFromNow').addEventListener('click', () => {
  $('#edBpm').value = st.bpm;
  $('#edBeats').value = st.beats;
  segSet('#edUnitSeg', 'unit', st.unit);
});
$('#edClear').addEventListener('click', () => {
  if (editIdx < 0) return;
  st.presets[editIdx] = { name: '', bpm: 0, beats: 4, unit: 4 };
  if (st.activePreset === editIdx) st.activePreset = -1;
  renderPresets(); refresh(); save(); closeEditor();
});
$('#edCancel').addEventListener('click', closeEditor);
$('#edSave').addEventListener('click', () => {
  if (editIdx < 0) return;
  const on = $('#edUnitSeg button.on');
  const beats = clamp(parseInt($('#edBeats').value, 10) || 4, 1, 16);
  const acc = []; for (let i = 0; i < beats; i++) acc.push(i === 0 ? 2 : 1);
  st.presets[editIdx] = {
    name: $('#edName').value.trim(),
    bpm: clamp(parseInt($('#edBpm').value, 10) || 120, 20, 300),
    beats: beats,
    unit: on ? +on.dataset.unit : 4,
    accents: acc
  };
  renderPresets(); save(); closeEditor();
});

/* ---- transport ---- */

$('#playBtn').addEventListener('click', toggle);
$('#bpmDown').addEventListener('click', () => setBpm(st.bpm - 1, true));
$('#bpmUp').addEventListener('click', () => setBpm(st.bpm + 1, true));

let holdTimer = 0, holdRepeat = 0;
function holdable(el, fn) {
  el.addEventListener('pointerdown', () => {
    holdTimer = setTimeout(() => { holdRepeat = setInterval(fn, 70); }, 450);
  });
  const end = () => { clearTimeout(holdTimer); clearInterval(holdRepeat); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
}
holdable($('#bpmDown'), () => setBpm(st.bpm - 1, true));
holdable($('#bpmUp'), () => setBpm(st.bpm + 1, true));

let taps = [];
$('#tapBtn').addEventListener('click', () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2200) taps = [];
  taps.push(now);
  if (taps.length > 6) taps.shift();
  if (taps.length >= 2) {
    const span = taps[taps.length - 1] - taps[0];
    setBpm(60000 / (span / (taps.length - 1)), true);
  }
  const b = $('#tapBtn');
  b.classList.add('hit');
  setTimeout(() => b.classList.remove('hit'), 90);
});

flashPane.addEventListener('click', () => { if (st.tapToToggle) toggle(); });

/* ---- settings sheet ---- */

function openSheet() { $('#sheet').hidden = false; $('#scrim').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; }
$('#openSettings').addEventListener('click', openSheet);
$('#closeSettings').addEventListener('click', closeSheet);
$('#scrim').addEventListener('click', closeSheet);

$('#bpmRange').addEventListener('input', e => setBpm(+e.target.value, true));
$('#beatsDown').addEventListener('click', () => setBeats(st.beats - 1));
$('#beatsUp').addEventListener('click', () => setBeats(st.beats + 1));
$('#unitSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  st.unit = +b.dataset.unit; refresh(); save();
});
$('#divSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  st.div = +b.dataset.div; refresh(); save();
});
$('#soundOn').addEventListener('change', e => {
  st.soundOn = e.target.checked;
  if (eng.master) eng.master.gain.value = st.soundOn ? st.vol / 100 : 0;
  save();
});
$('#volRange').addEventListener('input', e => {
  st.vol = +e.target.value;
  $('#volOut').textContent = st.vol;
  if (eng.master) eng.master.gain.value = st.soundOn ? st.vol / 100 : 0;
  save();
});
['colBg', 'colBeat', 'colAccent'].forEach(id => {
  $('#' + id).addEventListener('input', e => { st[id] = e.target.value; if (!eng.running) { eng.lastColor = ''; paint(st.colBg); } save(); });
});
$('#flashOnlyAccent').addEventListener('change', e => { st.flashOnlyAccent = e.target.checked; save(); });
$('#flashLen').addEventListener('input', e => { st.flashLen = +e.target.value; $('#flashLenOut').textContent = st.flashLen + '%'; save(); });
$('#restartOnSwitch').addEventListener('change', e => { st.restartOnSwitch = e.target.checked; save(); });
$('#keepAwake').addEventListener('change', e => { st.keepAwake = e.target.checked; st.keepAwake ? requestWake() : releaseWake(); save(); });
$('#tapToToggle').addEventListener('change', e => { st.tapToToggle = e.target.checked; save(); });
$('#scrollSpeed').addEventListener('input', e => {
  st.scrollSpeed = +e.target.value;
  $('#scrollOut').textContent = st.scrollSpeed;
  st.autoScroll = st.scrollSpeed > 0;
  $('#scrollToggle').classList.toggle('on', st.autoScroll);
  save();
});
$('#scrollToggle').addEventListener('click', () => {
  st.autoScroll = !st.autoScroll;
  if (st.autoScroll && st.scrollSpeed === 0) { st.scrollSpeed = 20; $('#scrollSpeed').value = 20; $('#scrollOut').textContent = 20; }
  $('#scrollToggle').classList.toggle('on', st.autoScroll);
  save();
});
$('#pdfSwap').addEventListener('click', () => { st.pdfFirst = !st.pdfFirst; refresh(); save(); });
$('#resetAll').addEventListener('click', () => {
  if (!confirm('設定・プリセット・譜面をすべて消して初期化します。よろしいですか？')) return;
  localStorage.removeItem(KEY);
  idbDel().finally(() => location.reload());
});
$('#ver').textContent = 'v' + VERSION;

/* ---- divider drag ---- */

const divider = $('#divider');
divider.addEventListener('pointerdown', e => {
  divider.setPointerCapture(e.pointerId);
  const stage = $('#stage');
  const move = ev => {
    const r = stage.getBoundingClientRect();
    const land = r.width > r.height;
    let size;
    if (land) size = st.pdfFirst ? ev.clientX - r.left : r.right - ev.clientX;
    else size = st.pdfFirst ? ev.clientY - r.top : r.bottom - ev.clientY;
    const ratio = clamp(size / (land ? r.width : r.height) * 100, 15, 85);
    st.split = Math.round(ratio);
    document.documentElement.style.setProperty('--split', st.split + '%');
  };
  const up = () => {
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
    save(); relayoutPdf();
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
});

/* ============================ PDF ============================ */

const pdfScroll = $('#pdfScroll');
const pdfDocEl = $('#pdfDoc');
let pdfLib = null, pdfDoc = null, pages = [], pageObs = null, curPage = 1;

/* --- IndexedDB（譜面をアプリ内に残す） --- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('lm-pdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('f');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbPut(name, buf) {
  return idbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction('f', 'readwrite');
    tx.objectStore('f').put({ name: name, buf: buf }, 'pdf');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  }));
}
function idbGet() {
  return idbOpen().then(db => new Promise((res, rej) => {
    const rq = db.transaction('f', 'readonly').objectStore('f').get('pdf');
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  })).catch(() => null);
}
function idbDel() {
  return idbOpen().then(db => new Promise(res => {
    const tx = db.transaction('f', 'readwrite');
    tx.objectStore('f').delete('pdf');
    tx.oncomplete = res; tx.onerror = res;
  })).catch(() => {});
}

async function loadLib() {
  if (pdfLib) return pdfLib;
  const m = await import('./vendor/pdf.js');
  m.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.js';
  pdfLib = m;
  return m;
}

async function openPdf(buf, name) {
  let lib;
  try { lib = await loadLib(); }
  catch (e) {
    $('#pdfNote').textContent = 'PDF表示ライブラリ (vendor/pdf.js) が見つかりません。README の手順で配置してください。';
    return;
  }
  try {
    // pdf.js は渡した ArrayBuffer を消費するのでコピーを渡す
    pdfDoc = await lib.getDocument({ data: buf.slice(0) }).promise;
  } catch (e) {
    $('#pdfNote').textContent = 'このPDFを開けませんでした。';
    return;
  }
  document.body.classList.add('hasPdf');
  $('#pdfPane').hidden = false;
  divider.hidden = false;
  $('#pdfNote').textContent = (name || '譜面') + '（' + pdfDoc.numPages + 'ページ）';
  await buildPages();
}

async function buildPages() {
  if (pageObs) pageObs.disconnect();
  pdfDocEl.textContent = '';
  pages = [];
  const width = Math.max(120, pdfScroll.clientWidth);
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const div = document.createElement('div');
    div.className = 'pg';
    div.style.height = Math.round(width * vp.height / vp.width) + 'px';
    div.dataset.n = i;
    pdfDocEl.appendChild(div);
    pages.push({ n: i, el: div, page: page, ratio: vp.height / vp.width, rendered: 0, busy: false });
  }
  // 表示中と前後1ページだけ実際に描く（全ページ展開はメモリを食って落ちる）
  pageObs = new IntersectionObserver(ents => {
    ents.forEach(en => {
      const p = pages[+en.target.dataset.n - 1];
      if (!p) return;
      if (en.isIntersecting) renderPage(p);
      else unrenderPage(p);
    });
  }, { root: pdfScroll, rootMargin: '150% 0px' });
  pages.forEach(p => pageObs.observe(p.el));
  updatePageLabel();
  kickRender();   // IntersectionObserver の初回発火を待たずに先頭を描く
}

/* いま画面に近いページを座標で拾って描く（Observer が発火しない状況の保険） */
function kickRender() {
  const s = pdfScroll.getBoundingClientRect();
  pages.forEach(p => {
    const r = p.el.getBoundingClientRect();
    if (r.bottom > s.top - s.height && r.top < s.bottom + s.height) renderPage(p);
  });
}

async function renderPage(p) {
  const width = Math.max(120, pdfScroll.clientWidth);
  if (p.busy || p.rendered === width) return;
  p.busy = true;
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp0 = p.page.getViewport({ scale: 1 });
    const scale = width * dpr / vp0.width;
    const vp = p.page.getViewport({ scale: scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const task = p.page.render({ canvasContext: cv.getContext('2d', { alpha: false }), viewport: vp });
    p.task = task;
    await task.promise;
    p.el.textContent = '';
    p.el.style.height = '';
    p.el.appendChild(cv);
    p.rendered = width;
  } catch (e) { /* 描画中断は無視 */ }
  p.busy = false;
}

function unrenderPage(p) {
  if (!p.rendered) return;
  const h = p.el.offsetHeight;
  if (p.task) { try { p.task.cancel(); } catch (e) {} }
  p.el.textContent = '';
  p.el.style.height = h + 'px';
  p.rendered = 0;
}

let relayoutTimer = 0;
function relayoutPdf() {
  if (!pdfDoc) return;
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    const width = Math.max(120, pdfScroll.clientWidth);
    pages.forEach(p => {
      if (p.rendered && p.rendered !== width) { unrenderPage(p); p.el.style.height = Math.round(width * p.ratio) + 'px'; }
      else if (!p.rendered) p.el.style.height = Math.round(width * p.ratio) + 'px';
    });
    kickRender();
  }, 160);
}
window.addEventListener('resize', relayoutPdf);
window.addEventListener('orientationchange', relayoutPdf);

let labelPending = false;
pdfScroll.addEventListener('scroll', () => {
  if (labelPending) return;
  labelPending = true;
  requestAnimationFrame(() => { labelPending = false; updatePageLabel(); });
}, { passive: true });

function updatePageLabel() {
  if (!pages.length) { $('#pgLabel').textContent = '–'; return; }
  const top = pdfScroll.scrollTop + 8;
  let n = 1;
  for (let i = 0; i < pages.length; i++) { if (pages[i].el.offsetTop <= top) n = i + 1; else break; }
  curPage = n;
  $('#pgLabel').textContent = n + ' / ' + pages.length;
}

$('#pgPrev').addEventListener('click', () => gotoPage(curPage - 1));
$('#pgNext').addEventListener('click', () => gotoPage(curPage + 1));
function gotoPage(n) {
  n = clamp(n, 1, pages.length);
  if (!pages[n - 1]) return;
  pdfScroll.scrollTo({ top: pages[n - 1].el.offsetTop, behavior: 'smooth' });
}

$('#pdfFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  try { await idbPut(f.name, buf.slice(0)); } catch (err) {}
  await openPdf(buf, f.name);
  e.target.value = '';
  closeSheet();
});

$('#pdfClear').addEventListener('click', async () => {
  if (pageObs) pageObs.disconnect();
  pages = []; pdfDoc = null;
  pdfDocEl.textContent = '';
  document.body.classList.remove('hasPdf');
  $('#pdfPane').hidden = true;
  divider.hidden = true;
  $('#pdfNote').textContent = '';
  await idbDel();
});

/* ============================ boot ============================ */

buildDots();
buildAccentEditor();
renderPresets();
refresh();

idbGet().then(rec => { if (rec && rec.buf) openPdf(rec.buf, rec.name); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 最初のタップで AudioContext を作っておく（iOS の自動再生制限対策）
const unlock = () => { initAudio(); document.removeEventListener('pointerdown', unlock); };
document.addEventListener('pointerdown', unlock);

// ダブルタップ拡大の抑止
document.addEventListener('gesturestart', e => e.preventDefault());
