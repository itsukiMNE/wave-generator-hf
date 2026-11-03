// ================== 音高生成（十二平均律） ==================
const A4 = 440; // 标准音 A4
const PITCH_CLASSES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const PITCH_OCTAVES = [2, 3, 4, 5];

// v0.17：音名与八度拆开选择；可用范围扩展为 C2～B5。
function isPitchInRange(noteName, octave) {
  return PITCH_CLASSES.includes(noteName) && octave >= 2 && octave <= 5;
}

function getCurrentPitchName() {
  return `${pitchNoteSel.value}${pitchOctaveSel.value}`;
}

function getCurrentFrequency() {
  const noteIndex = PITCH_CLASSES.indexOf(pitchNoteSel.value);
  const octave = Number(pitchOctaveSel.value);
  const midi = (octave + 1) * 12 + noteIndex;
  return A4 * Math.pow(2, (midi - 69) / 12);
}

function updatePitchDisplay() {
  const octave = Number(pitchOctaveSel.value);

  [...pitchNoteSel.options].forEach(option => {
    option.disabled = !isPitchInRange(option.value, octave);
  });

  if (!isPitchInRange(pitchNoteSel.value, octave)) {
    pitchNoteSel.value = 'D';
  }

  pitchFrequency.textContent = `${getCurrentFrequency().toFixed(2)} Hz`;
}

// ================== 固定音频参数 ==================
const AMPLITUDE = 0.1;      // 音量
const PLAY_DURATION = 2.6;  // 播放时长
const WAV_SILENCE = 0.4;    // 前后静音
const SAMPLE_RATE = 44100;  // 采样率

// ================== DOM 获取（公开版） ==================
const waveCanvas = document.getElementById('waveCanvas');
const waveCtx = waveCanvas.getContext('2d');
const waveSel = document.getElementById('waveform');
const pitchNoteSel = document.getElementById('pitchNote');
const pitchOctaveSel = document.getElementById('pitchOctave');
const pitchFrequency = document.getElementById('pitchFrequency');
const noiseAmount = document.getElementById('noiseAmount');
const noiseValue = document.getElementById('noiseValue');
const periodVariation = document.getElementById('periodVariation');
const periodVariationValue = document.getElementById('periodVariationValue');
const amplitudeVariation = document.getElementById('amplitudeVariation');
const amplitudeVariationValue = document.getElementById('amplitudeVariationValue');
const regenerateVariationBtn = document.getElementById('regenerateVariationBtn');
const languageSelect = document.getElementById('languageSelect');
const WAVE_NAMES_FILE = {sine: 'Sine', square: 'Square', triangle: 'Triangle', sawtooth: 'Sawtooth'};
let audioContext, audioSource;
let variationSeed = 260805;

function resizeCanvas() {
  waveCanvas.width = waveCanvas.offsetWidth;
  waveCanvas.height = waveCanvas.offsetHeight;
}

// ================== Noise / 伪周期波动 ==================
// UI 中的 Noise 百分比表示白噪声相对于基础波形振幅的比例。
function getNoiseAmount() {
  return parseFloat(noiseAmount.value) / 100;
}

function getPeriodVariationAmount() {
  return parseFloat(periodVariation.value) / 100;
}

function getAmplitudeVariationAmount() {
  return parseFloat(amplitudeVariation.value) / 100;
}

// 新增：可复现的伪随机数。相同 seed + index 会得到相同结果，
// 因此主预览、试听和 WAV 导出能使用完全一致的随机序列。
function seededRandom(seed, index) {
  let x = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967295;
}

function randomSigned(seed, index) {
  return seededRandom(seed, index) * 2 - 1;
}

// ================== 四种标准波形（公开版） ==================
function getWaveValueByPhase(type, phase) {
  switch (type) {
    case 'sine': return Math.sin(2 * Math.PI * phase);
    case 'square': return Math.sign(Math.sin(2 * Math.PI * phase));
    case 'triangle': return phase <= 0.5 ? -1 + 4 * phase : 3 - 4 * phase;
    case 'sawtooth': return (2 / Math.PI) * Math.atan(Math.tan(Math.PI * phase));
  }
  return 0;
}

