/**
 * Icebox-ESP32 · MQTT Dashboard
 * Listens to EMQX Cloud broker and visualizes live telemetry.
 */

// ==================== Configuration ====================
const CONFIG = {
  brokerUrl: 'wss://z181062f.ala.us-east-1.emqxsl.com:8084/mqtt',
  username: 'zaf',
  password: 'zaf',
  topic: 'testtopic/polinilai/data',
  keepalive: 60,
  connectTimeout: 10000,
  reconnectPeriod: 3000,
  connectAttempts: 0,
  maxReconnectAttempts: 20
};

// ==================== State ====================
let mqttClient = null;
let messageCount = 0;
let connected = false;

// History for the chart (bounded)
const MAX_POINTS = 60;
let voltageHistory = [];
let temperatureHistory = [];
let timeHistory = [];

// ==================== Persistence ====================
const STORAGE_KEY = 'icebox-dashboard-data';
let logEntries = [];

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      voltageHistory,
      temperatureHistory,
      timeHistory,
      logEntries
    }));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.voltageHistory)) voltageHistory = saved.voltageHistory;
    if (Array.isArray(saved.temperatureHistory)) temperatureHistory = saved.temperatureHistory;
    if (Array.isArray(saved.timeHistory)) timeHistory = saved.timeHistory;
    if (Array.isArray(saved.logEntries)) logEntries = saved.logEntries;
  } catch (e) {
    console.error('Failed to load state:', e);
  }
}

function renderLogEntries() {
  els.messageLog.innerHTML = '';
  if (logEntries.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'log-empty';
    placeholder.textContent = 'No messages yet.';
    els.messageLog.appendChild(placeholder);
    return;
  }
  logEntries.forEach((entry) => {
    const el = document.createElement('div');
    el.className = 'log-entry';

    const t = document.createElement('span');
    t.className = 'log-time';
    t.textContent = entry.time;

    const d = document.createElement('span');
    d.className = 'log-device';
    d.textContent = entry.device;

    const txt = document.createElement('span');
    txt.className = 'log-data';
    txt.textContent = entry.text;

    el.append(t, d, txt);
    els.messageLog.appendChild(el);
  });
  els.messageLog.scrollTop = els.messageLog.scrollHeight;
}

// ==================== DOM References ====================
const $ = (id) => document.getElementById(id);
const els = {
  statusBadge: $('connection-status'),
  statusText: $('status-text'),
  connectBtn: $('connect-btn'),
  clientId: $('client-id'),
  msgCount: $('msg-count'),
  voltageValue: $('voltage-value'),
  voltageTrend: $('voltage-trend'),
  temperatureValue: $('temperature-value'),
  temperatureTrend: $('temperature-trend'),
  deviceValue: $('device-value'),
  lastUpdate: $('last-update'),
  updateTrend: $('update-trend'),
  canvas: $('history-chart'),
  messageLog: $('message-log'),
  clearLogBtn: $('clear-log-btn'),
  gaugeNeedle: document.querySelector('#needle'),
  tempNeedle: document.querySelector('#temp-needle')
};

// ==================== Temperature Bar ====================
// Bar range: 0°C (left) → 15°C (right)
const TEMP_MIN = 0;
const TEMP_MAX = 15;

function tempZone(t) {
  if (t < 7) return 'success';      // 0-7°C  → green
  if (t < 9) return 'warning';      // 7-9°C  → yellow
  return 'danger';                  // >9°C   → red
}