function synthesizeSamples(duration, sampleRate = SAMPLE_RATE, options = {}) {
  const type = waveSel.value;
  const baseFreq = getCurrentFrequency();
  // Noise 作为最后一级处理；原始波形试听可以显式关闭。
  const useNoise = options.useNoise !== false;
  const noiseLevel = useNoise ? getNoiseAmount() : 0;
  // 自定义编辑区试听可关闭周期/振幅波动，用来听原始自定义波形。
  const useVariation = options.useVariation !== false;
  const periodAmount = useVariation ? getPeriodVariationAmount() : 0;
  const amplitudeAmount = useVariation ? getAmplitudeVariationAmount() : 0;
  const len = Math.max(1, Math.floor(duration * sampleRate));
  const data = new Float32Array(len);

  let phase = 0;
  let cycleIndex = 0;

  // 每个周期固定一个目标周期长度和振幅，避免每个 sample 都随机抖动。
  let periodOffset = randomSigned(variationSeed + 101, cycleIndex) * periodAmount;
  let amplitudeFactor = 1 + randomSigned(variationSeed + 211, cycleIndex) * amplitudeAmount;

  for (let i = 0; i < len; i++) {
    const v = getWaveValueByPhase(type, phase) * amplitudeFactor;
    const noise = randomSigned(variationSeed + 307, i) * noiseLevel;
    data[i] = Math.max(-1, Math.min(1, v + noise));

    // periodOffset 表示本周期相对基础周期长度 T 的偏移。
    // T' = T * (1 + offset)，因此相位增量需要除以 (1 + offset)。
    phase += (baseFreq / sampleRate) / Math.max(0.01, 1 + periodOffset);

    if (phase >= 1) {
      phase -= 1;
      cycleIndex++;
      periodOffset = randomSigned(variationSeed + 101, cycleIndex) * periodAmount;
      amplitudeFactor = 1 + randomSigned(variationSeed + 211, cycleIndex) * amplitudeAmount;
    }
  }

  return data;
}

// ================== 绘制主波形 ==================
function drawWave() {
  const w = waveCanvas.width, h = waveCanvas.height;
  waveCtx.clearRect(0,0,w,h);

  // 主波形中央参考线：只用于视觉辅助，不影响声音生成
  waveCtx.strokeStyle = 'rgba(120, 120, 120, 0.22)';
  waveCtx.lineWidth = 1;
  waveCtx.beginPath();
  waveCtx.moveTo(0, h/2);
  waveCtx.lineTo(w, h/2);
  waveCtx.stroke();

  // 预览前 10ms，和试听 / WAV 使用同一随机种子。
  const preview = synthesizeSamples(0.01, SAMPLE_RATE);

  waveCtx.beginPath();
  waveCtx.strokeStyle = '#2878d0';
  waveCtx.lineWidth = 2;

  for (let i = 0; i < preview.length; i++) {
    const x = preview.length === 1 ? 0 : i * w / (preview.length - 1);
    const y = h/2 - preview[i] * (h/2 - 10);
    i === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
  }

  waveCtx.stroke();
}

// ================== 播放（Web Audio API） ==================
function play() {
  stop();

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const samples = synthesizeSamples(PLAY_DURATION, SAMPLE_RATE);
  const buffer = audioContext.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.copyToChannel(samples, 0);

  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  source.buffer = buffer;
  gain.gain.value = AMPLITUDE;
  source.connect(gain);
  gain.connect(audioContext.destination);
  source.start();

  source.onended = () => {
    if (audioSource === source) audioSource = null;
  };
  audioSource = source;
}

// 停止播放
function stop() {
  if (audioSource) {
    try { audioSource.stop(); } catch {}
    try { audioSource.disconnect(); } catch {}
  }
  audioSource = null;

  if (audioContext) {
    try { audioContext.close(); } catch {}
    audioContext = null;
  }
}

// ================== 导出 WAV 文件 ==================
function saveWav() {
  const type = waveSel.value;
  const total = WAV_SILENCE + PLAY_DURATION + WAV_SILENCE;
  const len = Math.floor(SAMPLE_RATE * total);
  const data = new Float32Array(len);
  const sound = synthesizeSamples(PLAY_DURATION, SAMPLE_RATE);
  const start = Math.floor(WAV_SILENCE * SAMPLE_RATE);

  // 前后静音保持原逻辑；中间声音直接使用与试听完全相同的 PCM。
  for (let i = 0; i < sound.length && start + i < data.length; i++) {
    data[start + i] = sound[i] * AMPLITUDE;
  }

  // WAV 文件头（44字节）
  const buffer = new ArrayBuffer(44 + len*2);
  const view = new DataView(buffer);

  const writeStr = (o, s) =>
    s.split('').forEach((c,i) =>
      view.setUint8(o+i, c.charCodeAt(0))
    );

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len*2, true);

  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);

  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道

  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);

  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeStr(36, 'data');
  view.setUint32(40, len*2, true);

  // 写入音频数据
  let p = 44;
  data.forEach(sample => {
    view.setInt16(p, Math.max(-1, Math.min(1, sample)) * 32767, true);
    p += 2;
  });

  // 下载文件：固定使用英文首字母大写，不受网页语言影响
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([view], {type:'audio/wav'}));

  const wname = WAVE_NAMES_FILE[type];
  const note = getCurrentPitchName();
  a.download = `${wname}_${note}_.wav`;
  a.click();
}



// ================== 简体中文 / 日本語 / English ==================
const TRANSLATIONS = {
  zh: {title:'波形生成器',subtitle:'生成周期波形并导出 WAV',language:'语言',waveform:'波形',pitch:'音高',sine:'正弦波',square:'方波',triangle:'三角波',sawtooth:'锯齿波',variation:'波动',periodVariation:'周期波动',amplitudeVariation:'振幅波动',regenerate:'重新生成随机变化',preview:'最终波形预览',play:'播放',stop:'停止',export:'导出 WAV'},
  ja: {title:'波形ジェネレーター',subtitle:'周期波形を生成して WAV 形式で書き出します',language:'言語',waveform:'波形',pitch:'音高',sine:'サイン波',square:'矩形波',triangle:'三角波',sawtooth:'ノコギリ波',variation:'ゆらぎ',periodVariation:'周期のゆらぎ',amplitudeVariation:'振幅のゆらぎ',regenerate:'ランダム変化を再生成',preview:'最終波形プレビュー',play:'再生',stop:'停止',export:'WAV を書き出す'},
  en: {title:'Wave Generator',subtitle:'Generate periodic waveforms and export WAV files',language:'Language',waveform:'Waveform',pitch:'Pitch',sine:'Sine',square:'Square',triangle:'Triangle',sawtooth:'Sawtooth',variation:'Variation',periodVariation:'Period variation',amplitudeVariation:'Amplitude variation',regenerate:'Regenerate random variation',preview:'Final waveform preview',play:'Play',stop:'Stop',export:'Export WAV'}
};
function setLanguage(lang) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.zh;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.querySelectorAll('[data-i18n]').forEach(node => {
    const translated = dict[node.dataset.i18n];
    if (translated !== undefined) node.textContent = translated;
  });
}
languageSelect.addEventListener('change', () => setLanguage(languageSelect.value));

// 按钮绑定
document.getElementById('playBtn').addEventListener('click', play);
document.getElementById('stopBtn').addEventListener('click', stop);
document.getElementById('saveBtn').addEventListener('click', saveWav);

noiseAmount.addEventListener('input', () => {
  noiseValue.textContent = `${noiseAmount.value}%`;
  drawWave();
});

periodVariation.addEventListener('input', () => {
  periodVariationValue.textContent = `${periodVariation.value}%`;
  drawWave();
});

amplitudeVariation.addEventListener('input', () => {
  amplitudeVariationValue.textContent = `${amplitudeVariation.value}%`;
  drawWave();
});

regenerateVariationBtn.addEventListener('click', () => {
  // 只更换随机种子，不改变用户设置。
  variationSeed = (variationSeed + 1) >>> 0;
  drawWave();
});

pitchNoteSel.addEventListener('change', () => {
  updatePitchDisplay();
  drawWave();
});

pitchOctaveSel.addEventListener('change', () => {
  updatePitchDisplay();
  drawWave();
});

// 窗口变化时重绘
window.addEventListener('resize', () => {
  resizeCanvas();
  drawWave();
});

// 初始化音高选项，保持 v0.18 的 D4 与 Sawtooth 默认值。
PITCH_CLASSES.forEach(noteName => {
  const opt = document.createElement('option');
  opt.value = noteName;
  opt.textContent = noteName;
  pitchNoteSel.appendChild(opt);
});
PITCH_OCTAVES.forEach(octave => {
  const opt = document.createElement('option');
  opt.value = String(octave);
  opt.textContent = String(octave);
  pitchOctaveSel.appendChild(opt);
});
pitchNoteSel.value = 'D';
pitchOctaveSel.value = '4';
waveSel.value = 'sawtooth';
updatePitchDisplay();
setLanguage('zh');
resizeCanvas();
drawWave();