function updateTempBar(t) {
  if (!els.tempNeedle || !Number.isFinite(t)) return;

  // Clamp to bar range
  const clamped = Math.min(Math.max(t, TEMP_MIN), TEMP_MAX);
  // Bar spans from x=12 (0°C) to x=288 (15°C)
  const x = 12 + ((clamped - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 276;
  // Marker triangle tip is at local (0, 35); translate to the x position
  els.tempNeedle.style.transform = `translateX(${x}px)`;

  // Color the header value by zone
  const zone = tempZone(t);
  const colors = {
    success: getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || '#111111',
    warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim() || '#777777',
    danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#000000'
  };
  const color = colors[zone];

  if (els.temperatureValue) {
    els.temperatureValue.style.color = color;
  }
}

// ==================== Voltage Gauge ====================
// Gauge range: 9V (needle left) → 12.7V (needle right)
const GAUGE_MIN = 9.0;
const GAUGE_MAX = 12.7;

function voltageZone(v) {
  if (v < 10) return 'danger';      // 9-10V  → red
  if (v < 11) return 'warning';     // 10-11V → yellow
  return 'success';                 // >11V   → green
}

function updateGauge(v) {
  if (!els.gaugeNeedle || !Number.isFinite(v)) return;

  // Clamp to gauge range
  const clamped = Math.min(Math.max(v, GAUGE_MIN), GAUGE_MAX);
  // Needle is drawn pointing LEFT (9V = rotate 0°), sweeps clockwise to RIGHT (12.7V = rotate 180°)
  const rotation = ((clamped - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 180;

  els.gaugeNeedle.style.transform = `rotate(${rotation}deg)`;

  // Color the needle tip + value by zone
  const zone = voltageZone(v);
  const colors = {
    danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#000000',
    warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim() || '#777777',
    success: getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || '#111111'
  };
  const color = colors[zone];

  if (els.voltageValue) {
    els.voltageValue.textContent = `= ${v.toFixed(1)}V`;
    els.voltageValue.style.color = color;
  }

  // Tint the gauge card top accent bar
  const gaugeCard = els.gaugeNeedle.closest('.gauge-card');
  if (gaugeCard) {
    gaugeCard.style.setProperty('--gauge-accent', color);
  }
}

// ==================== Connection ====================
function generateClientId() {
  return `web-dashboard-${Math.random().toString(16).substring(2, 10)}`;
}

function setStatus(state, text) {
  els.statusBadge.className = 'status-badge';
  els.statusBadge.classList.add(`status-${state}`);
  els.statusText.textContent = text;

  if (state === 'connected') {
    els.connectBtn.textContent = 'Disconnect';
    els.connectBtn.classList.add('btn-disconnect');
    els.connectBtn.classList.remove('btn-primary');
  } else {
    els.connectBtn.textContent = 'Connect';
    els.connectBtn.classList.remove('btn-disconnect');
    els.connectBtn.classList.add('btn-primary');
  }
}

function connect() {
  const clientId = generateClientId();
  if (els.clientId) els.clientId.textContent = clientId;

  setStatus('connecting', 'Connecting…');
  els.connectBtn.disabled = true;

  mqttClient = mqtt.connect(CONFIG.brokerUrl, {
    clientId,
    username: CONFIG.username,
    password: CONFIG.password,
    keepalive: CONFIG.keepalive,
    connectTimeout: CONFIG.connectTimeout,
    reconnectPeriod: CONFIG.reconnectPeriod,
    clean: true,
    protocolVersion: 4
  });

  mqttClient.on('connect', () => {
    connected = true;
    CONFIG.connectAttempts = 0;
    setStatus('connected', 'Connected');
    els.connectBtn.disabled = false;

    mqttClient.subscribe(CONFIG.topic, { qos: 1 }, (err) => {
      if (err) {
        console.error('Subscribe error:', err);
        addLogEntry('—', 'Subscribe error: ' + err.message);
      } else {
        console.log(`Subscribed to ${CONFIG.topic}`);
      }
    });
  });

  mqttClient.on('message', (topic, payload) => {
    handleMessage(topic, payload);
  });

  mqttClient.on('reconnect', () => {
    CONFIG.connectAttempts++;
    setStatus('connecting', 'Reconnecting…');
    els.connectBtn.disabled = true;
  });

  mqttClient.on('close', () => {
    connected = false;
    setStatus('disconnected', 'Disconnected');
    els.connectBtn.disabled = false;
  });

  mqttClient.on('offline', () => {
    connected = false;
    setStatus('disconnected', 'Offline');
    els.connectBtn.disabled = false;
  });

  mqttClient.on('error', (err) => {
    console.error('MQTT error:', err);
    if (CONFIG.connectAttempts >= CONFIG.maxReconnectAttempts) {
      setStatus('disconnected', 'Connection failed');
      els.connectBtn.disabled = false;
      addLogEntry('—', `Error: ${err.message}`);
      mqttClient.end(true);
      mqttClient = null;
    }
  });
}

function disconnect() {
  if (mqttClient) {
    mqttClient.end(true, () => {
      mqttClient = null;
      connected = false;
      setStatus('disconnected', 'Disconnected');
    });
  }
}

// ==================== Message Handling ====================
function handleMessage(topic, payload) {
  let raw = payload.toString();
  messageCount++;
  if (els.msgCount) els.msgCount.textContent = messageCount;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    try {
      // Try custom JSON extraction fallback
      data = parseCustomPayload(raw);
    } catch (e2) {
      console.error('Unable to parse payload:', raw);
      addLogEntry('—', `Unparseable payload: ${raw}`);
      return;
    }
  }

  // ---- Update metric cards ----
  const now = new Date();
  const localTime = now.toLocaleTimeString();

  // Voltage
  if (typeof data.voltage !== 'undefined') {
    const v = Number(data.voltage);
    if (!Number.isFinite(v)) {
      els.voltageValue.textContent = '= --';
    } else {
      updateGauge(v);
    }
    if (voltageHistory.length > 0) {
      const prev = voltageHistory[voltageHistory.length - 1];
      if (v > prev) {
        els.voltageTrend.className = 'metric-trend up';
      } else if (v < prev) {
        els.voltageTrend.className = 'metric-trend down';
      } else {
        els.voltageTrend.className = 'metric-trend';
      }
    } else {
      els.voltageTrend.className = 'metric-trend';
    }
    voltageHistory.push(v);
    if (voltageHistory.length > MAX_POINTS) voltageHistory.shift();
  }

  // Temperature
  if (typeof data.temperature !== 'undefined') {
    const t = Number(data.temperature);
    if (els.temperatureValue) {
      els.temperatureValue.textContent = Number.isFinite(t) ? `= ${t.toFixed(0)}°C` : '= --';
    }
    if (Number.isFinite(t)) {
      updateTempBar(t);
    }
    if (temperatureHistory.length > 0) {
      const prev = temperatureHistory[temperatureHistory.length - 1];
      if (t > prev) {
        els.temperatureTrend.textContent = `▲ ${(t - prev).toFixed(1)}°C since last`;
        els.temperatureTrend.className = 'metric-trend down';
      } else if (t < prev) {
        els.temperatureTrend.textContent = `▼ ${(prev - t).toFixed(1)}°C since last`;
        els.temperatureTrend.className = 'metric-trend up';
      } else {
        els.temperatureTrend.textContent = '';
        els.temperatureTrend.className = 'metric-trend';
      }
    } else {
      els.temperatureTrend.textContent = '';
      els.temperatureTrend.className = 'metric-trend';
    }
    temperatureHistory.push(t);
    if (temperatureHistory.length > MAX_POINTS) temperatureHistory.shift();
  }

  // Device
  if (typeof data.device !== 'undefined') {
    els.deviceValue.textContent = data.device;
  }

  // Timestamp
  if (typeof data.timestamp !== 'undefined') {
    const ts = Number(data.timestamp);
    els.lastUpdate.textContent = `uptime ${formatUptime(ts)}`;
    els.updateTrend.textContent = `Received ${localTime}`;
    timeHistory.push(`t+${ts}`);
  } else {
    els.updateTrend.textContent = `Received ${localTime}`;
  }
  if (timeHistory.length > MAX_POINTS) timeHistory.shift();

  // ---- Log entry ----
  const device = data.device || 'Unknown';
  const summary = Object.entries(data)
    .filter(([k]) => k === 'temperature' || k === 'voltage')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  addLogEntry(device, summary || raw);
  recordLogEntry(device, summary || raw);

  // ---- Save state & redraw chart ----
  saveState();
  drawChart();
}

function addLogEntry(device, text) {
  // Remove empty placeholder
  const empty = els.messageLog.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });

  const dev = document.createElement('span');
  dev.className = 'log-device';
  dev.textContent = device;

  const data = document.createElement('span');
  data.className = 'log-data';
  data.textContent = text;

  entry.append(time, dev, data);
  els.messageLog.appendChild(entry);

  // Keep max 50 entries
  while (els.messageLog.children.length > 50) {
    els.messageLog.removeChild(els.messageLog.firstChild);
  }

  els.messageLog.scrollTop = els.messageLog.scrollHeight;
}

function recordLogEntry(device, text) {
  logEntries.push({
    time: new Date().toLocaleTimeString([], { hour12: false }),
    date: new Date().toLocaleDateString(),
    device: device || 'Unknown',
    text: text || ''
  });
  while (logEntries.length > 50) logEntries.shift();
  saveState();
}

// ==================== Payload Parsing ====================
function parseCustomPayload(raw) {
  // Handles Arduino-style non-standard JSON if present
  const output = {};
  const keyValPattern = /"([^"]+)"\s*:\s*([^,}]+)/g;
  let match;
  while ((match = keyValPattern.exec(raw)) !== null) {
    let value = match[2].trim();
    if (!isNaN(Number(value))) {
      output[match[1]] = Number(value);
    } else {
      output[match[1]] = value.replace(/"/g, '');
    }
  }
  return output;
}

// ==================== Formatting Helpers ====================
function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ==================== Chart ====================
function drawChart() {
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');

  // Device pixel ratio for crisp rendering
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = rect.width - 36; // padding
  const height = 250;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, width, height);

  const margin = { top: 16, right: 16, bottom: 32, left: 44 };
  const chartW = width - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;

  if (voltageHistory.length === 0) {
    return;
  }

  // Auto-scale Y
  const allVoltage = voltageHistory;
  const allTemp = temperatureHistory;
  const vMin = Math.floor(Math.min(...allVoltage) - 1);
  const vMax = Math.ceil(Math.max(...allVoltage) + 1);

  const tMin = allTemp.length ? Math.floor(Math.min(...allTemp) - 1) : 0;
  const tMax = allTemp.length ? Math.ceil(Math.max(...allTemp) + 1) : 10;

  const points = voltageHistory.length;

  // Grid & Y axis (voltage)
  ctx.strokeStyle = '#d9d9d9';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8a8a8a';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'right';

  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = margin.top + (chartH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();
    const val = vMax - (i * (vMax - vMin)) / gridLines;
    ctx.fillText(val.toFixed(1), margin.left - 8, y + 4);
  }

  // X axis labels
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a8a8a';
  for (let i = 0; i < Math.min(points, 6); i++) {
    const idx = Math.floor((i / 5) * (points - 1));
    const x = margin.left + (idx / Math.max(points - 1, 1)) * chartW;
    const label = timeHistory[idx] || `#${idx + 1}`;
    ctx.fillText(label, x, height - 10);
  }

  // Chart drawing helpers
  function mapY(v, min, max) {
    return margin.top + chartH - ((v - min) / (max - min)) * chartH;
  }
  function mapX(i) {
    if (points === 1) return margin.left + chartW / 2;
    return margin.left + (i / (points - 1)) * chartW;
  }

  // Draw voltage line
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const x = mapX(i);
    const y = mapY(voltageHistory[i], vMin, vMax);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Fill gradient under voltage line
  const grad = ctx.createLinearGradient(0, margin.top, 0, height - margin.bottom);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.18)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.lineTo(mapX(points - 1), height - margin.bottom);
  ctx.lineTo(mapX(0), height - margin.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw temperature line (right scale, only if available)
  if (temperatureHistory.length > 0) {
    ctx.beginPath();
    for (let i = 0; i < temperatureHistory.length; i++) {
      const x = mapX(i);
      const y = mapY(temperatureHistory[i], tMin, tMax);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#777777';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Offsets — draw data points
    ctx.fillStyle = '#000000';
    for (let i = 0; i < points; i++) {
      const x = mapX(i);
      const y = mapY(voltageHistory[i], vMin, vMax);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ==================== Events ====================
els.connectBtn.addEventListener('click', () => {
  if (connected || mqttClient) {
    disconnect();
  } else {
    connect();
  }
});

els.clearLogBtn.addEventListener('click', () => {
  logEntries = [];
  voltageHistory = [];
  temperatureHistory = [];
  timeHistory = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear saved state:', e);
  }
  renderLogEntries();
  drawChart();
});

window.addEventListener('resize', resizeChart);
function resizeChart() {
  if (voltageHistory.length > 0) drawChart();
}

// ==================== Auto-connect on load ====================
window.addEventListener('load', () => {
  // Restore previously saved state
  loadState();
  renderLogEntries();
  drawChart();

  // Small delay to ensure mqtt.js is loaded from CDN
  setTimeout(connect, 300);
});
