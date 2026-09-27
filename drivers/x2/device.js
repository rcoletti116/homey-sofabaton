'use strict';
// SofaBaton X2 — Homey device driver
//
// Three layers:
//   MinimalMqttClient  — bare MQTT 3.1.1 TCP client (no npm dep)
//   SofaBatonClient    — binary A5-5A protocol: UDP handshake, TCP catalog, WiFi-device
//                        creation, mDNS proxy so Homey and the SofaBaton app coexist
//   SofaBatonDevice    — Homey.Device: lifecycle, flow cards, HTTP callback server,
//                        button→Homey-device bindings stored in homey.settings

const Homey = require('homey');
const dgram  = require('dgram');
const net    = require('net');
const http   = require('http');
const os     = require('os');

const SYNC0 = 0xA5;
const SYNC1 = 0x5A;
const HUB_UDP_PORT   = 8102;
const BASE_TCP_PORT  = 8200;
const BASE_HTTP_PORT = 8300; // HTTP callback server for X2 WiFi-device events

const OP = {
  REQ_BANNER:        0x0001,
  REQ_DEVICES:       0x000A,
  REQ_ACTIVITIES:    0x003A,
  REQ_ACTIVATE:      0x023F,
  REQ_BUTTONS:       0x023C,
  REQ_COMMANDS:      0x025C,
  REQ_REMOTE_STATUS: 0x012E,
  FIND_REMOTE_X2:    0x0323,
  ACK_READY:         0x0160,
};

// Physical remote button codes (from HA integration protocol_const.py)
const BUTTON_NAMES = {
  0x97:'C', 0x98:'B', 0x99:'A', 0x9A:'EXIT', 0x9B:'DVR', 0x9C:'PLAY', 0x9D:'GUIDE',
  0xAE:'UP', 0xAF:'LEFT', 0xB0:'OK', 0xB1:'RIGHT', 0xB2:'DOWN',
  0xB3:'BACK', 0xB4:'HOME', 0xB5:'MENU',
  0xB6:'VOL_UP', 0xB7:'CH_UP', 0xB8:'MUTE', 0xB9:'VOL_DOWN', 0xBA:'CH_DOWN',
  0xBB:'REW', 0xBC:'PAUSE', 0xBD:'FWD',
  0xBE:'RED', 0xBF:'GREEN', 0xC0:'YELLOW', 0xC1:'BLUE',
  0xC6:'POWER_ON', 0xC7:'POWER_OFF',
};

// Opcodes whose payload carries command record pages (family low-byte 0x5D).
// The header page (0xD95D) has a 7-byte metadata prefix before record data starts.
const COMMAND_PAGE_OPCODES = new Set([
  0xD95D, // header page — skip first 7 bytes
  0xD55D, 0x4D5D, 0x495D, 0x8F5D,
  0xF75D, 0xA35D, 0x2F5D, 0xF35D, 0x7B5D, 0xCB5D, 0x535D,
]);
const COMMAND_HEADER_OPCODE = 0xD95D;

function checksum(buf) { let s = 0; for (const b of buf) s = (s + b) & 0xff; return s; }

// familyFrame encodes variable-length payloads where the opcode high-byte IS the length.
// Used for WiFi-device creation steps; distinct from frame() which encodes fixed-length ops.
function familyFrame(family, payload) {
  const opcode = ((payload.length & 0xff) << 8) | (family & 0xff);
  const out = Buffer.alloc(5 + payload.length);
  out[0] = SYNC0; out[1] = SYNC1;
  out.writeUInt16BE(opcode, 2);
  payload.copy(out, 4);
  out[out.length - 1] = checksum(out.subarray(0, out.length - 1));
  return out;
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const expected = (opcode >> 8) & 0xff;
  if (expected !== payload.length)
    throw new Error(`SofaBaton opcode 0x${opcode.toString(16)} expects ${expected} bytes, got ${payload.length}`);
  const out = Buffer.alloc(5 + payload.length);
  out[0] = SYNC0; out[1] = SYNC1;
  out.writeUInt16BE(opcode, 2);
  payload.copy(out, 4);
  out[out.length - 1] = checksum(out.subarray(0, out.length - 1));
  return out;
}

function localIPv4(hubIp) {
  const hubParts = (hubIp || '').split('.').map(Number);
  // Prefer interface on the same /24 subnet as the hub
  if (hubParts.length === 4 && hubParts.every(n => !isNaN(n))) {
    for (const list of Object.values(os.networkInterfaces()))
      for (const item of list || [])
        if (item.family === 'IPv4' && !item.internal) {
          const p = item.address.split('.').map(Number);
          if (p[0] === hubParts[0] && p[1] === hubParts[1] && p[2] === hubParts[2])
            return item.address;
        }
  }
  // Fall back to first non-internal IPv4
  for (const list of Object.values(os.networkInterfaces()))
    for (const item of list || [])
      if (item.family === 'IPv4' && !item.internal) return item.address;
  throw new Error('Could not determine Homey local IPv4 address');
}

function utf16be(buf) {
  const even = buf.length - (buf.length % 2);
  const swapped = Buffer.alloc(even);
  for (let i = 0; i < even; i += 2) { swapped[i] = buf[i + 1]; swapped[i + 1] = buf[i]; }
  return swapped.toString('utf16le').replace(/\x00/g, '').trim();
}

function cleanLabel(s) { return String(s || '').replace(/[\x00-\x1f]/g, '').trim(); }

function bestUtf16Label(payload, start = 0, width = 60) {
  if (payload.length < start + 2) return '';
  return cleanLabel(utf16be(payload.subarray(start, Math.min(payload.length, start + width))));
}

function parseFrameStream(buffer) {
  const frames = []; let offset = 0;
  while (buffer.length - offset >= 5) {
    if (buffer[offset] !== SYNC0 || buffer[offset + 1] !== SYNC1) { offset++; continue; }
    const payloadLen = buffer[offset + 2];
    const total = 5 + payloadLen;
    if (buffer.length - offset < total) break;
    const f = buffer.subarray(offset, offset + total);
    if (checksum(f.subarray(0, f.length - 1)) !== f[f.length - 1]) { offset++; continue; }
    frames.push({
      opcode: f.readUInt16BE(2),
      payload: Buffer.from(f.subarray(4, f.length - 1)),
    });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Minimal MQTT 3.1.1 client — dials out to a broker
// ---------------------------------------------------------------------------
class MinimalMqttClient {
  constructor(homey, options, handlers) {
    this.homey = homey;
    this.options = options || {};
    this.handlers = handlers || {};
    this.socket = null;
    this.rx = Buffer.alloc(0);
    this.packetId = 1;
    this.connected = false;
    this._pingTimer = null;
    this._connackResolve = null;
    this._connackReject = null;
  }

  static encString(value) {
    const b = Buffer.from(String(value), 'utf8');
    const o = Buffer.alloc(2 + b.length);
    o.writeUInt16BE(b.length, 0); b.copy(o, 2); return o;
  }

  static encRemainingLength(n) {
    const a = [];
    do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; a.push(d); } while (n > 0);
    return Buffer.from(a);
  }

  static decRemainingLength(buf, offset = 1) {
    let mult = 1, val = 0, i = offset;
    for (; i < buf.length; i++) {
      const b = buf[i]; val += (b & 127) * mult;
      if ((b & 128) === 0) return { value: val, next: i + 1 };
      mult *= 128;
      if (mult > 128 * 128 * 128 * 128) throw new Error('Invalid MQTT remaining length');
    }
    return null;
  }

  async connect() {
    if (this.socket && this.connected) return;

    const host = this.options.host;
    const port = Number(this.options.port) || 1883;
    if (!host) throw new Error('MQTT host not configured');

    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.on('data', c => this.onData(c));
    socket.on('close', () => {
      this.connected = false; this.socket = null;
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    });
    socket.on('error', e => this.homey.error(`MQTT TCP error: ${e.message}`));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('MQTT TCP connect timeout')), 10000);
      socket.once('connect', () => { clearTimeout(t); resolve(); });
      socket.once('error', err => { clearTimeout(t); reject(err); });
    });

    const clientId = `homey-sb-${Math.random().toString(36).slice(2, 8)}`;
    let connectFlags = 0x02;
    const payloadParts = [MinimalMqttClient.encString(clientId)];
    if (this.options.username) {
      connectFlags |= 0x80;
      payloadParts.push(MinimalMqttClient.encString(this.options.username));
      if (this.options.password) {
        connectFlags |= 0x40;
        payloadParts.push(MinimalMqttClient.encString(this.options.password));
      }
    }
    const varHeader = Buffer.concat([
      Buffer.from([0x00, 0x04]), Buffer.from('MQTT'),
      Buffer.from([0x04, connectFlags, 0x00, 0x3C]),
    ]);
    const connectBody = Buffer.concat([varHeader, ...payloadParts]);
    socket.write(Buffer.concat([Buffer.from([0x10]), MinimalMqttClient.encRemainingLength(connectBody.length), connectBody]));

    await new Promise((resolve, reject) => {
      this._connackResolve = resolve; this._connackReject = reject;
      setTimeout(() => reject(new Error('MQTT CONNACK timeout')), 10000);
    });

    this.connected = true;
    this._pingTimer = setInterval(() => { if (this.socket) this.socket.write(Buffer.from([0xC0, 0x00])); }, 30000);
    this.homey.log(`MQTT connected to ${host}:${port}`);
  }

  onData(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    while (this.rx.length >= 2) {
      const rl = MinimalMqttClient.decRemainingLength(this.rx);
      if (!rl) break;
      const end = rl.next + rl.value;
      if (this.rx.length < end) break;
      const type = this.rx[0] >> 4;
      const flags = this.rx[0] & 15;
      const body = this.rx.subarray(rl.next, end);
      this.rx = this.rx.subarray(end);

      if (type === 2) {
        if (body[1] !== 0) { this._connackReject?.(new Error(`MQTT CONNACK error ${body[1]}`)); return; }
        this._connackResolve?.();
      } else if (type === 3) {
        if (body.length < 2) continue;
        const len = body.readUInt16BE(0);
        const topic = body.toString('utf8', 2, 2 + len);
        let pos = 2 + len;
        if ((flags & 6) !== 0) pos += 2;
        try { this.handlers.message?.(topic, body.subarray(pos).toString('utf8')); } catch (e) {
          this.homey.error(`SofaBaton MQTT message handler error: ${e.message}`);
        }
      }
    }
  }

  subscribe(topic) {
    if (!this.socket || !this.connected) return;
    const id = this.packetId++ & 0xffff;
    const body = Buffer.concat([
      Buffer.from([(id >> 8) & 255, id & 255]),
      MinimalMqttClient.encString(topic),
      Buffer.from([0]),
    ]);
    this.socket.write(Buffer.concat([Buffer.from([0x82]), MinimalMqttClient.encRemainingLength(body.length), body]));
  }

  disconnect() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    try { if (this.socket) this.socket.write(Buffer.from([0xE0, 0])); } catch {}
    try { this.socket?.destroy(); } catch {}
    this.socket = null; this.connected = false;
  }
}

// ---------------------------------------------------------------------------
// SofaBatonClient — binary TCP protocol + MQTT
// ---------------------------------------------------------------------------
class SofaBatonClient {
  constructor(homey, ip, options = {}) {
    this.homey = homey;
    this.ip = ip;
    this.socket = null;
    this.server = null;
    this.rx = Buffer.alloc(0);
    this.activities    = new Map();  // activityId → { id, name }
    this.devices       = new Map();  // deviceId   → { id, name, type }
    this.commands      = new Map();  // commandId  → command  (flat, for backward compat)
    this.commandsByDevice = new Map(); // deviceId → Map<commandId, command>
    this.currentActivityId   = null;
    this.currentActivityName = null;
    this.connected  = false;
    this.options    = options;
    this.onActivityChange  = options.onActivityChange  || (() => {});
    this.onButtonPress     = options.onButtonPress     || (() => {});
    this.onConnectionChange = options.onConnectionChange || (() => {});
    this.requestQueue  = Promise.resolve();
    this.mqtt          = null;
    this.bannerMac     = null;
    this.pendingCommandDeviceId = null;
    this._commandPageStream = new Map(); // deviceId → Buffer
    this._rawCommandDump    = new Map(); // deviceId → Buffer (persists after finalize, for debug)
    this._ackWaiters   = new Map();      // opcode → resolve fn for createWifiDevice
    this._proxyAppBuf = Buffer.alloc(0);
    // Proxy — allows SofaBaton mobile app to coexist with Homey
    this._proxyUdp          = null;
    this._lastButtonPress  = null;
    this._bindings         = new Map();
    this._proxyUdpPort      = null;
    this._appSocket         = null;
    this._mdnsService       = null; // true once raw-multicast mDNS announce is running
    this._mdnsTimer         = null;
    this._mdnsSock          = null;
    this._cachedBannerPayload = null;
    this._bannerOpcode      = null; // actual opcode from hub (e.g. 0x1502 or 0x1D02)
  }

  async connectAndCatalog({ testOnly = false } = {}) {
    await this.connect();
    await this.request(OP.REQ_BANNER, Buffer.alloc(0), 250);
    if (this.options.mqtt?.host) await this.startMqtt();
    if (testOnly) { await this.close(); return true; }
    await this.refreshCatalog();
    return true;
  }

  async connect() {
    if (this.socket && this.connected) return;

    const hostIp = localIPv4(this.ip);
    this.server = net.createServer();
    let chosenPort = null;

    for (let p = BASE_TCP_PORT; p < BASE_TCP_PORT + 40; p++) {
      try {
        await new Promise((resolve, reject) => {
          const onError = e => { this.server.removeListener('listening', onListen); reject(e); };
          const onListen = () => { this.server.removeListener('error', onError); resolve(); };
          this.server.once('error', onError);
          this.server.once('listening', onListen);
          this.server.listen(p, '0.0.0.0');
        });
        chosenPort = p; break;
      } catch (e) {
        if (p === BASE_TCP_PORT + 39) throw e;
      }
    }

    if (chosenPort === null) throw new Error('Could not open SofaBaton TCP callback port');

    this.lastDiagnostic = { homeyIp: hostIp, listenPort: chosenPort, x2Ip: this.ip, serverListening: true };
    this.homey.log(`SOFABATON: TCP callback listening on ${hostIp}:${chosenPort}`);

    const accepted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(
        `Timed out waiting for X2 TCP callback. Homey=${hostIp}:${chosenPort}, X2=${this.ip}`
      )), 5000);  // 5s: hub responds in <1s if slot is free; 30s only helped if hub was slow
      this.server.once('connection', socket => {
        clearTimeout(timer);
        this.socket = socket; this.connected = true;
        socket.setKeepAlive(true, 30000);
        socket.on('data', c => this.onData(c));
        socket.on('close', () => { this.connected = false; this.socket = null; });
        socket.on('error', e => this.homey.error(`SofaBaton TCP error: ${e.message}`));
        this.homey.log('SOFABATON: X2 TCP callback RECEIVED');
        resolve();
      });
    });

    const udp = dgram.createSocket('udp4');
    const callMe = Buffer.alloc(12);
    // Fill first 6 bytes with hub MAC if known (some hub firmwares use this for auth)
    if (this.bannerMac) {
      const macBytes = Buffer.from(this.bannerMac.replace(/:/g,''), 'hex');
      macBytes.copy(callMe, 0, 0, 6);
    }
    hostIp.split('.').forEach((octet, i) => callMe.writeUInt8(Number(octet), i + 6));
    callMe.writeUInt16BE(chosenPort, 10);
    const packet = frame(0x0CC3, callMe);

    this.homey.log(`SOFABATON: Sending callback ${hostIp}:${chosenPort} → X2 ${this.ip}:${HUB_UDP_PORT}`);
    await new Promise((resolve, reject) => {
      udp.send(packet, HUB_UDP_PORT, this.ip, err => {
        udp.close();
        if (err) reject(new Error(`UDP send failed: ${err.message}`));
        else resolve();
      });
    });

    await accepted;
  }

  onData(chunk) {
    // Forward raw hub bytes to proxied SofaBaton app first
    if (this._appSocket) {
      try { this._appSocket.write(chunk); } catch {}
    }
    this.rx = Buffer.concat([this.rx, chunk]);
    const parsed = parseFrameStream(this.rx);
    this.rx = parsed.rest;
    for (const f of parsed.frames) this.handleFrame(f);
  }

  handleFrame(f) {
    // Route to any pending ack waiter first (used by createWifiDevice)
    const _ackHandler = this._ackWaiters.get(f.opcode);
    if (_ackHandler) { this._ackWaiters.delete(f.opcode); _ackHandler(f); return; }

    if (f.opcode === 0x1D02 || f.opcode === 0x1502) { // 0x1502 = 21-byte banner (X2 firmware), 0x1D02 = 29-byte (X1S)
      this.bannerMac = f.payload.subarray(0, 6).toString('hex').toUpperCase();
      // Cache MAC so we can start proxy on next boot before hub connects
      if (this.options.onBannerMac) this.options.onBannerMac(this.bannerMac);
      this._bannerOpcode = f.opcode;
      this._cachedBannerPayload = Buffer.from(f.payload);
      this.homey.log(`SOFABATON: Banner MAC=${this.bannerMac}`);
      if (this.options.mqtt?.host)
        this.startMqtt().catch(e => this.homey.error(`MQTT start error: ${e.message}`));
      this._startProxy().catch(e => this.homey.error(`PROXY start error: ${e.message}`));
      return;
    }
    if (f.opcode === OP.ACK_READY) {
      // ACK_READY signals something changed; payload is always 0x00 (not the activity ID).
      // Refresh activity rows — parseActivityRow will log hdr bytes so we can find
      // the "currently active" flag, then fire onActivityChange from there.
      this.options.dlog?.(`ACK_READY: payload=${f.payload.toString('hex')}`);
      setTimeout(() => this.refreshActivities().catch(e => this.homey.error(e.message)), 250);
      return;
    }
    if (f.opcode === 0xD53B) { this.parseActivityRow(f.payload); return; }
    if (f.opcode === 0xD50B) { this.parseDeviceRow(f.payload); return; }
    if (COMMAND_PAGE_OPCODES.has(f.opcode)) {
      if (this.pendingCommandDeviceId != null)
        this._accumulateCommandPage(f.payload, f.opcode, this.pendingCommandDeviceId);
      return;
    }
  }

  parseActivityRow(p) {
    if (p.length < 8) return;
    const id = p[7];
    const name = bestUtf16Label(p, 8, 60) || `Activity ${id}`;
    this.activities.set(id, { id, name });
    // Log first 8 bytes so we can identify the "current activity" flag
    this.options.dlog?.(`ACT_ROW: id=${id} name="${name}" hdr=${p.subarray(0,8).toString('hex')}`);
  }

  parseDeviceRow(p) {
    if (p.length < 8) return;
    const id = p[7];
    const type = p.length > 8 ? p[8] : undefined;
    const name = bestUtf16Label(p, 12, 60) || `Device ${id}`;
    const rawHex = p.subarray(0, Math.min(p.length, 20)).toString('hex');
    this.devices.set(id, { id, name, type, rawHex });
    this.homey.log(`DEVICE: id=${id} name="${name}" type=0x${(type||0).toString(16)} raw=${rawHex}`);
  }

  // Accumulate raw page bytes per device.
  // Header page (0xD95D): skip first 7 metadata bytes, rest is record data.
  // All other pages: full payload is record data.
  _accumulateCommandPage(payload, opcode, deviceId) {
    // Header page (0xD95D): first 7 bytes are metadata, records follow.
    // Continuation pages: first 3 bytes are metadata, records follow.
    const skip = (opcode === COMMAND_HEADER_OPCODE) ? 7 : 3;
    const data = payload.subarray(skip);
    const existing = this._commandPageStream.get(deviceId) || Buffer.alloc(0);
    this._commandPageStream.set(deviceId, Buffer.concat([existing, data]));
    // Keep full raw payload for debug inspection.
    const rawExisting = this._rawCommandDump.get(deviceId) || Buffer.alloc(0);
    this._rawCommandDump.set(deviceId, Buffer.concat([rawExisting, payload]));
  }

  // Parse accumulated buffers into commandsByDevice and commands.
  // Record format (70 bytes, X1S/X2):
  //   [0]     device_id
  //   [1]     command_id
  //   [2-8]   control block (7 bytes)
  //   [9-68]  label, 60 bytes, UTF-16BE
  //   [69]    tail
  _finalizeCommands() {
    this.commandsByDevice.clear();
    this.commands.clear();

    for (const [deviceId, buf] of this._commandPageStream) {
      const cmdMap = new Map();
      this.commandsByDevice.set(deviceId, cmdMap);

      const stride = 70;
      let count = 0;

      for (let i = 0; i + stride <= buf.length; i += stride) {
        const cmdId = buf[i + 1];
        if (!cmdId || cmdId === 0xFF) continue;

        const labelBuf = buf.subarray(i + 9, i + 69);
        const label    = cleanLabel(utf16be(labelBuf));

        if (!label) {
          // Unexpected empty label — log raw bytes to aid protocol debugging
          this.homey.log(
            `RECORD dev=${deviceId} idx=${count} cmdId=0x${cmdId.toString(16)} ` +
            `hex=${buf.subarray(i, i + 24).toString('hex')} label=(empty)`
          );
          continue;
        }

        const cmd = { id: cmdId, deviceId, label };
        cmdMap.set(cmdId, cmd);
        this.commands.set(cmdId, cmd);
        count++;
      }

      this.homey.log(`SOFABATON: Device ${deviceId} → ${count} commands from ${buf.length}B`);
    }

    this._commandPageStream.clear();
  }

  async request(opcode, payload = Buffer.alloc(0), waitMs = 250) {
    if (!this.socket || !this.connected) throw new Error('SofaBaton X2 not connected');
    const run = async () => {
      this.socket.write(frame(opcode, payload));
      if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    };
    this.requestQueue = this.requestQueue.then(run, run);
    return this.requestQueue;
  }

  async startMqtt() {
    if (this.mqtt?.connected || !this.options.mqtt?.host || !this.bannerMac) return;
    this.mqtt = new MinimalMqttClient(this.homey, this.options.mqtt, {
      message: (topic, payload) => this.handleMqtt(topic, payload),
    });
    await this.mqtt.connect();
    const mac = this.bannerMac;
    // activity_control_down = hub publishes current state here
    this.mqtt.subscribe(`activity/${mac}/activity_control_down`);
    // {MAC}/up = hub publishes button events from wifi_mqtt devices here
    this.mqtt.subscribe(`${mac}/up`);
    this.homey.log(`MQTT subscribed: activity/${mac}/activity_control_down + ${mac}/up`);
  }

  handleMqtt(topic, payload) {
    let data;
    try { data = JSON.parse(payload); } catch { data = payload.trim(); }

    if (topic.endsWith('/activity_control_down')) {
      const id = Number(data?.activity_id ?? data?.activityId ?? data?.id ?? data?.activity ?? data);
      if (Number.isFinite(id)) {
        const a = this.activities.get(id);
        this.currentActivityId   = id;
        this.currentActivityName = a?.name || `Activity ${id}`;
        this.onActivityChange(id, this.currentActivityName);
      }
      return;
    }

    if (topic.endsWith('/up')) {
      if (data && typeof data === 'object') {
        const deviceId = Number(data.device_id ?? data.deviceId ?? data.device ?? data.id);
        const keyId    = Number(data.key_id   ?? data.keyId   ?? data.key   ?? data.command_id);
        if (Number.isFinite(deviceId) && Number.isFinite(keyId))
          this.onButtonPress({ device_id: deviceId, key_id: keyId });
      }
    }
  }

  async refreshActivities() {
    this.activities.clear();
    await this.request(OP.REQ_ACTIVITIES, Buffer.alloc(0), 700);
    await new Promise(r => setTimeout(r, 200));
    return [...this.activities.values()];
  }

  async refreshCatalog() {
    this.activities.clear();
    this.devices.clear();
    this.commands.clear();
    this.commandsByDevice.clear();
    this._commandPageStream.clear();
    this._rawCommandDump.clear();

    await this.request(OP.REQ_ACTIVITIES, Buffer.alloc(0), 700);
    await this.request(OP.REQ_DEVICES, Buffer.alloc(0), 700);

    for (const id of this.devices.keys()) {
      this.pendingCommandDeviceId = id;
      this._commandPageStream.set(id, Buffer.alloc(0));
      await this.request(OP.REQ_COMMANDS, Buffer.from([id & 0xff, 0xff]), 900);
    }

    this.pendingCommandDeviceId = null;
    await new Promise(r => setTimeout(r, 500));
    this._finalizeCommands();

    this.homey.log(
      `CATALOG: activities=${this.activities.size} devices=${this.devices.size} commands=${this.commands.size}`
    );
    return true;
  }

  async sendCommand(entityId, commandId) {
    await this.request(OP.REQ_ACTIVATE, Buffer.from([entityId & 0xff, commandId & 0xff]), 100);
    return true;
  }

  async startActivity(activityId) { return this.sendCommand(Number(activityId), 0xC6); }

  async stopActivity() {
    const id = this.currentActivityId != null ? this.currentActivityId : null;
    if (id == null) return this.sendCommand(0xff, 0xC7);
    return this.sendCommand(id, 0xC7);
  }

  async findRemote() { await this.request(OP.FIND_REMOTE_X2, Buffer.from([0, 0, 8]), 100); return true; }

  // Register a one-shot promise that resolves when the hub sends a frame with ackOpcode.
  _waitForAck(ackOpcode, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._ackWaiters.delete(ackOpcode);
        reject(new Error(`Timeout waiting for hub ack 0x${ackOpcode.toString(16).padStart(4, '0')}`));
      }, timeoutMs);
      this._ackWaiters.set(ackOpcode, f => { clearTimeout(timer); resolve(f); });
    });
  }

  _encodeUtf16BE(str, totalBytes) {
    const buf = Buffer.alloc(totalBytes, 0);
    const s = String(str || '').slice(0, Math.floor(totalBytes / 2));
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      buf[i * 2]     = (c >> 8) & 0xff;
      buf[i * 2 + 1] = c & 0xff;
    }
    return buf;
  }

  _encodeUtf16LE(str, totalBytes) {
    const buf = Buffer.alloc(totalBytes, 0);
    const s = String(str || '').slice(0, Math.floor(totalBytes / 2));
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      buf[i * 2]     = c & 0xff;
      buf[i * 2 + 1] = (c >> 8) & 0xff;
    }
    return buf;
  }

  // Build CREATE_DEVICE_HEAD or FINALIZE_DEVICE payload (X1S/X2, 213 bytes).
  // deviceId=0xFF for create (hub assigns real id). isFinalize=true sets tail_marker=0x01.
  // codeType: 0x1C = wifi_ip (HTTP callbacks), 0x20 = wifi_mqtt (MQTT button events).
  _buildCreateDevicePayload(deviceName, deviceId, isFinalize, codeType = 0x1C) {
    const SLOT_W   = 60;
    const BODY_LEN = 210;
    const wrapper  = Buffer.from([0x01, 0x00, 0x01]);
    const body     = Buffer.alloc(BODY_LEN, 0);

    body[0] = 0x01;             // page constant
    body[1] = 0x00;             // total_pages hi
    body[2] = 0x01;             // total_pages lo
    body[3] = 0x00;             // record_kind = wifi/IP
    body[4] = deviceId & 0xff;  // 0xFF → create; real id → finalize
    body[5] = 0x01;             // icon
    body[6] = 0x00;             // sort
    body[7] = codeType & 0xff;  // code_type: 0x1C=wifi_ip, 0x20=wifi_mqtt
    body[8] = 0x10;             // device_type = wifi

    this._encodeUtf16BE(deviceName, SLOT_W).copy(body, 29);   // name slot
    this._encodeUtf16BE(deviceName, SLOT_W).copy(body, 89);   // brand slot (same)

    const tail = Buffer.alloc(SLOT_W, 0);
    tail[0]  = 0xFC;
    tail[1]  = 0x00;
    tail[2]  = 0x0A;            // poll_time = 10 s
    tail[3]  = 0xFC;
    tail[4]  = 0x02;            // input_mode
    tail[5]  = 0x00;            // power_mode (IP-generic: 0)
    tail[6]  = 0x00;            // power_style (IP-generic: 0)
    tail[7]  = 0x00;            // share_mode
    tail[8]  = 0xFC;
    tail[9]  = 0x00;
    tail[10] = 0xFC;
    tail[11] = isFinalize ? 0x01 : 0x00;
    tail.copy(body, 149);

    // Body checksum: sum of bytes 0..208 stored in byte 209
    let bodySum = 0;
    for (let i = 0; i < BODY_LEN - 1; i++) bodySum = (bodySum + body[i]) & 0xff;
    body[BODY_LEN - 1] = bodySum;

    return Buffer.concat([wrapper, body]);  // 213 bytes total
  }

  // Build DEFINE_IP_CMD payload for one command slot (X1S/X2 IP-generic).
  // slot is 1-based; path is the POST path e.g. "/launch/MAC/devId/0/short".
  _buildDefineIpCmd(slot, deviceId, cmdName, homeyIp, port, path) {
    const header = Buffer.from([
      slot, 0x00, 0x01, 0x03, 0x00, 0x01,
      deviceId & 0xff, 0x00, 0x1C,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    const cmdNameBuf = this._encodeUtf16LE(cmdName, 59);
    const ipBuf      = Buffer.from(homeyIp.split('.').map(Number));
    const portBuf    = Buffer.from([(port >> 8) & 0xff, port & 0xff]);

    const httpText = (
      `POST ${path} HTTP/1.1\r\n` +
      `Host:${homeyIp}:${port}\r\n` +
      `Content-Type:application/x-www-form-urlencoded\r\n` +
      `\r\n`
    );
    const httpBuf = Buffer.from(httpText, 'ascii');

    const payloadBase = Buffer.concat([
      header, cmdNameBuf, ipBuf, portBuf,
      Buffer.from([0x00, httpBuf.length & 0xff]),
      httpBuf,
    ]);

    // Checksum token: (sum(payloadBase) - (slot + 1)) & 0xFF
    let pSum = 0;
    for (const b of payloadBase) pSum = (pSum + b) & 0xff;
    return Buffer.concat([payloadBase, Buffer.from([(pSum - (slot + 1)) & 0xff])]);
  }

  // Build publish-finalize payload (Step 7, X1S/X2 only, family 0x08).
  _buildPublishFinalizePayload(deviceId, deviceName, codeType = 0x1C) {
    const header = Buffer.alloc(31, 0);
    header[0]  = 0x01;
    header[3]  = 0x01;
    header[5]  = 0x01;
    header[7]  = deviceId & 0xff;
    header[8]  = 0x01;
    header[9]  = deviceId & 0xff;
    header[10] = codeType & 0xff;
    header[11] = 0x10;

    const sep      = Buffer.from([0x4D, 0x00]);
    const nameBuf  = this._encodeUtf16LE(deviceName, 60);
    const brandBuf = this._encodeUtf16LE(deviceName, 60);
    // 31+2+60+60=153 so far; pad to 210 bytes body (before checksum)
    const tail = Buffer.alloc(56, 0);

    const body = Buffer.concat([header, sep, nameBuf, brandBuf, tail]);
    let s = 0;
    for (const b of body) s = (s + b) & 0xff;
    return Buffer.concat([body, Buffer.from([(s - 0x02) & 0xff])]);
  }

  // Create a WiFi device on the X2 hub.
  // transport: 'http' (default) = HTTP callbacks; 'mqtt' = hub publishes to MQTT broker.
  // callbackPort only used for http transport. Returns { deviceId, name, commands, transport }.
  async createWifiDevice(deviceName, commandNames, callbackPort, transport = 'http') {
    if (!this.socket || !this.connected) throw new Error('SofaBaton X2 not connected');
    if (!this.bannerMac) throw new Error('Hub MAC not yet received — wait for catalog ready');

    const isMqtt  = transport === 'mqtt';
    const codeType = isMqtt ? 0x20 : 0x1C; // 0x20=wifi_mqtt, 0x1C=wifi_ip per HA protocol_const.py
    const cmds    = commandNames.slice(0, 10);
    const mac     = this.bannerMac;

    if (isMqtt) {
      this.homey.log(`WiFi CREATE (mqtt): "${deviceName}" ${cmds.length} cmd(s)`);
    } else {
      const homeyIp = localIPv4(this.ip);
      const port    = Number(callbackPort) || BASE_HTTP_PORT;
      this.homey.log(`WiFi CREATE (http): "${deviceName}" ${cmds.length} cmd(s) → ${homeyIp}:${port}`);
    }

    // Step 1 — CREATE_DEVICE_HEAD → ACK 0x0107 payload[0] = assigned device_id
    const createPayload = this._buildCreateDevicePayload(deviceName, 0xFF, false, codeType);
    const step1Ack = this._waitForAck(0x0107, 8000);
    this.socket.write(familyFrame(0x07, createPayload));
    const createAck = await step1Ack;
    const deviceId  = createAck.payload[0];
    this.homey.log(`  Hub assigned device_id=${deviceId}`);

    // Step 2 — Command records × N → ACK 0x0103 each
    // http: full DEFINE_IP_CMD payload (HTTP method + URL + headers)
    // mqtt: 2-byte inert record [0x00, slot] — hub ignores the body and publishes to {mac}/up on press
    if (isMqtt) {
      for (let i = 0; i < cmds.length; i++) {
        const slot = i + 1;
        const ackP = this._waitForAck(0x0103, 5000);
        this.socket.write(familyFrame(0x0E, Buffer.from([0x00, slot])));
        const ack = await ackP;
        if (ack.payload[0] !== 0x00)
          throw new Error(`CMD slot ${slot} rejected (status ${ack.payload[0]})`);
        this.homey.log(`  Slot ${slot} "${cmds[i]}" OK (mqtt)`);
      }
    } else {
      const homeyIp     = localIPv4(this.ip);
      const port        = Number(callbackPort) || BASE_HTTP_PORT;
      const encodedName = encodeURIComponent(deviceName.toLowerCase());
      for (let i = 0; i < cmds.length; i++) {
        const slot = i + 1;
        const path = `/launch/${mac}/wf/${encodedName}/${i}/short`;
        const ackP = this._waitForAck(0x0103, 5000);
        this.socket.write(familyFrame(0x0E, this._buildDefineIpCmd(slot, deviceId, cmds[i], homeyIp, port, path)));
        const ack = await ackP;
        if (ack.payload[0] !== 0x00)
          throw new Error(`DEFINE_IP_CMD slot ${slot} rejected (status ${ack.payload[0]})`);
        this.homey.log(`  Slot ${slot} "${cmds[i]}" OK (http)`);
      }
    }

    // Step 3 — PREPARE_SAVE (family 0x41, payload [deviceId, 0x04])
    { const p = this._waitForAck(0x0103, 5000); this.socket.write(familyFrame(0x41, Buffer.from([deviceId & 0xff, 0x04]))); await p; }

    // Step 4 — Inputs sync (family 0x46, 119-byte empty payload)
    { const p = this._waitForAck(0x0103, 5000); this.socket.write(familyFrame(0x46, Buffer.alloc(119, 0))); await p; }

    // Step 5 — FINALIZE_DEVICE (same body, tail_marker=0x01, real deviceId)
    { const p = this._waitForAck(0x0103, 5000); this.socket.write(familyFrame(0x08, this._buildCreateDevicePayload(deviceName, deviceId, true, codeType))); await p; }

    // Step 6 — SAVE_COMMIT (family 0x64, empty payload)
    { const p = this._waitForAck(0x0103, 5000); this.socket.write(familyFrame(0x64, Buffer.alloc(0))); await p; }

    // Step 7 — Publish-finalize (X1S/X2 only, best-effort; no ack = device still created)
    try {
      const p = this._waitForAck(0x0103, 3000);
      this.socket.write(familyFrame(0x08, this._buildPublishFinalizePayload(deviceId, deviceName, codeType)));
      await p;
      this.homey.log('  Publish-finalize OK');
    } catch (e) {
      this.homey.log(`  Publish-finalize skipped: ${e.message}`);
    }

    // Proactively insert the new device so it's visible immediately —
    // the hub may not include it in the next REQ_DEVICES response in time.
    this.devices.set(deviceId, { id: deviceId, name: deviceName, type: undefined, rawHex: '' });
    await this.refreshCatalog();
    // Re-add if catalog refresh dropped it (hub timing race).
    if (!this.devices.has(deviceId)) {
      this.devices.set(deviceId, { id: deviceId, name: deviceName, type: undefined, rawHex: '' });
      this.homey.log(`WiFi CREATE: re-added "${deviceName}" id=${deviceId} after catalog refresh`);
    }
    // Store command info locally so HTTP callbacks can resolve them without hub catalog
    if (!this._wifiDeviceCommands) this._wifiDeviceCommands = new Map();
    if (!this._wifiCommandsByName) this._wifiCommandsByName = new Map();
    const localCmds = new Map();
    cmds.forEach((label, i) => localCmds.set(i, { id: i, label }));
    this._wifiDeviceCommands.set(deviceId, localCmds);
    this._wifiCommandsByName.set(deviceName.toLowerCase(), { deviceId, cmds: localCmds });

    this.homey.log(`WiFi CREATE done: id=${deviceId} name="${deviceName}" transport=${transport}`);
    return { deviceId, name: deviceName, commands: cmds, transport };
  }

  // Delete a WiFi device from the X2 hub by its hub device ID.
  async deleteWifiDevice(deviceId) {
    if (!this.socket || !this.connected) throw new Error('SofaBaton X2 not connected');
    const id = deviceId & 0xff;
    this.homey.log(`WiFi DELETE: id=${id}`);
    // OP_DELETE_DEVICE = 0x0109, per HA protocol_const.py — mirrors createWifiDevice's ACK pattern
    { const p = this._waitForAck(0x0103, 5000); this.socket.write(familyFrame(0x09, Buffer.from([id]))); await p; }
    // SAVE_COMMIT = 0x0064 — same as createWifiDevice step 6
    { const p = this._waitForAck(0x0103, 5000); this.socket.write(familyFrame(0x64, Buffer.alloc(0))); await p; }
    await this.refreshCatalog();
    this.homey.log(`WiFi DELETE done: id=${id}`);
  }

  // Start mDNS advertisement using a cached MAC before the hub connects,
  // so the SofaBaton app hits the proxy on reboot.
  async _startProxyWithMac(mac) {
    if (this._proxyUdp) return;         // already running
    if (this._mdnsService) return;      // already advertising

    const hostIp = localIPv4(this.ip);
    const udp = dgram.createSocket('udp4');
    let boundPort = null;
    for (const p of [HUB_UDP_PORT, HUB_UDP_PORT + 1, HUB_UDP_PORT + 2]) {
      try {
        await new Promise((resolve, reject) => {
          udp.once('error', reject);
          udp.once('listening', resolve);
          udp.bind(p, '0.0.0.0');
        });
        boundPort = p; break;
      } catch {
        udp.removeAllListeners('error');
        udp.removeAllListeners('listening');
      }
    }
    if (!boundPort) { try { udp.close(); } catch {} return; }
    udp.setBroadcast(true);
    this._proxyUdp     = udp;
    this._proxyUdpPort = boundPort;
    this._mdnsService  = true;
    this.bannerMac     = mac;

    // When app sends CALL_ME to proxy: we save the app address and, once
    // the hub TCP connection is established, bridge them. For now we just
    // let the connect() loop run normally — the app will retry via mDNS.
    udp.on('message', (msg, rinfo) => {
      if (rinfo.address === this.ip) return;
      if (msg.length < 17) return;
      if (msg[0] !== SYNC0 || msg[1] !== SYNC1) return;
      if (msg[2] !== 0x0C || msg[3] !== 0xC3) return;
      const appIp   = `${msg[10]}.${msg[11]}.${msg[12]}.${msg[13]}`;
      const appPort = msg.readUInt16BE(14);
      const rawHex = msg.toString('hex');
      this.homey.log(`PROXY(early): CALL_ME raw=${rawHex} from=${rinfo.address} ip=${appIp}:${appPort} payload0-5=${msg.slice(4,10).toString('hex')}`);
      if (this.connected) {
        this._connectToApp(appIp, appPort).catch(e =>
          this.homey.error(`PROXY _connectToApp: ${e.message}`));
      }
      // If not connected yet, discard — app will retry in ~5s when its CALL_ME times out
    });

    this._startMdnsAnnounce(hostIp);
    this.homey.log(`PROXY(early): mDNS → ${hostIp}, udp :${boundPort}, mac=${mac}`);
  }


  async _startProxy() {
    if (this._proxyUdp) return;

    const hostIp = localIPv4(this.ip);

    const udp = dgram.createSocket('udp4');
    let boundPort = null;
    for (const p of [HUB_UDP_PORT, HUB_UDP_PORT + 1, HUB_UDP_PORT + 2]) {
      try {
        await new Promise((resolve, reject) => {
          udp.once('error', reject);
          udp.once('listening', resolve);
          udp.bind(p, '0.0.0.0');
        });
        boundPort = p;
        break;
      } catch {
        udp.removeAllListeners('error');
        udp.removeAllListeners('listening');
      }
    }
    if (!boundPort) { try { udp.close(); } catch {} throw new Error('PROXY: no UDP port available'); }
    udp.setBroadcast(true);
    this._proxyUdp     = udp;
    this._proxyUdpPort = boundPort;

    udp.on('message', (msg, rinfo) => {
      if (rinfo.address === this.ip) return; // skip our own CALL_ME to hub
      if (msg.length < 17) return;
      if (msg[0] !== SYNC0 || msg[1] !== SYNC1) return;
      if (msg[2] !== 0x0C || msg[3] !== 0xC3) return; // opcode 0x0CC3 = CALL_ME
      const appIp   = `${msg[10]}.${msg[11]}.${msg[12]}.${msg[13]}`;
      const appPort = msg.readUInt16BE(14);
      const rawHex = msg.toString('hex');
      this.homey.log(`PROXY: CALL_ME raw=${rawHex} from=${rinfo.address} ip=${appIp}:${appPort} payload0-5=${msg.slice(4,10).toString('hex')}`);
      this._connectToApp(appIp, appPort).catch(e => this.homey.error(`PROXY _connectToApp: ${e.message}`));
    });

    this._mdnsService = true; // flag — advertisement runs via raw multicast below
    this._startMdnsAnnounce(hostIp);

    this.homey.log(`PROXY: UDP :${boundPort} listening, mDNS raw announce → ${hostIp}`);
  }

  _buildMdnsPacket(instanceName, hostIp, port) {
    // Encode a DNS name as length-prefixed labels + trailing null
    function encName(name) {
      const parts = name.split('.');
      const bufs = parts.map(p => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
      return Buffer.concat([...bufs, Buffer.from([0])]);
    }

    const svcType  = '_sofabaton_hub._udp.local';
    const fullName = `${instanceName}.${svcType}`;
    const hostname = `${instanceName}.local`;

    const svcName  = encName(svcType);
    const instName = encName(fullName);
    const hostName = encName(hostname);

    const ipBytes = Buffer.from(hostIp.split('.').map(Number));

    // TXT rdata: each string is length-prefixed
    const txtStrings = [
      `NAME=${instanceName}`,
      `MAC=${this.bannerMac || ''}`,
      `HA_PROXY=1`,
    ];
    const txtRdata = Buffer.concat(txtStrings.map(s => {
      const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]);
    }));

    const ttl = Buffer.from([0x00, 0x00, 0x00, 0x78]); // 120s

    function rr(name, type, clsWord, ttlBuf, rdata) {
      const rdlen = Buffer.alloc(2); rdlen.writeUInt16BE(rdata.length);
      const hdr = Buffer.alloc(4);
      hdr.writeUInt16BE(type, 0);
      hdr.writeUInt16BE(clsWord, 2);
      return Buffer.concat([name, hdr, ttlBuf, rdlen, rdata]);
    }

    // SRV RDATA: priority(2) + weight(2) + port(2) + target
    const srvRdata = Buffer.concat([Buffer.from([0,0,0,0]), Buffer.from([port >> 8, port & 0xff]), hostName]);

    const answers = Buffer.concat([
      rr(svcName,  12, 0x0001, ttl, instName),    // PTR
      rr(instName, 33, 0x8001, ttl, srvRdata),    // SRV (cache-flush IN)
      rr(instName, 16, 0x8001, ttl, txtRdata),    // TXT (cache-flush IN)
      rr(hostName,  1, 0x8001, ttl, ipBytes),     // A   (cache-flush IN)
    ]);

    const hdr = Buffer.from([
      0x00, 0x00,  // ID = 0
      0x84, 0x00,  // QR=1, AA=1
      0x00, 0x00,  // QDCOUNT = 0
      0x00, 0x04,  // ANCOUNT = 4
      0x00, 0x00,  // NSCOUNT = 0
      0x00, 0x00,  // ARCOUNT = 0
    ]);
    return Buffer.concat([hdr, answers]);
  }

  _startMdnsAnnounce(hostIp) {
    // Match the hub's own mDNS instance name so our cache-flush A record
    // overwrites the hub's cached IP with the proxy IP, and the SofaBaton app
    // still sees the correct model (X2 vs X1S).
    // 0x1502 banner = X2 firmware → "X2-HUB-…"; 0x1D02 = X1S → "X1-HUB-…"
    const mac = this.bannerMac || '000000';
    const prefix = this._bannerOpcode === 0x1502 ? 'X2-HUB' : 'X1-HUB';
    const instanceName = `${prefix}-${mac.slice(-6).toLowerCase()}`;
    const port = this._proxyUdpPort;

    // Keep one socket open for the lifetime of the interval — avoids creating
    // and destroying a socket (6 syscalls) every announce cycle.
    const sock = dgram.createSocket('udp4');
    this._mdnsSock = sock;
    sock.on('error', e => this.homey.error(`PROXY mDNS sock: ${e.message}`));

    const sendAnnounce = () => {
      if (!this._mdnsSock) return;
      try {
        const pkt = this._buildMdnsPacket(instanceName, hostIp, port);
        sock.send(pkt, 0, pkt.length, 5353, '224.0.0.251', err => {
          if (err) this.homey.error(`PROXY mDNS send error: ${err.message}`);
        });
      } catch (e) { this.homey.error(`PROXY mDNS build: ${e.message}`); }
    };

    sock.bind(0, () => {
      try {
        sock.setMulticastTTL(255);
        sock.setMulticastInterface(hostIp);
      } catch (e) { this.homey.error(`PROXY mDNS multicast opts: ${e.message}`); }
      this.homey.log(`PROXY mDNS started — ${instanceName} → ${hostIp}:${port}`);
      // Burst-announce 3 times quickly to win mDNS conflict against the hub,
      // then settle to 60s interval (mDNS TTL is 255s so this is sufficient).
      sendAnnounce();
      setTimeout(sendAnnounce, 1000);
      setTimeout(sendAnnounce, 2000);
      this._mdnsTimer = setInterval(sendAnnounce, 60000);
    });
  }

  async _connectToApp(appIp, appPort) {
    if (this._appSocket) {
      try { this._appSocket.destroy(); } catch {}
      this._appSocket = null;
    }

    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection(appPort, appIp);
      const t = setTimeout(() => { s.destroy(); reject(new Error('TCP connect timeout')); }, 6000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error',   err => { clearTimeout(t); reject(err); });
    });

    this._appSocket = socket;

    // Replay cached banner using the exact opcode the hub sent (e.g. 0x1502 or 0x1D02)
    if (this._cachedBannerPayload && this._bannerOpcode) {
      const p = this._cachedBannerPayload;
      const bannerFrame = Buffer.alloc(5 + p.length);
      bannerFrame[0] = SYNC0; bannerFrame[1] = SYNC1;
      bannerFrame.writeUInt16BE(this._bannerOpcode, 2);
      p.copy(bannerFrame, 4);
      bannerFrame[bannerFrame.length - 1] = checksum(bannerFrame.subarray(0, bannerFrame.length - 1));
      socket.write(bannerFrame);
      this.homey.log(`PROXY: sent cached banner (opcode 0x${this._bannerOpcode.toString(16)}) to SofaBaton app`);
    }

    socket.on('data', chunk => {
      if (this.socket && this.connected) {
        try { this.socket.write(chunk); } catch {}
      }
    });

    socket.on('close', () => {
      this.homey.log('PROXY: SofaBaton app disconnected');
      if (this._appSocket === socket) this._appSocket = null;
    });

    socket.on('error', e => {
      this.homey.error(`PROXY: app socket error: ${e.message}`);
      if (this._appSocket === socket) { try { socket.destroy(); } catch {} this._appSocket = null; }
    });

    this.homey.log(`PROXY: connected to SofaBaton app at ${appIp}:${appPort}`);
  }

  async close() {
    try { this.mqtt?.disconnect(); } catch {}
    this.mqtt = null;
    try { this.socket?.destroy(); } catch {}
    this.socket = null; this.connected = false;
    this.onConnectionChange(false);
    try { this.server?.close(); } catch {}
    this.server = null;
    try { this._appSocket?.destroy(); } catch {}
    this._appSocket = null;
    try { this._proxyUdp?.close(); } catch {}
    this._proxyUdp = null;
    this._mdnsService = null;
    if (this._mdnsTimer) { clearInterval(this._mdnsTimer); this._mdnsTimer = null; }
    if (this._mdnsSock) { try { this._mdnsSock.close(); } catch {} this._mdnsSock = null; }
  }
}

// ---------------------------------------------------------------------------
// Management UI HTML (served at GET /manage/)
// ---------------------------------------------------------------------------
function managePageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SofaBaton · Manage</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;background:#f5f5f5;color:#111;max-width:540px}
.hdr{padding:14px 16px 0;background:#fff;border-bottom:1px solid #e0e0e0}
.hdr-row{display:flex;align-items:center;gap:8px;margin-bottom:2px}
h1{font-size:17px;margin:0;font-weight:700}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.on{background:#4caf50}.dot.off{background:#ccc}
.hub-sub{font-size:12px;color:#888;margin-bottom:6px}
.ver{font-size:10px;color:#ccc;margin-bottom:8px}
.tabs{display:flex;background:#fff;border-bottom:1px solid #e0e0e0;position:sticky;top:0;z-index:10}
.tab{flex:1;padding:10px 4px;text-align:center;font-size:13px;font-weight:500;color:#888;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent}
.tab.active{color:#1b5e20;border-bottom-color:#1b5e20}
.tab-pane{display:none;padding:14px 16px}
.tab-pane.active{display:block}
.card{background:#fff;border:1px solid #e8e8e8;border-radius:10px;padding:12px 14px;margin-bottom:8px}
.card-name{font-weight:600;font-size:14px;margin-bottom:2px}
.card-sub{font-size:12px;color:#888}
.empty{color:#aaa;font-style:italic;font-size:13px;padding:6px 0}
h2{font-size:15px;margin:0 0 10px;font-weight:600}
h3{font-size:13px;font-weight:600;margin:0 0 6px}
.fg{margin-bottom:10px}
.fg label{display:block;font-size:12px;color:#666;margin-bottom:4px;font-weight:500}
.fg select,.fg input,input[type=text],input[type=password],select{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px;background:#fff;outline:none}
.fg select:focus,.fg input:focus{border-color:#4c9be8}
.cmd-row{display:flex;gap:8px;margin-bottom:6px}
.cmd-row input{flex:1}
.btn-primary{width:100%;padding:11px;background:#1b5e20;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}
.btn-primary:disabled{opacity:.4;cursor:default}
.btn-add{width:100%;padding:8px;background:none;border:1px dashed #ccc;border-radius:8px;cursor:pointer;color:#888;font-size:13px;margin-top:8px}
.btn-add:hover{background:#f5f5f5}
.btn-x{background:none;border:1px solid #ddd;border-radius:7px;padding:5px 9px;cursor:pointer;color:#666;font-size:12px;white-space:nowrap}
.btn-x:hover{background:#fff0f0;border-color:#f99;color:#c00}
.btn-warn{background:none;border:1px solid #f99;border-radius:7px;padding:5px 9px;cursor:pointer;color:#c00;font-size:12px;white-space:nowrap}
.btn-warn:hover{background:#fff0f0}
.btn-rel{padding:9px 12px;background:#fff;border:1px solid #ddd;border-radius:8px;font-size:13px;cursor:pointer;font-weight:500}
.btn-rel:hover{background:#f0f6ff;border-color:#4c9be8;color:#4c9be8}
.btn-resume{width:100%;padding:11px;background:#ff8f00;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}
.msg-ok{background:#e8f5e9;color:#2e7d32;border-radius:8px;padding:10px 13px;margin-top:8px;font-size:13px}
.msg-err{background:#ffebee;color:#c62828;border-radius:8px;padding:10px 13px;margin-top:8px;font-size:13px}
.msg-info{font-size:12px;color:#888;margin:0 0 10px;line-height:1.5}
.share-active{background:#fff3e0;color:#e65100;border-radius:8px;padding:10px 13px;font-size:13px;margin-bottom:8px}
.sec-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;font-size:13px;font-weight:600;color:#1b5e20;cursor:pointer;padding:4px 0 8px;margin-top:4px}
.sec-body{display:none}.sec-body.open{display:block}
.detect-box{background:#fff;border:2px dashed #ccc;border-radius:10px;padding:14px;text-align:center;transition:border-color .25s}
.detect-box.active{border-color:#4c9be8;background:#f0f6ff}
.btn-detect{padding:9px 18px;background:#4c9be8;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn-detect.stop{background:#e53935}
.detected-chip{background:#e8f4e8;border:1px solid #a5d6a7;border-radius:8px;padding:10px 14px;font-size:13px;color:#2e7d32;display:inline-block;max-width:100%;word-break:break-all;text-align:left}
.spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:4px;opacity:.8}
@keyframes sp{to{transform:rotate(360deg)}}
details summary{font-size:12px;color:#aaa;cursor:pointer;padding:8px 0;user-select:none}
details summary:hover{color:#666}
details[open] summary{color:#666}
.dev-hdr{display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin:-4px;padding:4px;border-radius:8px}
.dev-hdr:hover{background:#f9f9f9}
.dev-body{margin-top:12px;padding-top:12px;border-top:1px solid #f0f0f0}
.binding-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5}
.binding-row:last-of-type{border-bottom:none}
.overlay{position:fixed;bottom:0;left:0;right:0;max-width:540px;margin:0 auto;background:#fff;border-top:2px solid #e0e0e0;padding:16px;max-height:85vh;overflow-y:auto;z-index:100;box-shadow:0 -4px 20px rgba(0,0,0,.15);display:none}
.overlay.open{display:block}
.overlay-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.overlay-hdr h3{margin:0;font-size:15px}
.btn-close{background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1;padding:0 4px}
.btn-close:hover{color:#333}
</style>
</head>
<body>

<!-- header -->
<div class="hdr">
  <div class="hdr-row">
    <div class="dot off" id="hub-dot"></div>
    <h1 id="hub-name">SofaBaton X2</h1>
  </div>
  <div class="hub-sub" id="hub-sub">Loading…</div>
  <div class="ver">v0.2.72</div>
</div>

<!-- tab bar -->
<div class="tabs">
  <button class="tab active" onclick="showTab('devices')" id="tab-btn-devices">Devices</button>
  <button class="tab" onclick="showTab('config')" id="tab-btn-config">Config</button>
</div>

<!-- ══ Devices tab ════════════════════════════════ -->
<div class="tab-pane active" id="tab-devices">
  <div id="device-list"><span class="empty">Loading…</span></div>

  <button class="sec-toggle" onclick="toggleSection('add-dev')" id="add-dev-toggle">
    <span id="add-dev-arrow">▶</span> Add WiFi Device
  </button>
  <div class="sec-body" id="add-dev-body">
    <div class="card">
      <div class="fg">
        <label for="dname">Device name <span style="font-weight:400;color:#bbb">(max 29 chars)</span></label>
        <input type="text" id="dname" placeholder="e.g. Dining Light" maxlength="29" oninput="checkCreate()"/>
      </div>
      <div class="fg">
        <label>Commands</label>
        <div id="cmd-list"></div>
        <button class="btn-add" onclick="addCmd()">+ Add command</button>
      </div>
      <button class="btn-primary" id="btn-create" onclick="doCreate()" disabled>Create on X2</button>
      <div id="create-banner" style="display:none;margin-top:8px"></div>
    </div>
  </div>
</div>

<!-- ══ Config tab ════════════════════════════════════ -->
<div class="tab-pane" id="tab-config">
  <h2>Proxy Control</h2>
  <p class="msg-info">Temporarily release the hub so the SofaBaton mobile app can connect directly. On first setup: open the SofaBaton app → discover hub → hub settings → set hub IP to <strong id="proxy-ip">this Homey's IP</strong> → save. After that both work together.</p>
  <div id="share-active" class="share-active" style="display:none"></div>
  <div id="share-buttons" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
    <button class="btn-rel" onclick="release(5)">5 min</button>
    <button class="btn-rel" onclick="release(10)">10 min</button>
    <button class="btn-rel" onclick="release(30)">30 min</button>
  </div>
  <button class="btn-resume" id="btn-resume" onclick="doResume()" style="display:none">Resume Homey now</button>

  <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
  <h2>Button Labels</h2>
  <p class="msg-info">Give friendly names to remote buttons so they appear clearly in Homey flow cards. Press a button on the remote, then type a label.</p>

  <div class="detect-box" id="lbl-detect-box">
    <div id="lbl-idle">
      <button class="btn-detect" onclick="lblStartDetect()">Press a button on the remote</button>
    </div>
    <div id="lbl-detecting" style="display:none">
      <div style="font-size:13px;color:#555;margin-bottom:8px">Waiting for button press…</div>
      <button class="btn-detect stop" onclick="lblStopDetect()">Cancel</button>
    </div>
    <div id="lbl-detected" style="display:none">
      <div class="detected-chip" id="lbl-chip"></div>
      <button style="margin-top:8px;font-size:12px;background:none;border:none;color:#888;cursor:pointer;text-decoration:underline" onclick="lblStartDetect()">Detect different button</button>
    </div>
  </div>

  <div id="lbl-form" style="display:none;margin-top:12px">
    <div class="fg">
      <label>Friendly name</label>
      <input type="text" id="lbl-name-inp" placeholder="e.g. Menu, Play, Channel Up" oninput="lblCheckSave()">
    </div>
    <button class="btn-primary" id="lbl-save-btn" onclick="lblSave()" disabled>Save label</button>
    <div id="lbl-save-msg" style="font-size:12px;color:#555;margin-top:6px;min-height:16px"></div>
  </div>

  <div id="lbl-list" style="margin-top:16px"></div>

  <details style="margin-top:24px">
    <summary>Hub device list (all)</summary>
    <div style="margin-top:8px">
      <p class="msg-info">All devices currently in the hub catalog. Use this to delete orphaned duplicates that don't appear in the WiFi devices list above.</p>
      <button class="btn-primary" style="background:#666;margin-bottom:8px" onclick="hubDevLoad()">Refresh list</button>
      <div id="hub-dev-list" style="font-size:13px"></div>
    </div>
  </details>

  <details style="margin-top:8px">
    <summary>Debug tools</summary>
    <div style="margin-top:8px">
      <h3>API test</h3>
      <p class="msg-info">Verify Homey device control independently of button bindings.</p>
      <div class="fg"><label>Device ID</label><input type="text" id="api-dev" placeholder="Paste a device ID from the device picker"></div>
      <div class="fg"><label>Capability</label><input type="text" id="api-cap" placeholder="e.g. onoff, dim, speaker_playing"></div>
      <div class="fg"><label>Value</label><input type="text" id="api-val" placeholder="true / false / 0.5"></div>
      <button class="btn-primary" style="background:#666;margin-top:0" onclick="doApiTest()">Send to device</button>
      <div id="api-result" style="font-size:12px;margin-top:8px;color:#555;min-height:16px;word-break:break-all"></div>
    </div>
  </details>
</div>

<!-- ══ Add / Edit Control overlay ═══════════════════════════ -->
<div class="overlay" id="add-ctrl-overlay">
  <div class="overlay-hdr">
    <h3 id="overlay-title">Add Control</h3>
    <button class="btn-close" onclick="closeAddControl()">×</button>
  </div>
  <div class="detect-box" id="ctrl-box">
    <div id="ctrl-idle">
      <button class="btn-detect" onclick="startDetect()">Press a button to detect</button>
    </div>
    <div id="ctrl-detecting" style="display:none">
      <div style="font-size:13px;color:#555;margin-bottom:8px">Waiting for button press…</div>
      <button class="btn-detect stop" onclick="stopDetect()">Cancel</button>
    </div>
    <div id="ctrl-detected" style="display:none">
      <div class="detected-chip" id="detected-chip"></div>
      <button style="margin-top:8px;font-size:12px;background:none;border:none;color:#888;cursor:pointer;text-decoration:underline" onclick="startDetect()">Detect different button</button>
    </div>
  </div>
  <div id="ctrl-action" style="display:none;margin-top:12px">
    <div class="fg">
      <label>Homey device</label>
      <select id="ctrl-dev" onchange="onDeviceChange()"><option value="">Loading…</option></select>
    </div>
    <div class="fg" id="ctrl-cap-wrap" style="display:none">
      <label>Action</label>
      <select id="ctrl-cap" onchange="onCapChange()"></select>
    </div>
    <div id="ctrl-val-wrap" style="display:none">
      <div class="fg" id="ctrl-val-inner"></div>
    </div>
    <div class="fg">
      <label>Homey local API token</label>
      <input type="password" id="token-inp" placeholder="Homey → Settings → Local API → New Token" oninput="saveToken();loadHomeyDevices();">
      <div style="font-size:11px;color:#aaa;margin-top:3px">Required to list Homey devices.</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:10px 0 4px">
      <label style="font-weight:400;font-size:13px;margin:0;color:#555">Create Homey flow</label>
      <select id="sel-flow" style="font-size:13px;padding:2px 4px;border:1px solid #ccc;border-radius:4px;background:#fff">
        <option value="none">None</option>
        <option value="basic">Basic (editable in app)</option>
        <option value="advanced">Advanced (web only)</option>
      </select>
    </div>
    <button class="btn-primary" id="btn-save" onclick="saveBinding()" disabled>Save control</button>
    <div id="save-msg" style="font-size:12px;color:#555;margin-top:6px;min-height:16px"></div>
  </div>
</div>

<script>
var detectPoll=null;
var detectedButton=null;
var homeyDevices=[];
var homeyDeviceUUID='';
var hubReady=false;
var editingBindingId=null;
var wifiDevices=[];
var allBindings=[];
var expandedDevice=null;
var _pauseTimer=null;

function esc(s){var d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML;}

// ── Tabs ────────────────────────────────────────────────
function showTab(name){
  ['devices','config'].forEach(function(t){
    document.getElementById('tab-'+t).classList.toggle('active',t===name);
    document.getElementById('tab-btn-'+t).classList.toggle('active',t===name);
  });
}

// ── Collapsible (Add WiFi Device) ─────────────────────────────
function toggleSection(id){
  var body=document.getElementById(id+'-body');
  var arrow=document.getElementById(id+'-arrow');
  var open=body.classList.toggle('open');
  arrow.textContent=open?'▼':'▶';
  if(id==='add-dev'&&open){
    if(!document.querySelectorAll('#cmd-list .cmd-row').length) addCmd();
    setTimeout(function(){document.getElementById('dname').focus();},50);
  }
}

// ── Device expand/collapse ───────────────────────────────────
function toggleDevice(name){
  expandedDevice=(expandedDevice===name)?null:name;
  renderDevices();
}

// ── Data loading ────────────────────────────────────────────
function loadData(){
  fetch('/manage/data').then(function(r){return r.json();}).then(function(d){
    if(d.homeyLocalToken) applyServerToken(d.homeyLocalToken);
    if(d.homeyDeviceUUID) homeyDeviceUUID=d.homeyDeviceUUID;
    document.getElementById('hub-name').textContent=d.hubName||'SofaBaton X2';
    var sub=document.getElementById('hub-sub');
    var dot=document.getElementById('hub-dot');
    if(!d.connected){
      sub.textContent='Hub not connected — waiting for X2…';sub.style.color='#c62828';dot.className='dot off';
      hubReady=false;
    }else if(!d.ready){
      sub.textContent='Hub connected, waiting for catalog…';sub.style.color='#e65100';dot.className='dot off';
      hubReady=false;setTimeout(loadData,3000);
    }else{
      sub.textContent='Hub ready';sub.style.color='#2e7d32';dot.className='dot on';
      hubReady=true;
    }
    checkCreate();
    updateShareSection(d);
    wifiDevices=d.wifiDevices||[];
    renderDevices();
  }).catch(function(){
    document.getElementById('hub-sub').textContent='Cannot reach app — is SofaBaton installed and running?';
    document.getElementById('hub-sub').style.color='#c62828';
  });
}

var statePollTimer=null;
function loadBindings(){
  fetch('/manage/bindings').then(function(r){return r.json();}).then(function(list){
    allBindings=list||[];
    renderDevices();
    clearInterval(statePollTimer);
    loadDeviceStates();
    statePollTimer=setInterval(loadDeviceStates,8000);
  }).catch(function(){});
}
function loadDeviceStates(){
  var tok=loadToken();if(!tok) return;
  var ids=[...new Set(allBindings.map(function(b){return b.homeyDeviceId;}).filter(Boolean))];
  if(!ids.length) return;
  fetch('/manage/device-states?token='+encodeURIComponent(tok)+'&ids='+ids.join(','))
    .then(function(r){return r.json();})
    .then(function(states){
      document.querySelectorAll('[id^="bstate-"]').forEach(function(el){
        var devId=el.dataset.dev,cap=el.dataset.cap;
        if(!devId||!cap||!states[devId]) return;
        var val=states[devId][cap];
        if(val===undefined||val===null){el.textContent='';return;}
        var label,color;
        if(typeof val==='boolean'){label=val?'● on':'○ off';color=val?'#2e7d32':'#9e9e9e';}
        else if(typeof val==='number'){label='▸ '+(val<=1&&val>=0?Math.round(val*100)+'%':val);color='#555';}
        else{label='▸ '+String(val);color='#555';}
        el.textContent=label;el.style.color=color;
      });
    }).catch(function(){});
}

// ── Render device cards ───────────────────────────────────────
function renderDevices(){
  var el=document.getElementById('device-list');
  if(!wifiDevices.length){
    el.innerHTML='<span class="empty">No WiFi devices yet — use Add WiFi Device below.</span>';
    return;
  }
  el.innerHTML=wifiDevices.map(function(w){
    var wBindings=allBindings.filter(function(b){return b.sofaDeviceName===w.name;});
    var isExp=expandedDevice===w.name;
    var safeName=w.name.replace(/[^a-z0-9]/gi,'_');
    var badge=w.inHub
      ?'<span style="font-size:11px;color:#888;margin-left:6px">ID '+w.id+'</span>'
      :'<span style="font-size:11px;color:#c62828;margin-left:6px">✗ not in hub</span>';
    var out='<div class="card">';
    out+='<div class="dev-hdr" onclick=\\'toggleDevice('+JSON.stringify(w.name)+')\\'>';
    out+='<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">';
    out+='<span style="font-size:11px;color:#aaa;flex-shrink:0">'+(isExp?'▼':'▶')+'</span>';
    out+='<div style="flex:1;min-width:0">';
    out+='<div class="card-name">'+esc(w.name)+badge+'</div>';
    out+='<div class="card-sub">'+esc((w.commands||[]).join(', ')||'—')+' · '+wBindings.length+' control'+(wBindings.length!==1?'s':'')+'</div>';
    out+='</div></div>';
    out+='<div style="display:flex;gap:5px;flex-shrink:0" onclick="event.stopPropagation()">';
    out+='<button class="btn-x" onclick=\\'reRegisterDevice('+JSON.stringify(w.name)+','+JSON.stringify(w.commands)+')\\'>Fix</button>';
    out+='<button class="btn-warn" onclick=\\'deleteWifiDevice('+JSON.stringify(w.name)+')\\'>Del</button>';
    out+='</div></div>';
    out+='<div id="wr-'+safeName+'" style="font-size:11px;color:#2e7d32;min-height:0;padding:0"></div>';
    if(isExp){
      out+='<div class="dev-body">';
      if(wBindings.length){
        // Group bindings by button (keyId + sofaDeviceName)
        var groups=[],groupMap={};
        wBindings.forEach(function(b){
          var gk=String(b.keyId)+'|'+(b.sofaDeviceName||'');
          if(groupMap[gk]==null){groupMap[gk]=groups.length;groups.push({keyId:b.keyId,sofaDeviceId:b.sofaDeviceId,buttonName:b.buttonName||('Key '+b.keyId),sofaDeviceName:b.sofaDeviceName,actions:[]});}
          groups[groupMap[gk]].actions.push(b);
        });
        out+=groups.map(function(g){
          var aHtml=g.actions.map(function(b){
            return '<div class="binding-row" style="padding-left:10px;border-left:3px solid #e8f5e9;margin-left:4px">'+
              '<div style="flex:1;min-width:0;font-size:12px;color:#555">'+esc(b.homeyDeviceName)+' · '+esc(b.capabilityTitle)+' = <code style="background:#f0f0f0;border-radius:3px;padding:1px 4px">'+esc(b.value==='__toggle__'?'toggle':String(b.value))+'</code>'+
              ' <span id="bstate-'+esc(b.id)+'" data-dev="'+esc(b.homeyDeviceId)+'" data-cap="'+esc(b.capability)+'" style="font-size:11px;color:#888;margin-left:4px"></span></div>'+
              '<div style="display:flex;gap:4px;flex-shrink:0">'+
                '<button class="btn-x" onclick=\\'testBinding('+JSON.stringify(b.id)+',this)\\'>Test</button>'+
                '<button class="btn-x" onclick=\\'editBinding('+JSON.stringify(b.id)+')\\'>Edit</button>'+
                '<button class="btn-warn" onclick=\\'deleteBinding('+JSON.stringify(b.id)+')\\'>Del</button>'+
              '</div>'+
            '</div>';
          }).join('');
          return '<div style="margin-bottom:10px">'+
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'+
              '<span style="font-weight:600;font-size:13px;flex:1;min-width:0">'+esc(g.buttonName)+'</span>'+
              '<button class="btn-x" style="font-size:11px;padding:2px 7px" onclick=\\'addActionForButton('+g.keyId+','+JSON.stringify(g.sofaDeviceId)+','+JSON.stringify(g.buttonName)+','+JSON.stringify(g.sofaDeviceName)+')\\'">+ Action</button>'+
            '</div>'+
            aHtml+
          '</div>';
        }).join('');
      }else{
        out+='<div class="empty">No controls yet.</div>';
      }
      out+='<button class="btn-add" onclick=\\'openAddControl('+JSON.stringify(w.name)+')\\'>+ Add Control</button>';
      out+='</div>';
    }
    out+='</div>';
    return out;
  }).join('');
}

// ── WiFi device CRUD ──────────────────────────────────────────
function reRegisterDevice(name,commands){
  var key='wr-'+name.replace(/[^a-z0-9]/gi,'_');
  var el=document.getElementById(key);if(el) el.textContent='Registering…';
  fetch('/manage/wifi-device/re-register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,commands:commands})})
  .then(function(r){return r.json();})
  .then(function(r){if(el) el.textContent=r.ok?'✓ Callback URL updated':'✗ '+r.error;if(r.ok)setTimeout(loadData,2000);})
  .catch(function(e){if(el) el.textContent='✗ '+e.message;});
}
function deleteWifiDevice(name){
  if(!confirm('Delete WiFi device "'+name+'"?')) return;
  fetch('/manage/wifi-device/'+encodeURIComponent(name),{method:'DELETE'})
  .then(function(){if(expandedDevice===name)expandedDevice=null;loadData();}).catch(function(e){alert('Error: '+e.message);});
}
function addCmd(){
  var rows=document.querySelectorAll('#cmd-list .cmd-row');
  if(rows.length>=10) return;
  var row=document.createElement('div');row.className='cmd-row';
  var inp=document.createElement('input');inp.type='text';inp.placeholder='Command name (e.g. On)';inp.maxLength=29;
  inp.addEventListener('input',checkCreate);
  var btn=document.createElement('button');btn.className='btn-x';btn.textContent='×';
  btn.onclick=function(){row.remove();checkCreate();};
  row.appendChild(inp);row.appendChild(btn);
  document.getElementById('cmd-list').appendChild(row);inp.focus();
}
function checkCreate(){
  var name=document.getElementById('dname').value.trim();
  var cmds=Array.from(document.querySelectorAll('#cmd-list .cmd-row input')).filter(function(i){return i.value.trim();});
  document.getElementById('btn-create').disabled=!(name&&cmds.length&&hubReady);
}
function showCreateBanner(msg,isErr){
  var el=document.getElementById('create-banner');el.textContent=msg;el.className=isErr?'msg-err':'msg-ok';el.style.display='';
}
function doCreate(){
  var name=document.getElementById('dname').value.trim();
  var commands=Array.from(document.querySelectorAll('#cmd-list .cmd-row input')).map(function(i){return i.value.trim();}).filter(Boolean);
  if(!name){showCreateBanner('Device name is required.',true);return;}
  if(!commands.length){showCreateBanner('Add at least one command.',true);return;}
  var btn=document.getElementById('btn-create');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>Creating…';
  document.getElementById('create-banner').style.display='none';
  fetch('/manage/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,commands:commands})})
    .then(function(r){return r.json();})
    .then(function(r){
      btn.disabled=false;btn.textContent='Create on X2';
      if(r.ok){
        showCreateBanner('Created "'+esc(r.result.name)+'" — tap it to add controls.',false);
        document.getElementById('dname').value='';
        document.getElementById('cmd-list').innerHTML='';addCmd();
        expandedDevice=r.result.name;
        loadData();
      }else{showCreateBanner('Failed: '+esc(r.error||'unknown'),true);}
    })
    .catch(function(e){btn.disabled=false;btn.textContent='Create on X2';showCreateBanner('Network error: '+e.message,true);});
}

// ── Add Control overlay ──────────────────────────────────────
function openAddControl(devName){
  editingBindingId=null;
  detectedButton=null;
  clearInterval(detectPoll);detectPoll=null;
  document.getElementById('ctrl-box').classList.remove('active');
  document.getElementById('ctrl-idle').style.display='';
  document.getElementById('ctrl-detecting').style.display='none';
  document.getElementById('ctrl-detected').style.display='none';
  document.getElementById('ctrl-action').style.display='none';
  document.getElementById('ctrl-cap-wrap').style.display='none';
  document.getElementById('ctrl-val-wrap').style.display='none';
  document.getElementById('overlay-title').textContent='Add Control — '+devName;
  document.getElementById('btn-save').textContent='Save control';
  document.getElementById('save-msg').textContent='';
  var tok=loadToken();if(tok) document.getElementById('token-inp').value=tok;
  document.getElementById('add-ctrl-overlay').classList.add('open');
}
function closeAddControl(){
  clearInterval(detectPoll);detectPoll=null;
  document.getElementById('add-ctrl-overlay').classList.remove('open');
  editingBindingId=null;
}
function addActionForButton(keyId,sofaDeviceId,buttonName,sofaDeviceName){
  editingBindingId=null;
  detectedButton={keyId:keyId,sofaDeviceId:sofaDeviceId,button:buttonName,deviceName:sofaDeviceName};
  clearInterval(detectPoll);detectPoll=null;
  document.getElementById('ctrl-box').classList.remove('active');
  document.getElementById('ctrl-idle').style.display='none';
  document.getElementById('ctrl-detecting').style.display='none';
  document.getElementById('ctrl-detected').style.display='';
  document.getElementById('detected-chip').innerHTML=
    '<b>'+esc(buttonName)+'</b><span style="font-size:11px;color:#888;margin-left:8px">'+esc(sofaDeviceName)+' · key '+keyId+'</span>';
  var devSel=document.getElementById('ctrl-dev');if(devSel) devSel.value='';
  document.getElementById('ctrl-cap-wrap').style.display='none';
  document.getElementById('ctrl-val-wrap').style.display='none';
  document.getElementById('overlay-title').textContent='Add Action — '+buttonName;
  document.getElementById('btn-save').textContent='Save control';
  document.getElementById('save-msg').textContent='';
  var tok=loadToken();if(tok) document.getElementById('token-inp').value=tok;
  document.getElementById('add-ctrl-overlay').classList.add('open');
  if(!homeyDevices.length) loadHomeyDevices();
  renderAction();
}

// ── Proxy control ───────────────────────────────────────────────
function updateShareSection(d){
  var now=Date.now(),until=d.pausedUntil||0,paused=until>now;
  var btns=document.getElementById('share-buttons');
  var act=document.getElementById('share-active');
  var resume=document.getElementById('btn-resume');
  if(paused){
    var secs=Math.round((until-now)/1000),m=Math.floor(secs/60),s=secs%60;
    act.textContent='Hub released — SofaBaton app can connect. Homey resumes in '+m+'m '+s+'s.';
    act.style.display='';btns.style.display='none';resume.style.display='';
    if(!_pauseTimer)_pauseTimer=setInterval(function(){
      fetch('/manage/data').then(function(r){return r.json();}).then(function(d2){
        if(!(d2.pausedUntil>Date.now())){clearInterval(_pauseTimer);_pauseTimer=null;loadData();}
        else updateShareSection(d2);
      }).catch(function(){});
    },5000);
  }else{
    act.style.display='none';btns.style.display='flex';resume.style.display='none';
    if(_pauseTimer){clearInterval(_pauseTimer);_pauseTimer=null;}
  }
  if(d.debug&&d.debug.proxyUdpPort){
    var el=document.getElementById('proxy-ip');
    if(el) el.textContent=window.location.hostname+' (this Homey)';
  }
}
function release(minutes){
  fetch('/manage/release',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:minutes})})
    .then(function(r){return r.json();})
    .then(function(d){if(d.ok)loadData();})
    .catch(function(e){alert('Error: '+e.message);});
}
function doResume(){
  fetch('/manage/resume',{method:'POST'}).then(function(r){return r.json();}).then(function(d){if(d.ok)loadData();})
    .catch(function(e){alert('Error: '+e.message);});
}

// ── API test ──────────────────────────────────────────────────────
function doApiTest(){
  var devId=document.getElementById('api-dev').value.trim();
  var cap=document.getElementById('api-cap').value.trim();
  var rawVal=document.getElementById('api-val').value.trim();
  var res=document.getElementById('api-result');
  if(!devId||!cap||rawVal===''){res.textContent='Fill all fields';return;}
  var value=rawVal==='true'?true:rawVal==='false'?false:(!isNaN(rawVal)?parseFloat(rawVal):rawVal);
  res.textContent='Sending…';
  var tok=loadToken();
  fetch('/manage/api-test',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({deviceId:devId,capability:cap,value:value,token:tok})})
  .then(function(r){return r.json();})
  .then(function(r){res.textContent=(r.ok?'✓ OK: ':'✗ Error: ')+JSON.stringify(r);})
  .catch(function(e){res.textContent='Fetch error: '+e.message;});
}

// ── Button detection ────────────────────────────────────────────
function startDetect(){
  document.getElementById('ctrl-box').classList.add('active');
  document.getElementById('ctrl-idle').style.display='none';
  document.getElementById('ctrl-detecting').style.display='';
  document.getElementById('ctrl-detected').style.display='none';
  detectedButton=null;
  document.getElementById('ctrl-action').style.display='none';
  fetch('/manage/clear-press',{method:'POST'});
  detectPoll=setInterval(pollPress,600);
}
function stopDetect(){
  clearInterval(detectPoll);detectPoll=null;
  document.getElementById('ctrl-box').classList.remove('active');
  document.getElementById('ctrl-idle').style.display='';
  document.getElementById('ctrl-detecting').style.display='none';
}
function pollPress(){
  fetch('/manage/last-press').then(function(r){return r.json();}).then(function(d){
    if(d.keyId==null) return;
    clearInterval(detectPoll);detectPoll=null;
    detectedButton=d;
    document.getElementById('ctrl-box').classList.remove('active');
    document.getElementById('ctrl-detecting').style.display='none';
    document.getElementById('ctrl-detected').style.display='';
    document.getElementById('detected-chip').innerHTML=
      '<b>'+esc(d.button)+'</b><span style="font-size:11px;color:#888;margin-left:8px">'+esc(d.deviceName)+' · key '+d.keyId+'</span>';
    if(!homeyDevices.length) loadHomeyDevices();
    renderAction();
  }).catch(function(){});
}

// ── Homey devices ───────────────────────────────────────────────
function loadHomeyDevices(){
  var tok=loadToken();
  var sel=document.getElementById('ctrl-dev');
  if(!tok){sel.innerHTML='<option value="">— Paste token below —</option>';return;}
  sel.innerHTML='<option value="">Loading…</option>';
  fetch('/manage/homey-devices?token='+encodeURIComponent(tok)).then(function(r){return r.json();}).then(function(list){
    homeyDevices=list||[];
    sel.innerHTML='<option value="">— Pick a device —</option>';
    if(!homeyDevices.length){sel.innerHTML='<option value="">— No devices (check token) —</option>';}
    else{homeyDevices.forEach(function(d){var o=document.createElement('option');o.value=d.id;o.textContent=d.name;sel.appendChild(o);});}
    renderAction();
  }).catch(function(){sel.innerHTML='<option value="">— API error —</option>';});
}
function renderAction(){
  var show=!!detectedButton;
  document.getElementById('ctrl-action').style.display=show?'':'none';
  if(show&&!homeyDevices.length) loadHomeyDevices();
  checkSave();
}
function onDeviceChange(){
  var devId=document.getElementById('ctrl-dev').value;
  var apiDevEl=document.getElementById('api-dev');if(apiDevEl&&devId) apiDevEl.value=devId;
  var capSel=document.getElementById('ctrl-cap');capSel.innerHTML='';
  document.getElementById('ctrl-cap-wrap').style.display='none';
  document.getElementById('ctrl-val-wrap').style.display='none';
  if(!devId){checkSave();return;}
  var dev=homeyDevices.find(function(d){return d.id===devId;});
  if(!dev){checkSave();return;}
  var writable=(dev.capabilities||[]).filter(function(c){return c.setable!==false;});
  if(!writable.length){checkSave();return;}
  writable.forEach(function(c){var o=document.createElement('option');o.value=c.id;o.textContent=c.title||c.id;capSel.appendChild(o);});
  document.getElementById('ctrl-cap-wrap').style.display='';
  onCapChange();
}
function capDisplayLabel(cap,val){
  if(cap.units) return val+' '+cap.units;
  if(cap.max===1&&cap.min===0) return Math.round(val*100)+'%';
  return String(val);
}
function onCapChange(){
  var devId=document.getElementById('ctrl-dev').value;
  var capId=document.getElementById('ctrl-cap').value;
  var inner=document.getElementById('ctrl-val-inner');inner.innerHTML='';
  document.getElementById('ctrl-val-wrap').style.display='none';
  if(!capId){checkSave();return;}
  var dev=homeyDevices.find(function(d){return d.id===devId;});
  var cap=dev&&(dev.capabilities||[]).find(function(c){return c.id===capId;});
  if(!cap){checkSave();return;}
  var html='<label>Value</label>';
  if(cap.type==='boolean'){
    html+='<select id="ctrl-val"><option value="true">On / True</option><option value="false">Off / False</option><option value="__toggle__">Toggle (flip current state)</option></select>';
    inner.innerHTML=html;
    document.getElementById('ctrl-val').addEventListener('change',checkSave);
  } else if(cap.type==='enum'&&cap.values&&cap.values.length){
    html+='<select id="ctrl-val">';
    cap.values.forEach(function(v){html+='<option value="'+esc(v.id)+'">'+esc(v.title||v.id)+'</option>';});
    html+='</select>';
    inner.innerHTML=html;
    document.getElementById('ctrl-val').addEventListener('change',checkSave);
  } else if(cap.type==='number'&&cap.min!=null&&cap.max!=null){
    var step=cap.step||0.01;
    var mid=cap.min+(cap.max-cap.min)/2;
    var initVal=parseFloat(mid.toFixed(4));
    html+='<div style="display:flex;align-items:center;gap:8px">'
      +'<input type="range" id="ctrl-val" min="'+cap.min+'" max="'+cap.max+'" step="'+step+'" value="'+initVal+'" style="flex:1;accent-color:#1976d2">'
      +'<span id="ctrl-val-lbl" style="min-width:52px;text-align:right;font-size:13px;color:#333">'+capDisplayLabel(cap,initVal)+'</span>'
      +'</div>';
    inner.innerHTML=html;
    var slider=document.getElementById('ctrl-val');
    var lbl=document.getElementById('ctrl-val-lbl');
    slider.addEventListener('input',function(){
      lbl.textContent=capDisplayLabel(cap,parseFloat(slider.value));
      checkSave();
    });
  } else if(cap.type==='number'){
    html+='<input type="number" id="ctrl-val" placeholder="e.g. 0.5" step="any">';
    inner.innerHTML=html;
    document.getElementById('ctrl-val').addEventListener('input',checkSave);
  } else {
    html+='<input type="text" id="ctrl-val" placeholder="Value">';
    inner.innerHTML=html;
    document.getElementById('ctrl-val').addEventListener('input',checkSave);
  }
  document.getElementById('ctrl-val-wrap').style.display='';
  checkSave();
}
function checkSave(){
  var ok=!!(detectedButton&&
    document.getElementById('ctrl-dev')&&document.getElementById('ctrl-dev').value&&
    document.getElementById('ctrl-cap')&&document.getElementById('ctrl-cap').value&&
    document.getElementById('ctrl-val')&&document.getElementById('ctrl-val').value!=='');
  var btn=document.getElementById('btn-save');if(btn) btn.disabled=!ok;
}

// ── Save binding ────────────────────────────────────────────────
function saveBinding(){
  var devId=document.getElementById('ctrl-dev').value;
  var capId=document.getElementById('ctrl-cap').value;
  var valEl=document.getElementById('ctrl-val');
  var rawVal=valEl?valEl.value:'';
  var msg=document.getElementById('save-msg');
  if(!detectedButton||!devId||!capId||rawVal==='') return;
  var dev=homeyDevices.find(function(d){return d.id===devId;});
  var capDef=dev&&(dev.capabilities||[]).find(function(c){return c.id===capId;});
  var value=rawVal;
  if(rawVal==='__toggle__') value='__toggle__';
  else if(capDef&&capDef.type==='boolean') value=(rawVal==='true');
  else if(capDef&&capDef.type==='number') value=parseFloat(rawVal);
  var binding={
    keyId:detectedButton.keyId,sofaDeviceId:detectedButton.sofaDeviceId,
    buttonName:detectedButton.button,sofaDeviceName:detectedButton.deviceName,
    homeyDeviceId:devId,homeyDeviceName:(dev&&dev.name)||devId,
    capability:capId,capabilityTitle:(capDef&&capDef.title)||capId,value:value,
  };
  if(editingBindingId) binding.id=editingBindingId;
  msg.textContent='Saving…';
  var tok=loadToken();
  if(tok) fetch('/manage/save-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:tok})}).catch(function(){});
  fetch('/manage/bindings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(binding)})
    .then(function(r){return r.json();})
    .then(function(saved){
      if(saved.id) binding.id=saved.id;
      msg.textContent=editingBindingId?'Updated!':'Saved!';
      var wasEditing=!!editingBindingId;
      editingBindingId=null;
      document.getElementById('btn-save').textContent='Save control';
      expandedDevice=binding.sofaDeviceName;
      loadBindings();
      var flowType=document.getElementById('sel-flow').value;
      if(flowType!=='none'){
        var token=document.getElementById('token-inp').value.trim();
        if(!token){msg.textContent='Saved (no token — flow skipped)';return;}
        return fetch('/manage/create-flow',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({binding:binding,token:token,sofaDeviceHomeyId:homeyDeviceUUID,flowType:flowType})
        }).then(function(r){return r.json();}).then(function(fr){
          if(fr.ok){msg.textContent='Saved + flow created ('+fr.via+')'+(fr.actionNote?' — no Then action (add manually in Homey)':(fr.actionCardId?' + Then: '+fr.actionCardId.split(':').pop():''))+'!';}
          else{msg.textContent='Saved (flow error: '+(fr.error||'?')+')';}
        });
      }
    })
    .catch(function(e){msg.textContent='Error: '+e.message;});
}

// ── Binding actions ───────────────────────────────────────────────
function testBinding(id,btn){
  var orig=btn.textContent;btn.textContent='…';btn.disabled=true;
  fetch('/manage/test-binding/'+encodeURIComponent(id),{method:'POST'})
    .then(function(r){return r.json();})
    .then(function(r){btn.textContent=r.ok?'✓':'✗';btn.title=JSON.stringify(r);setTimeout(function(){btn.textContent=orig;btn.disabled=false;},3000);})
    .catch(function(){btn.textContent='err';btn.disabled=false;});
}
function deleteBinding(id){
  fetch('/manage/bindings/'+encodeURIComponent(id),{method:'DELETE'})
    .then(function(){loadBindings();}).catch(function(e){alert('Error: '+e.message);});
}
function editBinding(id){
  fetch('/manage/bindings').then(function(r){return r.json();}).then(function(list){
    var b=list.find(function(x){return x.id===id;});
    if(!b){alert('Binding not found');return;}
    expandedDevice=b.sofaDeviceName;
    renderDevices();
    editingBindingId=b.id;
    detectedButton={keyId:b.keyId,sofaDeviceId:b.sofaDeviceId,button:b.buttonName,deviceName:b.sofaDeviceName};
    clearInterval(detectPoll);detectPoll=null;
    document.getElementById('ctrl-box').classList.remove('active');
    document.getElementById('ctrl-idle').style.display='none';
    document.getElementById('ctrl-detecting').style.display='none';
    document.getElementById('ctrl-detected').style.display='';
    document.getElementById('detected-chip').innerHTML=
      '<b>'+esc(b.buttonName)+'</b><span style="font-size:11px;color:#888;margin-left:8px">'+esc(b.sofaDeviceName)+' · key '+b.keyId+'</span>';
    document.getElementById('overlay-title').textContent='Edit Control — '+b.sofaDeviceName;
    document.getElementById('btn-save').textContent='Update control';
    document.getElementById('save-msg').textContent='';
    var tok=loadToken();if(tok) document.getElementById('token-inp').value=tok;
    document.getElementById('add-ctrl-overlay').classList.add('open');
    if(!tok){renderAction();return;}
    fetch('/manage/homey-devices?token='+encodeURIComponent(tok)).then(function(r){return r.json();}).then(function(devs){
      homeyDevices=devs||[];
      var sel=document.getElementById('ctrl-dev');
      sel.innerHTML='<option value="">— Pick a device —</option>';
      homeyDevices.forEach(function(d){var o=document.createElement('option');o.value=d.id;o.textContent=d.name;sel.appendChild(o);});
      sel.value=b.homeyDeviceId;
      renderAction();onDeviceChange();
      setTimeout(function(){
        var capSel=document.getElementById('ctrl-cap');if(capSel) capSel.value=b.capability;
        onCapChange();
        setTimeout(function(){
          var vi=document.getElementById('ctrl-val');
          if(!vi) return checkSave();
          vi.value=String(b.value);
          // Sync slider display label if present
          var lbl=document.getElementById('ctrl-val-lbl');
          if(lbl&&vi.type==='range'){
            var dev2=homeyDevices.find(function(d){return d.id===b.homeyDeviceId;});
            var cap2=dev2&&(dev2.capabilities||[]).find(function(c){return c.id===b.capability;});
            if(cap2) lbl.textContent=capDisplayLabel(cap2,parseFloat(vi.value));
          }
          checkSave();
        },50);
      },50);
    }).catch(function(){renderAction();});
  });
}

// ── Hub device list ──────────────────────────────────────────────
function hubDevLoad(){
  var el=document.getElementById('hub-dev-list');
  el.textContent='Loading…';
  fetch('/manage/data').then(function(r){return r.json();}).then(function(d){
    var devs=(d.debug&&d.debug.deviceList)||[];
    if(!devs.length){el.innerHTML='<span style="color:#aaa">No devices in hub catalog.</span>';return;}
    el.innerHTML='<table style="width:100%;border-collapse:collapse">'
      +devs.map(function(dev){
        return '<tr style="border-bottom:1px solid #eee">'
          +'<td style="padding:6px 4px;font-weight:600">'+esc(dev.name)+'</td>'
          +'<td style="padding:6px 4px;color:#888;font-size:12px">ID '+dev.id+(dev.type!=null?' type='+dev.type:'')+'</td>'
          +'<td style="padding:6px 4px;text-align:right"><button onclick="hubDevDelete('+dev.id+','+JSON.stringify(dev.name)+')" class="btn-warn" style="font-size:11px;padding:2px 8px">Delete</button></td>'
          +'</tr>';
      }).join('')
      +'</table>';
  }).catch(function(e){el.textContent='Error: '+e.message;});
}
function hubDevDelete(id,name){
  if(!confirm('Delete "'+name+'" (ID '+id+') from the hub? This cannot be undone.')) return;
  fetch('/manage/wifi-device-by-id/'+id,{method:'DELETE'})
    .then(function(r){return r.json();})
    .then(function(r){
      if(r.ok){hubDevLoad();}
      else{alert('Delete failed: '+(r.error||'unknown'));}
    }).catch(function(e){alert('Error: '+e.message);});
}

// ── Token ─────────────────────────────────────────────────────────
function loadToken(){return localStorage.getItem('homey_token')||'';}
function saveToken(){
  var tok=document.getElementById('token-inp').value;
  localStorage.setItem('homey_token',tok);
  if(tok) fetch('/manage/save-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:tok})}).catch(function(){});
}
function applyServerToken(tok){
  if(tok&&!loadToken()){localStorage.setItem('homey_token',tok);document.getElementById('token-inp').value=tok;loadHomeyDevices();}
}

// ── Init ─────────────────────────────────────────────────────────────
(function(){var t=loadToken();if(t){document.getElementById('token-inp').value=t;loadHomeyDevices();}})();
loadData();
loadBindings();
loadButtonLabels();

// ── Button Labels ────────────────────────────────────────────────────
var lblDetectPoll=null;
var lblDetectedButton=null;
var allButtonLabels={};

function loadButtonLabels(){
  fetch('/manage/button-labels').then(function(r){return r.json();}).then(function(d){
    allButtonLabels=d.labels||{};
    renderLblList();
  }).catch(function(){});
}

function lblStartDetect(){
  document.getElementById('lbl-detect-box').classList.add('active');
  document.getElementById('lbl-idle').style.display='none';
  document.getElementById('lbl-detecting').style.display='';
  document.getElementById('lbl-detected').style.display='none';
  document.getElementById('lbl-form').style.display='none';
  lblDetectedButton=null;
  fetch('/manage/clear-press',{method:'POST'});
  lblDetectPoll=setInterval(lblPollPress,600);
}
function lblStopDetect(){
  clearInterval(lblDetectPoll);lblDetectPoll=null;
  document.getElementById('lbl-detect-box').classList.remove('active');
  document.getElementById('lbl-idle').style.display='';
  document.getElementById('lbl-detecting').style.display='none';
}
function lblPollPress(){
  fetch('/manage/last-press').then(function(r){return r.json();}).then(function(d){
    if(d.keyId==null) return;
    clearInterval(lblDetectPoll);lblDetectPoll=null;
    lblDetectedButton=d;
    document.getElementById('lbl-detect-box').classList.remove('active');
    document.getElementById('lbl-detecting').style.display='none';
    document.getElementById('lbl-detected').style.display='';
    var key=d.sofaDeviceId+':'+d.keyId;
    var existingLabel=allButtonLabels[key]||'';
    document.getElementById('lbl-chip').innerHTML=
      '<b>'+esc(d.rawLabel||d.button)+'</b><span style="font-size:11px;color:#888;margin-left:8px">'+esc(d.deviceName)+'</span>';
    document.getElementById('lbl-form').style.display='';
    var inp=document.getElementById('lbl-name-inp');
    inp.value=existingLabel;
    inp.placeholder='e.g. Menu, Play, Channel Up';
    inp.focus();
    lblCheckSave();
  }).catch(function(){});
}
function lblCheckSave(){
  var ok=!!(lblDetectedButton&&document.getElementById('lbl-name-inp').value.trim());
  document.getElementById('lbl-save-btn').disabled=!ok;
}
function lblSave(){
  if(!lblDetectedButton) return;
  var label=document.getElementById('lbl-name-inp').value.trim();
  var msg=document.getElementById('lbl-save-msg');
  msg.textContent='Saving…';
  fetch('/manage/button-labels',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({deviceId:lblDetectedButton.sofaDeviceId,cmdId:lblDetectedButton.keyId,label:label})})
  .then(function(r){return r.json();})
  .then(function(r){
    if(r.ok){
      var key=lblDetectedButton.sofaDeviceId+':'+lblDetectedButton.keyId;
      allButtonLabels[key]=label;
      msg.textContent='✓ Saved';
      lblDetectedButton=null;
      document.getElementById('lbl-detect-box').classList.remove('active');
      document.getElementById('lbl-idle').style.display='';
      document.getElementById('lbl-detected').style.display='none';
      document.getElementById('lbl-form').style.display='none';
      renderLblList();
    } else {
      msg.textContent='Error: '+(r.error||'unknown');
    }
  }).catch(function(e){msg.textContent='Fetch error: '+e.message;});
}
function lblDelete(deviceId,cmdId){
  var key=deviceId+':'+cmdId;
  fetch('/manage/button-labels',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({deviceId:deviceId,cmdId:cmdId,label:''})})
  .then(function(r){return r.json();})
  .then(function(r){
    if(r.ok){delete allButtonLabels[key];renderLblList();}
  }).catch(function(){});
}
function renderLblList(){
  var el=document.getElementById('lbl-list');
  var keys=Object.keys(allButtonLabels);
  if(!keys.length){el.innerHTML='<p style="font-size:13px;color:#aaa;margin:8px 0">No labels saved yet.</p>';return;}
  var rows=keys.map(function(k){
    var parts=k.split(':');
    var devId=parts[0], cmdId=parts[1];
    var label=allButtonLabels[k];
    return '<tr>'
      +'<td style="padding:6px 8px;font-size:13px">'+esc(label)+'</td>'
      +'<td style="padding:6px 8px;font-size:12px;color:#888">device '+esc(devId)+' · cmd '+esc(cmdId)+'</td>'
      +'<td style="padding:6px 8px"><button onclick="lblDelete('+esc(devId)+','+esc(cmdId)+')" style="font-size:11px;background:none;border:1px solid #ccc;border-radius:4px;cursor:pointer;padding:2px 7px;color:#c00">×</button></td>'
      +'</tr>';
  }).join('');
  el.innerHTML='<table style="width:100%;border-collapse:collapse">'+rows+'</table>';
}
</script>
</body>
</html>`;
}


// ---------------------------------------------------------------------------
// Homey Device
// ---------------------------------------------------------------------------
class SofaBatonDevice extends Homey.Device {

  async onInit() {
    const ip = this.getSetting('ip') || this.getData().id;
    if (!ip) throw new Error('No SofaBaton IP configured');

    // Flow trigger cards
    this.buttonTrigger   = this.homey.flow.getDeviceTriggerCard('button_pressed');
    this.activityTrigger = this.homey.flow.getDeviceTriggerCard('activity_changed');

    // HTTP callback server — receives X2 WiFi-device button events
    this.homey.log('onInit: starting HTTP server');
    await this._startHttpServer();
    this.homey.log(`onInit: HTTP server ready on port ${this._callbackPort}`);

    this.sofaBaton = new SofaBatonClient(this.homey, ip, {
      mqtt: {
        host: this.getSetting('mqtt_host'),
        port: this.getSetting('mqtt_port') || 1883,
        username: this.getSetting('mqtt_username'),
        password: this.getSetting('mqtt_password'),
      },
      onActivityChange:  (id, name) => this.handleActivityChange(id, name),
      onButtonPress:     e          => this.handleButtonPress(e),
      onConnectionChange: connected => {
        if (connected) this.setAvailable();
        else if (!this._hubPausedUntil || Date.now() >= this._hubPausedUntil) this.setUnavailable('SofaBaton disconnected');
      },
      onBannerMac: mac => {
        this.setStoreValue('banner_mac', mac).catch(() => {});
        this.setStoreValue('banner_opcode', this.sofaBaton._bannerOpcode || 0).catch(() => {});
      },
      dlog: msg => this._dlog(msg),
    });

    this._hubPausedUntil = 0;
    this._pauseTimer     = null;
    this._logBuf         = [];

    if (!this.hasCapability('app_mode'))   await this.addCapability('app_mode');
    if (!this.hasCapability('find_remote')) await this.addCapability('find_remote');
    this._bindings = new Map();
    try {
      const _bKey = 'bindings_' + (this.getData().id || 'x2');
      const savedBindings = this.homey.settings.get(_bKey);
      if (Array.isArray(savedBindings)) savedBindings.forEach(b => this._bindings.set(b.id, b));
      this._bindingsKey = _bKey;
      this.homey.log(`onInit: bindings restored (${this._bindings.size})`);
    } catch(bErr) {
      this.homey.error('onInit: bindings restore failed:', bErr.message);
      this._bindingsKey = 'bindings_' + (this.getData().id || 'x2');
    }

    this.registerCapabilityListener('app_mode', async (value) => {
      if (value) await this.releaseHub(this.getSetting('release_minutes') || 10);
      else this.resumeHub();
    });

    this.registerCapabilityListener('find_remote', async () => {
      if (!this.sofaBaton?.connected) throw new Error('SofaBaton not connected');
      await this.sofaBaton.findRemote();
    });

    this.homey.log(`onInit: starting connection to ${ip}`);
    this.setCapabilityValue('app_mode', false).catch(() => {});

    // Start mDNS proxy immediately using cached MAC so the SofaBaton app
    // always hits the proxy — even before Homey connects to the hub.
    const cachedMac    = await Promise.resolve(this.getStoreValue('banner_mac')).catch(() => null);
    const cachedOpcode = await Promise.resolve(this.getStoreValue('banner_opcode')).catch(() => null);
    if (cachedMac) {
      this.sofaBaton.bannerMac      = cachedMac;
      this.sofaBaton._bannerOpcode  = cachedOpcode || null;
      this.sofaBaton._startProxyWithMac(cachedMac).catch(e =>
        this.homey.error('Early proxy start error:', e.message));
    }

    this._connectWithRetry();
  }

  async releaseHub(minutes) {
    const ms = Math.max(1, Math.min(60, minutes || 10)) * 60000;
    this._hubPausedUntil = Date.now() + ms;
    if (this._connCheckInterval) { clearInterval(this._connCheckInterval); this._connCheckInterval = null; }
    if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
    await this.sofaBaton?.close().catch(() => {});
    this.setCapabilityValue('app_mode', true).catch(() => {});
    this.homey.log(`SOFABATON: Hub released for ${minutes} min (proxy still advertising)`);
    this._pauseTimer = setTimeout(() => {
      this._hubPausedUntil = 0;
      this._pauseTimer = null;
      this.setCapabilityValue('app_mode', false).catch(() => {});
      this.homey.log('SOFABATON: Pause expired — reconnecting');
      this._rebuildAndConnect();
    }, ms);
  }

  resumeHub() {
    if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
    this._hubPausedUntil = 0;
    this.setCapabilityValue('app_mode', false).catch(() => {});
    this.homey.log('SOFABATON: Hub resume requested — reconnecting now');
    this._rebuildAndConnect();
  }

  _connectWithRetry(attempt = 1) {
    if (this._hubPausedUntil && Date.now() < this._hubPausedUntil) {
      this.homey.log('SOFABATON: Reconnect skipped — hub is released for app use');
      return;
    }
    this.sofaBaton.connectAndCatalog()
      .then(async () => {
        this.setAvailable();
        this.setStoreValue('catalog', this.getCatalog()).catch(() => {});
        try { await this._restoreWifiDevices(); } catch(rErr) { this.homey.error('_restoreWifiDevices threw:', rErr.message); }
        this.homey.app.updateHubsCache?.();
        // Poll for disconnection and schedule reconnect
        const checkInterval = setInterval(() => {
          if (!this.sofaBaton?.connected) {
            clearInterval(checkInterval);
            this.homey.log('SOFABATON: Disconnected — reconnecting in 15s');
            if (!this._hubPausedUntil || Date.now() >= this._hubPausedUntil) {
              this.setUnavailable('SofaBaton disconnected — reconnecting');
              this.sofaBaton?.close().catch(() => {});
              setTimeout(() => this._rebuildAndConnect(), 15000);
            }
          }
        }, 10000);
        this._connCheckInterval = checkInterval;
      })
      .catch(err => {
        const delay = attempt < 20 ? 2000 : Math.min(30000, (attempt - 19) * 5000);
        this.homey.error(`SofaBaton connect attempt ${attempt} failed: ${err.message} — retry in ${delay / 1000}s`);
        this.setUnavailable(`Connecting… (attempt ${attempt})`);
        // Close the client so it releases its TCP server port before the next attempt
        this.sofaBaton.close().catch(() => {});
        setTimeout(() => this._connectWithRetry(attempt + 1), delay);
      });
  }

  async _restoreWifiDevices() {
    const configs = this.getStoreValue('wifi_configs');
    if (!Array.isArray(configs) || configs.length === 0) return;
    if (!this.sofaBaton._wifiDeviceCommands) this.sofaBaton._wifiDeviceCommands = new Map();
    if (!this.sofaBaton._wifiCommandsByName) this.sofaBaton._wifiCommandsByName = new Map();
    // Build name→[devices] map to handle multiple devices with same name (duplicates from restarts)
    const devicesByName = new Map();
    for (const d of (this.sofaBaton?.devices.values() || [])) {
      if (!devicesByName.has(d.name.toLowerCase())) devicesByName.set(d.name.toLowerCase(), d);
    }
    for (const cfg of configs) {
      const existing = devicesByName.get(cfg.name.toLowerCase());
      if (existing) {
        // Already in hub catalog — re-register commands locally without re-creating
        const localCmds = new Map();
        cfg.commands.forEach((label, i) => localCmds.set(i, { id: i, label }));
        this.sofaBaton._wifiDeviceCommands.set(existing.id, localCmds);
        this.sofaBaton._wifiCommandsByName.set(cfg.name.toLowerCase(), { deviceId: existing.id, cmds: localCmds });
        this.homey.log(`WIFI: Commands re-registered for existing "${cfg.name}" id=${existing.id}`);
        continue;
      }
      this.homey.log(`WIFI: Auto-restoring "${cfg.name}" (${cfg.transport || 'http'})`);
      try {
        await this.sofaBaton.createWifiDevice(cfg.name, cfg.commands, this._callbackPort, cfg.transport || 'http');
        this.homey.log(`WIFI: Restored "${cfg.name}"`);
      } catch (e) {
        this.homey.log(`WIFI: Restore failed "${cfg.name}": ${e.message}`);
      }
    }
  }


  // Rebuild the SofaBatonClient from scratch rather than reusing the old one.
  // Necessary because close() tears down TCP servers and sockets, leaving the
  // client in a state that can't be cleanly reconnected without re-constructing.
  _rebuildAndConnect() {
    const ip = this.getSetting('ip') || this.getData().id;
    if (this._connCheckInterval) { clearInterval(this._connCheckInterval); this._connCheckInterval = null; }
    this.sofaBaton = new SofaBatonClient(this.homey, ip, {
      mqtt: {
        host: this.getSetting('mqtt_host'),
        port: this.getSetting('mqtt_port') || 1883,
        username: this.getSetting('mqtt_username'),
        password: this.getSetting('mqtt_password'),
      },
      onActivityChange:  (id, name) => this.handleActivityChange(id, name),
      onButtonPress:     e          => this.handleButtonPress(e),
      onConnectionChange: connected => {
        if (connected) this.setAvailable();
        else if (!this._hubPausedUntil || Date.now() >= this._hubPausedUntil) this.setUnavailable('SofaBaton disconnected');
      },
      onBannerMac: mac => {
        this.setStoreValue('banner_mac', mac).catch(() => {});
        this.setStoreValue('banner_opcode', this.sofaBaton._bannerOpcode || 0).catch(() => {});
      },
    });
    this._connectWithRetry();
  }

  // HTTP server that receives WiFi-device button events from the X2.
  // X2 POST path: /launch/{mac}/{device_id}/{cmd_index}/{short|long}
  // Response MUST be HTTP/1.1 with non-empty body + Connection:close to avoid the hub's retry storm.
  async _startHttpServer() {
    this._httpServer = http.createServer(async (req, res) => {
      const sendReply = (status, body) => {
        const bodyBuf = Buffer.from(body);
        res.writeHead(status, {
          'Content-Type':   'text/plain',
          'Content-Length': String(bodyBuf.length),
          'Connection':     'close',
        });
        res.end(bodyBuf);
      };
      const sendJson = (r, obj) => {
        const buf = Buffer.from(JSON.stringify(obj));
        r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(buf.length), 'Connection': 'close' });
        r.end(buf);
      };

      const urlPath = (req.url || '').split('?')[0];
      const parts   = urlPath.split('/').filter(Boolean);

      // Log all incoming requests (ring buffer, last 30)
      if (!this._reqLog) this._reqLog = [];
      this._reqLog.push({ t: Date.now(), method: req.method, url: req.url, ip: req.socket?.remoteAddress });
      if (this._reqLog.length > 30) this._reqLog.shift();

      // Management UI
      if (req.method === 'GET' && (urlPath === '/manage' || urlPath === '/manage/')) {
        const html = managePageHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(html)) });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && urlPath === '/manage/homey-devices') {
        const token = (req.url || '').split('?')[1]?.split('&').find(p => p.startsWith('token='))?.slice(6) || '';
        if (!token) { sendJson(res, []); return; }
        const https = require('https');
        const agent = new https.Agent({ rejectUnauthorized: false });
        const opts = { hostname: '127.0.0.1', port: 443, path: '/api/manager/devices/device', method: 'GET',
          headers: { Authorization: 'Bearer ' + decodeURIComponent(token), Accept: 'application/json' }, agent };
        const parseDevices = (raw) => {
          const map = JSON.parse(raw);
          return Object.values(map).map(d => ({
            id: d.id, name: d.name,
            capabilities: (d.capabilities || []).map(cid => {
              const cobj = (d.capabilitiesObj || {})[cid] || {};
              const cap = { id: cid, title: cobj.title || cid, type: cobj.type || 'string', setable: cobj.setable !== false };
              if (cobj.type === 'number') {
                if (cobj.min != null) cap.min = cobj.min;
                if (cobj.max != null) cap.max = cobj.max;
                if (cobj.step != null) cap.step = cobj.step;
                if (cobj.units) cap.units = cobj.units;
              }
              if (cobj.type === 'enum' && Array.isArray(cobj.values)) cap.values = cobj.values;
              return cap;
            }).filter(c => c.setable),
          })).filter(d => d.capabilities.length > 0);
        };
        const tryHttp = () => {
          const http2 = require('http');
          const o2 = { hostname: '127.0.0.1', port: 80, path: '/api/manager/devices/device', method: 'GET',
            headers: { Authorization: 'Bearer ' + decodeURIComponent(token), Accept: 'application/json' } };
          const rq2 = http2.request(o2, rp2 => {
            let raw2 = '';
            rp2.on('data', c => { raw2 += c; });
            rp2.on('end', () => { try { sendJson(res, parseDevices(raw2)); } catch(e) { sendJson(res, []); } });
          });
          rq2.on('error', () => sendJson(res, []));
          rq2.end();
        };
        const rq = https.request(opts, rp => {
          let raw = '';
          rp.on('data', c => { raw += c; });
          rp.on('end', () => {
            try { sendJson(res, parseDevices(raw)); }
            catch(e) { tryHttp(); }
          });
        });
        rq.on('error', () => tryHttp());
        rq.end();
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/device-states') {
        const pu2 = new URL('http://x' + req.url);
        const tok2 = pu2.searchParams.get('token') || this.homey.settings.get('homey_local_token') || '';
        const ids2 = (pu2.searchParams.get('ids') || '').split(',').filter(Boolean);
        if (!tok2 || !ids2.length) { sendJson(res, {}); return; }
        const gh2 = { Authorization: 'Bearer ' + tok2, Accept: 'application/json' };
        const parseStates = (raw) => {
          const map = JSON.parse(raw);
          const result = {};
          ids2.forEach(id => {
            const d = map[id];
            if (!d) return;
            result[id] = {};
            Object.entries(d.capabilitiesObj || {}).forEach(([cid, cobj]) => { result[id][cid] = cobj.value; });
          });
          return result;
        };
        const https5 = require('https'); const http5 = require('http');
        const tryHttp5 = () => {
          const r = http5.request({ hostname: '127.0.0.1', port: 80, path: '/api/manager/devices/device', method: 'GET', headers: gh2 }, rp => {
            let raw = ''; rp.on('data', c => { raw += c; }); rp.on('end', () => { try { sendJson(res, parseStates(raw)); } catch(e) { sendJson(res, {}); } });
          }); r.on('error', () => sendJson(res, {})); r.end();
        };
        const r5 = https5.request({ hostname: '127.0.0.1', port: 443, path: '/api/manager/devices/device', method: 'GET', rejectUnauthorized: false, headers: gh2 }, rp => {
          let raw = ''; rp.on('data', c => { raw += c; }); rp.on('end', () => { try { sendJson(res, parseStates(raw)); } catch(e) { tryHttp5(); } });
        }); r5.on('error', () => tryHttp5()); r5.end();
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/bindings') {
        try { sendJson(res, [...this._bindings.values()]); } catch(e) { sendJson(res, []); }
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/bindings') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          try {
            const b = JSON.parse(body);
            if (!b.id) b.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            this._bindings.set(b.id, b);
            try { this.homey.settings.set(this._bindingsKey, [...this._bindings.values()]); }
            catch(se) { this.homey.error('Binding save failed:', se.message); }
            sendJson(res, { ok: true, id: b.id });
          } catch (e) { sendJson(res, { ok: false, error: e.message }); }
        });
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/save-token') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body);
            if (token) this.homey.settings.set('homey_local_token', token);
            sendJson(res, { ok: true });
          } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        });
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/api-test') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          try {
            const { deviceId, capability, value, token } = JSON.parse(body);
            if (token) this.homey.settings.set('homey_local_token', token);
            const fakeBinding = { homeyDeviceId: deviceId, capability, value };
            this._execBinding(fakeBinding, result => sendJson(res, result));
          } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        });
        return;
      }
      if (req.method === 'POST' && urlPath.startsWith('/manage/test-binding/')) {
        const bid = urlPath.split('/').pop();
        const b = this._bindings.get(bid);
        if (!b) { sendJson(res, { ok: false, error: 'Binding not found' }); return; }
        this._execBinding(b, result => sendJson(res, result));
        return;
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/manage/bindings/')) {
        try {
          const bid = urlPath.split('/').pop();
          this._bindings.delete(bid);
          try { this.homey.settings.set(this._bindingsKey, [...this._bindings.values()]); }
          catch(se) { this.homey.error('Binding delete save failed:', se.message); }
          sendJson(res, { ok: true });
        } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/create-flow') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          try {
            const { binding, token, flowType = 'basic' } = JSON.parse(body);
            const btnName = binding.buttonName || binding.buttonLabel || ('Key ' + binding.keyId);
            const flowName = 'SofaBaton: ' + btnName + ' → ' + binding.homeyDeviceName + ' ' + binding.capability;
            const hdrs = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
            const https = require('https');
            const http2 = require('http');

            // Look up this device's Homey UUID via the API — this.id is not reliably set in SDK 3
            const myIp = this.getData().id || this.getSetting('ip') || '';
            const getDeviceUuid = (cb) => {
              const gh = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
              const parse = (raw) => {
                try {
                  const devMap = JSON.parse(raw);
                  const match = Object.values(devMap).find(d =>
                    d.driverUri === 'homey:app:com.sofabaton.homey' &&
                    (d.data?.id === myIp || d.settings?.ip === myIp)
                  );
                  cb(match ? match.id : '');
                } catch(e) { cb(''); }
              };
              const r = https.request({ hostname: '127.0.0.1', port: 443, path: '/api/manager/devices/device',
                method: 'GET', rejectUnauthorized: false, headers: gh }, rs => {
                let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => parse(d));
              });
              r.on('error', () => {
                const r2 = http2.request({ hostname: '127.0.0.1', port: 80, path: '/api/manager/devices/device',
                  method: 'GET', headers: gh }, rs => {
                  let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => parse(d));
                });
                r2.on('error', () => cb('')); r2.end();
              });
              r.end();
            };

            // Helper: POST payload to a URL (tries HTTPS 443 then HTTP 80)
            const postFlow = (path, payload, cb) => {
              const buf = Buffer.from(payload);
              const doHttp = () => {
                const r = http2.request({ hostname: '127.0.0.1', port: 80, path,
                  method: 'POST', headers: { ...hdrs, 'Content-Length': buf.length } }, rs => {
                  let d = ''; rs.on('data', c => { d += c; });
                  rs.on('end', () => cb(null, rs.statusCode, d));
                });
                r.on('error', e => cb(e)); r.write(buf); r.end();
              };
              const r = https.request({ hostname: '127.0.0.1', port: 443, path,
                method: 'POST', rejectUnauthorized: false,
                headers: { ...hdrs, 'Content-Length': buf.length } }, rs => {
                let d = ''; rs.on('data', c => { d += c; });
                rs.on('end', () => cb(null, rs.statusCode, d));
              });
              r.on('error', () => doHttp()); r.write(buf); r.end();
            };

            // Map (capability, value) → the ownerId Homey uses for its action card
            // e.g. windowcoverings_closed+true → 'close', onoff+true → 'on', dim → 'dim'
            const capToOwnerId = (cap, val) => {
              if (val === '__toggle__') return 'toggle'; // look for a toggle action card; falls back to trigger-only if not found
              if (cap === 'windowcoverings_closed') return val ? 'close' : 'open';
              if (cap === 'windowcoverings_state') return val === 'closed' ? 'close' : val === 'open' ? 'open' : null;
              if (cap === 'onoff') return val ? 'on' : 'off';
              if (cap === 'locked') return val ? 'lock' : 'unlock';
              return cap; // dim, volume_set, mode, thermostat_mode etc. use capability name as ownerId
            };

            // Look up action card for (homeyDeviceId, capability, value) from Homey's registry
            const lookupActionCard = (cb) => {
              const wantOwnerId = capToOwnerId(binding.capability, binding.value);
              if (!wantOwnerId) { cb(null); return; }
              const gh = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
              const parse = (raw) => {
                try {
                  const parsed = JSON.parse(raw);
                  const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
                  const devUri = 'homey:device:' + binding.homeyDeviceId;
                  const card = arr.find(c => c.ownerUri === devUri && c.ownerId === wantOwnerId);
                  cb(card || null);
                } catch(e) { cb(null); }
              };
              const r = https.request({ hostname: '127.0.0.1', port: 443,
                path: '/api/manager/flow/flowcardaction', method: 'GET',
                rejectUnauthorized: false, headers: gh }, rs => {
                let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => parse(d));
              });
              r.on('error', () => {
                const r2 = http2.request({ hostname: '127.0.0.1', port: 80,
                  path: '/api/manager/flow/flowcardaction', method: 'GET', headers: gh }, rs => {
                  let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => parse(d));
                });
                r2.on('error', () => cb(null)); r2.end();
              });
              r.end();
            };

            // Run device UUID lookup and action card lookup in parallel
            let myUuid = '', foundCard = undefined, pending = 2;
            const proceed = () => {
              if (--pending > 0) return;
              this.homey.log(`create-flow: uuid=${myUuid} ip=${myIp} card=${JSON.stringify(foundCard)?.slice(0,200)} binding=${JSON.stringify(binding).slice(0,200)}`);

              const triggerUri  = 'homey:device:' + myUuid;
              const triggerId   = triggerUri + ':button_pressed';
              const triggerArgs = {
                sofabaton_device: { id: String(binding.sofaDeviceId || ''), name: String(binding.sofaDeviceName || '') },
                button: { id: String(binding.keyId || ''), name: btnName },
              };

              // Build action object — use found card's compound id; fall back to trigger-only if no card
              let actionObj = null;
              if (foundCard) {
                // Infer args from card.args: if card has exactly one arg, pass { argName: value }
                const cardArgs = Array.isArray(foundCard.args) ? foundCard.args : [];
                const actionArgs = cardArgs.length === 1
                  ? { [cardArgs[0].name]: binding.value }
                  : (cardArgs.length > 0 ? { value: binding.value } : {});
                actionObj = { id: foundCard.id, uri: foundCard.ownerUri, args: actionArgs };
              }

              // Advanced Flow payload — Homey stores all nodes (trigger + actions) in a flat `cards` map;
              // connections use outputSuccess arrays on each card, not a separate edges list.
              const mkUuid = () => { try { return require('crypto').randomUUID(); } catch(e) { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); }); } };
              const trigKey = mkUuid(); const actKey = mkUuid();
              const advPayload = JSON.stringify(actionObj ? {
                name: flowName, enabled: true,
                cards: {
                  [trigKey]: { id: triggerId, type: 'trigger', x: 60, y: 60, args: triggerArgs, outputSuccess: [actKey] },
                  [actKey]:  { id: actionObj.id, type: 'action', x: 120, y: 180 },
                },
              } : {
                name: flowName, enabled: true,
                cards: { [trigKey]: { id: triggerId, type: 'trigger', x: 60, y: 60, args: triggerArgs } },
              });

              // Basic Flow payload — no uri field; actions need group/delay/duration to render correctly
              const basicPayload = JSON.stringify(actionObj ? {
                name: flowName, enabled: true,
                trigger: { id: triggerId, args: triggerArgs },
                conditions: [],
                actions: [{ id: actionObj.id, group: 'then', delay: null, duration: null, args: actionObj.args }],
              } : {
                name: flowName, enabled: true,
                trigger: { id: triggerId, args: triggerArgs },
                conditions: [], actions: [],
              });

              const actionNote = actionObj ? undefined : 'No action card found for ' + binding.capability + ' on device ' + binding.homeyDeviceId + ' — add the Then-action manually in Homey';

              const actionCardId = actionObj ? actionObj.id : null;
              // After creating a flow, GET it back to verify stored data
              const verifyFlow = (path, flowId, cb) => {
                const h = require('https'); const h2 = require('http');
                const gh = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
                const parse = (raw) => { try { cb(JSON.parse(raw)); } catch(e) { cb(null); } };
                const fullPath = path + flowId;
                const r = h.request({ hostname: '127.0.0.1', port: 443,
                  path: fullPath, method: 'GET',
                  rejectUnauthorized: false, headers: gh }, rs => {
                  let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => parse(d));
                });
                r.on('error', () => { const r2 = h2.request({ hostname: '127.0.0.1', port: 80,
                  path: fullPath, method: 'GET', headers: gh }, rs => {
                  let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => parse(d));
                }); r2.on('error', () => cb(null)); r2.end(); });
                r.end();
              };

              const doBasic = () => {
                postFlow('/api/manager/flow/flow', basicPayload, (err2, status2, raw2) => {
                  this.homey.log(`create-flow basic: uuid=${myUuid} err=${err2?.message} status=${status2} card=${actionCardId} raw=${raw2?.slice(0,400)}`);
                  if (err2) { sendJson(res, { ok: false, error: err2.message, uuid: myUuid }); return; }
                  try {
                    const r2 = JSON.parse(raw2);
                    if (status2 >= 300) { sendJson(res, { ok: false, via: 'basic', uuid: myUuid, actionCardId, actionNote, error: r2.message || r2.error || JSON.stringify(r2).slice(0,400) }); return; }
                    verifyFlow('/api/manager/flow/flow/', r2.id, stored => {
                      sendJson(res, { ok: true, flowId: r2.id, via: 'basic', uuid: myUuid, actionCardId, actionNote,
                        storedTrigger: stored?.trigger, storedActions: stored?.actions });
                    });
                  } catch(e2) { sendJson(res, { ok: false, error: 'Bad response: ' + raw2?.slice(0,400), uuid: myUuid }); }
                });
              };

              const doAdvanced = () => {
                postFlow('/api/manager/flow/advancedflow', advPayload, (err, status, raw) => {
                  this.homey.log(`create-flow advanced: uuid=${myUuid} err=${err?.message} status=${status} card=${actionCardId} raw=${raw?.slice(0,400)}`);
                  if (err) { sendJson(res, { ok: false, error: err.message, uuid: myUuid }); return; }
                  try {
                    const r = JSON.parse(raw);
                    if (status >= 300) { sendJson(res, { ok: false, via: 'advanced', uuid: myUuid, actionCardId, actionNote, error: r.message || r.error || JSON.stringify(r).slice(0,400) }); return; }
                    verifyFlow('/api/manager/flow/advancedflow/', r.id, stored => {
                      sendJson(res, { ok: true, flowId: r.id, via: 'advanced', uuid: myUuid, actionCardId, actionNote,
                        storedCards: stored?.cards });
                    });
                  } catch(e) { sendJson(res, { ok: true, via: 'advanced', uuid: myUuid, actionCardId, actionNote }); }
                });
              };

              if (flowType === 'advanced') doAdvanced(); else doBasic();
            };

            getDeviceUuid(uuid => { myUuid = uuid; proceed(); });
            lookupActionCard(card => { foundCard = card; proceed(); });
          } catch (e) { sendJson(res, { ok: false, error: e.message }); }
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/debug-adv-flow') {
        // Returns the raw stored format of recent advanced flows — compare a manually-created flow against ours
        const tok = new URL('http://x' + req.url).searchParams.get('token') || this.homey.settings.get('homey_local_token') || '';
        if (!tok) { sendJson(res, { error: 'no token' }); return; }
        const gh3 = { Authorization: 'Bearer ' + tok, Accept: 'application/json' };
        const https3 = require('https'); const http4 = require('http');
        const doGet = (path, cb) => {
          const r = https3.request({ hostname: '127.0.0.1', port: 443, path, method: 'GET', rejectUnauthorized: false, headers: gh3 }, rs => {
            let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => { try { cb(null, JSON.parse(d)); } catch(e) { cb(e); } });
          });
          r.on('error', () => { const r2 = http4.request({ hostname: '127.0.0.1', port: 80, path, method: 'GET', headers: gh3 }, rs => {
            let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => { try { cb(null, JSON.parse(d)); } catch(e) { cb(e); } });
          }); r2.on('error', e => cb(e)); r2.end(); });
          r.end();
        };
        // ?type=basic uses /api/manager/flow/flow; default is advanced
        const pu = new URL('http://x' + req.url);
        const specificId = pu.searchParams.get('id');
        const isBasic = pu.searchParams.get('type') === 'basic';
        const basePath = isBasic ? '/api/manager/flow/flow' : '/api/manager/flow/advancedflow';
        if (specificId) {
          doGet(basePath + '/' + specificId, (err, flow) => {
            if (err) { sendJson(res, { error: err.message }); return; }
            sendJson(res, { keys: Object.keys(flow || {}), raw: flow });
          });
          return;
        }
        doGet(basePath, (err, data) => {
          if (err) { sendJson(res, { error: err.message }); return; }
          const flows = Array.isArray(data) ? data : Object.values(data || {});
          sendJson(res, { type: isBasic ? 'basic' : 'advanced', count: flows.length, flows: flows.map(f => ({ id: f.id, name: f.name })) });
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/debug-catalog') {
        const pu = new URL('http://x' + req.url);
        const rawDevId = pu.searchParams.get('device');
        const sb = this.sofaBaton;

        // Summary: devices + per-device command counts
        const deviceSummary = [...(sb?.devices?.values() || [])].map(d => {
          const cmdMap = sb?.commandsByDevice?.get(d.id);
          const rawBuf = sb?._rawCommandDump?.get(d.id);
          return {
            id: d.id, name: d.name,
            commandCount: cmdMap?.size ?? 0,
            rawBytes: rawBuf?.length ?? 0,
          };
        });

        if (!rawDevId) {
          sendJson(res, {
            connected: sb?.connected ?? false,
            activities: [...(sb?.activities?.values() || [])].map(a => ({ id: a.id, name: a.name })),
            devices: deviceSummary,
            totalCommands: sb?.commands?.size ?? 0,
          });
          return;
        }

        // Device-specific raw dump + parsed records
        const devId = Number(rawDevId);
        const rawBuf = sb?._rawCommandDump?.get(devId);
        if (!rawBuf || rawBuf.length === 0) {
          sendJson(res, { error: `No raw data for device ${devId} — try refreshing catalog first` });
          return;
        }

        // Show header hex (first 80 bytes) and attempt parse at stride=70 and stride=71
        const headerHex = rawBuf.subarray(0, Math.min(rawBuf.length, 160)).toString('hex');

        const tryParse = (buf, stride, labelOffset, labelLen) => {
          const records = [];
          for (let i = 0; i + stride <= buf.length; i += stride) {
            const cmdId = buf[i + 1];
            if (!cmdId || cmdId === 0xFF) continue;
            const lblBuf = buf.subarray(i + labelOffset, i + labelOffset + labelLen);
            const swapped = Buffer.alloc(lblBuf.length - (lblBuf.length % 2));
            for (let j = 0; j < swapped.length; j += 2) { swapped[j] = lblBuf[j + 1]; swapped[j + 1] = lblBuf[j]; }
            const label = swapped.toString('utf16le').replace(/\x00/g, '').trim();
            records.push({ i, cmdId, label: label || '(empty)', rowHex: buf.subarray(i, i + Math.min(stride, 24)).toString('hex') });
          }
          return records;
        };

        // The 'data' portion (what _finalizeCommands sees) skips header bytes IF it came via the header page.
        // Since _rawCommandDump stores raw payload, and header page (0xD95D) skips 7 bytes for command data,
        // we need to try both with and without the 7-byte skip.
        const parsed70_9  = tryParse(rawBuf, 70, 9, 60);
        const parsed70_9s = tryParse(rawBuf.subarray(7), 70, 9, 60); // skip 7-byte header prefix
        const parsed71_9s = tryParse(rawBuf.subarray(7), 71, 9, 60);

        sendJson(res, {
          deviceId: devId,
          deviceName: sb?.devices?.get(devId)?.name,
          rawBytes: rawBuf.length,
          headerHex,
          parsedCommandsByDevice: sb?.commandsByDevice?.get(devId) ? [...sb.commandsByDevice.get(devId).values()].map(c => c.label) : [],
          tryStride70_noSkip:  { count: parsed70_9.length,  records: parsed70_9.slice(0, 10) },
          tryStride70_skip7:   { count: parsed70_9s.length, records: parsed70_9s.slice(0, 10) },
          tryStride71_skip7:   { count: parsed71_9s.length, records: parsed71_9s.slice(0, 10) },
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/debug-trigger') {
        const tok = new URL('http://x' + req.url).searchParams.get('token') || this.homey.settings.get('homey_local_token') || '';
        if (!tok) { sendJson(res, { error: 'no token' }); return; }
        const hdrs2 = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'Content-Type': 'application/json' };
        const myIp2 = this.getData().id || this.getSetting('ip') || '';
        const https2 = require('https'); const http3 = require('http');
        const apiReq = (method, path, body, cb) => {
          const buf = body ? Buffer.from(body) : null;
          const h = { ...hdrs2 }; if (buf) h['Content-Length'] = buf.length;
          const doHttp = () => { const r = http3.request({ hostname: '127.0.0.1', port: 80, path, method, headers: h }, rs => { let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => cb(null, rs.statusCode, d)); }); r.on('error', e => cb(e)); if (buf) r.write(buf); r.end(); };
          const r = https2.request({ hostname: '127.0.0.1', port: 443, path, method, rejectUnauthorized: false, headers: h }, rs => { let d = ''; rs.on('data', c => { d += c; }); rs.on('end', () => cb(null, rs.statusCode, d)); });
          r.on('error', () => doHttp()); if (buf) r.write(buf); r.end();
        };

        // Compare stored binding device IDs vs action card ownerUris for 'close'
        const myIp3 = this.getData().id || this.getSetting('ip') || '';
        const storedBindings = this.homey.settings.get('bindings_' + myIp3) || [];
        const bindingDevIds = [...new Set(storedBindings.map(b => b.homeyDeviceId).filter(Boolean))];

        apiReq('GET', '/api/manager/flow/flowcardaction', null, (e, s, raw) => {
          if (e) { sendJson(res, { error: e.message }); return; }
          try {
            const cards = JSON.parse(raw);
            const arr = Array.isArray(cards) ? cards : Object.values(cards);
            // Find all 'close' and 'open' action cards and show their ownerUris
            const closeCards = arr.filter(c => c.ownerId === 'close' || c.ownerId === 'open');
            // For each binding device ID, check exact vs fuzzy match
            const matchReport = bindingDevIds.map(devId => {
              const exactUri = 'homey:device:' + devId;
              const exact = arr.find(c => c.ownerUri === exactUri && (c.ownerId === 'close' || c.ownerId === 'open'));
              const fuzzy = !exact && arr.find(c => (c.ownerUri || '').includes(devId) && (c.ownerId === 'close' || c.ownerId === 'open'));
              return { devId, exactMatch: !!exact, fuzzyMatch: !!fuzzy, fuzzyUri: fuzzy?.ownerUri };
            });
            sendJson(res, {
              bindingDevIds,
              matchReport,
              closeOpenCards: closeCards.map(c => ({ ownerId: c.ownerId, ownerUri: c.ownerUri, ownerName: c.ownerName })),
            });
          } catch(e2) { sendJson(res, { error: 'parse fail', raw: raw?.slice(0, 500) }); }
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/last-press') {
        sendJson(res, this._lastButtonPress || { keyId: null });
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/clear-press') {
        this._lastButtonPress = null;
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/button-labels') {
        const labels = this.homey.settings.get('button_labels') || {};
        sendJson(res, { labels });
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/button-labels') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          try {
            const { deviceId, cmdId, label } = JSON.parse(body);
            if (!Number.isFinite(Number(deviceId)) || !Number.isFinite(Number(cmdId)))
              return sendJson(res, { ok: false, error: 'Invalid deviceId or cmdId' });
            const key = `${deviceId}:${cmdId}`;
            const labels = this.homey.settings.get('button_labels') || {};
            if (label === null || label === '') {
              delete labels[key];
            } else {
              labels[key] = String(label).trim();
            }
            this.homey.settings.set('button_labels', labels);
            sendJson(res, { ok: true });
          } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/req-log') {
        sendJson(res, { log: (this._reqLog || []).slice().reverse() });
        return;
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/manage/wifi-device/')) {
        const encName = urlPath.split('/manage/wifi-device/')[1];
        const devName = decodeURIComponent(encName);
        try {
          // Delete from hub if connected
          const hubDev = this.sofaBaton?.devices
            ? [...this.sofaBaton.devices.values()].find(d => d.name.toLowerCase() === devName.toLowerCase())
            : null;
          if (hubDev && this.sofaBaton?.connected) {
            await this.sofaBaton.deleteWifiDevice(hubDev.id);
          }
          // Remove from Homey's local store
          const cfgs = this.getStoreValue('wifi_configs') || [];
          const idx2 = cfgs.findIndex(c => c.name.toLowerCase() === devName.toLowerCase());
          if (idx2 !== -1) cfgs.splice(idx2, 1);
          await this.setStoreValue('wifi_configs', cfgs);
          if (this.sofaBaton?._wifiCommandsByName) this.sofaBaton._wifiCommandsByName.delete(devName.toLowerCase());
          if (hubDev && this.sofaBaton?._wifiDeviceCommands) this.sofaBaton._wifiDeviceCommands.delete(hubDev.id);
          sendJson(res, { ok: true, hubDeleted: !!hubDev });
        } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        return;
      }
      if (req.method === 'DELETE' && urlPath.startsWith('/manage/wifi-device-by-id/')) {
        const hubId = parseInt(urlPath.split('/manage/wifi-device-by-id/')[1], 10);
        if (isNaN(hubId)) { sendJson(res, { ok: false, error: 'Invalid device ID' }); return; }
        try {
          if (!this.sofaBaton?.connected) throw new Error('Hub not connected');
          await this.sofaBaton.deleteWifiDevice(hubId);
          sendJson(res, { ok: true });
        } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        return;
      }
      if (req.method === 'POST' && urlPath === '/manage/wifi-device/re-register') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          try {
            const { name, commands } = JSON.parse(body);
            if (!this.sofaBaton?.connected) throw new Error('Hub not connected');
            const cfgs = this.getStoreValue('wifi_configs') || [];
            const existing = cfgs.find(c => c.name.toLowerCase() === name.toLowerCase());
            const transport = existing?.transport || (this.sofaBaton.options.mqtt?.host ? 'mqtt' : 'http');
            const result = await this.sofaBaton.createWifiDevice(name, commands, this._callbackPort, transport);
            const idx2 = cfgs.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
            if (idx2 !== -1) { cfgs[idx2] = { name, commands, transport }; } else { cfgs.push({ name, commands, transport }); }
            await this.setStoreValue('wifi_configs', cfgs);
            sendJson(res, { ok: true, result });
          } catch(e) { sendJson(res, { ok: false, error: e.message }); }
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/manage/data') {
        const connected = this.sofaBaton?.connected ?? false;
        const ready     = connected && !!this.sofaBaton?.bannerMac;
        const _cfgs = this.getStoreValue('wifi_configs') || [];
        const _hubByName = new Map();
        if (connected) for (const d of (this.sofaBaton?.devices.values() || [])) _hubByName.set(d.name.toLowerCase(), d);
        const wifiDevices = _cfgs.map(cfg => {
          const hubDev = _hubByName.get(cfg.name.toLowerCase());
          return { name: cfg.name, commands: cfg.commands || [], id: hubDev ? hubDev.id : null, inHub: !!hubDev };
        });
        const body = JSON.stringify({
          hubName: this.getName(), connected, ready, wifiDevices,
          homeyDeviceUUID: this.id,
          pausedUntil: this._hubPausedUntil || 0,
          homeyLocalToken: this.homey.settings.get('homey_local_token') || null,
          debug: {
            wifiConfigs: this.getStoreValue('wifi_configs') || [],
            wifiByNameKeys: this.sofaBaton?._wifiCommandsByName ? [...this.sofaBaton._wifiCommandsByName.keys()] : [],
            wifiDevCmdKeys: this.sofaBaton?._wifiDeviceCommands ? [...this.sofaBaton._wifiDeviceCommands.keys()] : [],
            bannerMac: this.sofaBaton?.bannerMac || null,
            proxyUdpPort: this.sofaBaton?._proxyUdpPort || null,
            proxyMdns: !!this.sofaBaton?._mdnsService,
            appConnected: !!this.sofaBaton?._appSocket,
            activities: this.sofaBaton?.activities?.size ?? 0,
            devices: this.sofaBaton?.devices?.size ?? 0,
            deviceList: [...(this.sofaBaton?.devices?.values() || [])].map(d => ({ id: d.id, name: d.name, type: d.type, raw: d.rawHex })),
            lastDiagnostic: this.sofaBaton?.lastDiagnostic || null,
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && urlPath === '/manage/debug-logs') {
        const body = JSON.stringify({ logs: this._logBuf || [] });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(body);
        return;
      }

      if (req.method === 'POST' && urlPath === '/manage/release') {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', async () => {
          const minutes = Math.max(1, Math.min(60, Number(JSON.parse(raw || '{}').minutes) || 10));
          await this.releaseHub(minutes);
          const body = JSON.stringify({ ok: true, minutes, until: this._hubPausedUntil });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
          res.end(body);
        });
        return;
      }

      if (req.method === 'POST' && urlPath === '/manage/resume') {
        this.resumeHub();
        const body = JSON.stringify({ ok: true });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
        res.end(body);
        return;
      }

      if (req.method === 'POST' && urlPath === '/manage/create') {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', async () => {
          try {
            const { name, commands } = JSON.parse(raw);
            const cleanName = String(name || '').trim();
            const cleanCmds = (commands || []).map(c => String(c).trim()).filter(Boolean);
            // Check if device already exists on hub — if so, just update local records
            const existingDev = [...(this.sofaBaton?.devices.values() || [])].find(
              d => d.name.toLowerCase() === cleanName.toLowerCase()
            );
            let result;
            if (existingDev) {
              const localCmds = new Map();
              cleanCmds.forEach((label, i) => localCmds.set(i, { id: i, label }));
              this.sofaBaton._wifiDeviceCommands.set(existingDev.id, localCmds);
              this.sofaBaton._wifiCommandsByName.set(cleanName.toLowerCase(), { deviceId: existingDev.id, cmds: localCmds });
              result = { deviceId: existingDev.id, name: existingDev.name, commands: cleanCmds, existed: true };
            } else {
              const transport = this.sofaBaton.options.mqtt?.host ? 'mqtt' : 'http';
              result = await this.sofaBaton.createWifiDevice(cleanName, cleanCmds, this._callbackPort, transport);
            }
            const transport = result.transport || 'http';
            const cfgs = this.getStoreValue('wifi_configs') || [];
            const idx = cfgs.findIndex(c => c.name.toLowerCase() === cleanName.toLowerCase());
            if (idx !== -1) cfgs[idx] = { name: result.name, commands: cleanCmds, transport };
            else cfgs.push({ name: result.name, commands: cleanCmds, transport });
            await this.setStoreValue('wifi_configs', cfgs);
            const body = JSON.stringify({ ok: true, result });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
            res.end(body);
          } catch (err) {
            const body = JSON.stringify({ ok: false, error: err.message });
            res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
            res.end(body);
          }
        });
        return;
      }

      // Parse /launch/{mac}/{deviceId}/{cmdIndex}/{short|long}
      //    or /launch/{mac}/wf/{encodedName}/{cmdIndex}/{short|long}  (stable name-based URL)
      if (req.method === 'POST' && parts[0] === 'launch' && parts.length >= 5) {
        let deviceId, cmdIndex, pressType, command, deviceEntry;

        if (parts.length >= 6 && parts[2] === 'wf') {
          // Name-based URL — stable across app restarts regardless of hub-assigned device ID
          const safeName = decodeURIComponent(parts[3]).toLowerCase();
          const byName = this.sofaBaton?._wifiCommandsByName?.get(safeName);
          deviceId  = byName?.deviceId ?? -1;
          cmdIndex  = Number(parts[4]);
          pressType = parts[5];
          if (!byName) {
            // Auto-discover: hub already has this WiFi device — register it now
            for (const d of (this.sofaBaton?.devices.values() || [])) {
              if (d.name.toLowerCase() === safeName) {
                if (!this.sofaBaton._wifiCommandsByName) this.sofaBaton._wifiCommandsByName = new Map();
                if (!this.sofaBaton._wifiDeviceCommands) this.sofaBaton._wifiDeviceCommands = new Map();
                const cfgs = this.getStoreValue('wifi_configs') || [];
                // Find matching config (case-insensitive, or by any name containing the safe name)
                const cfg = cfgs.find(c => c.name.toLowerCase() === safeName || c.name.toLowerCase().startsWith(safeName) || safeName.startsWith(c.name.toLowerCase()));
                const labels = cfg?.commands || [];
                const localCmds = new Map();
                for (let i = 0; i < Math.max(labels.length || 0, 10); i++) {
                  localCmds.set(i, { id: i, label: labels[i] || ('Cmd ' + (i + 1)) });
                }
                this.sofaBaton._wifiDeviceCommands.set(d.id, localCmds);
                this.sofaBaton._wifiCommandsByName.set(safeName, { deviceId: d.id, cmds: localCmds });
                byName = { deviceId: d.id, cmds: localCmds };
                this.homey.log('WIFI: Auto-registered "' + d.name + '" id=' + d.id);
                // Persist if not already in wifi_configs by hub name
                if (!cfgs.find(c => c.name.toLowerCase() === safeName)) {
                  cfgs.push({ name: d.name, commands: [...localCmds.values()].map(c => c.label) });
                  await this.setStoreValue('wifi_configs', cfgs);
                  this.homey.log('WIFI: Saved "' + d.name + '" to wifi_configs');
                }
                break;
              }
            }
          }
          const cmdArray = byName ? [...byName.cmds.values()] : [];
          command     = cmdArray[cmdIndex];
          deviceEntry = this.sofaBaton?.devices.get(deviceId);
        } else {
          // Numeric URL (legacy / IR devices)
          deviceId  = Number(parts[2]);
          cmdIndex  = Number(parts[3]);
          pressType = parts[4];
          const cmdMap  = this.sofaBaton?.commandsByDevice.get(deviceId) ||
                          this.sofaBaton?._wifiDeviceCommands?.get(deviceId);
          const cmdArray = cmdMap ? [...cmdMap.values()] : [];
          command     = cmdArray[cmdIndex];
          deviceEntry = this.sofaBaton?.devices.get(deviceId);
        }

        if (command) {
          this.homey.log(
            `HTTP callback: device=${deviceId}(${deviceEntry?.name}) ` +
            `cmd_idx=${cmdIndex} "${command.label}" [${pressType}]`
          );
          this.handleButtonPress({
            device_id: deviceId,
            key_id:    command.id,
            press_type: pressType,
          });
        } else {
          this.homey.log(`HTTP callback: unknown device=${deviceId} cmd_idx=${cmdIndex}`);
        }

        sendReply(200, 'OK');
      } else {
        sendReply(404, 'Not found');
      }
    });

    const hostIp = localIPv4();
    for (let p = BASE_HTTP_PORT; p < BASE_HTTP_PORT + 40; p++) {
      try {
        await new Promise((resolve, reject) => {
          this._httpServer.once('error', reject);
          this._httpServer.once('listening', resolve);
          this._httpServer.listen(p, '0.0.0.0');
        });
        this._callbackPort = p;
        this._callbackBaseUrl = `http://${hostIp}:${p}/launch`;
        this.homey.log(`SofaBaton HTTP callback server: ${this._callbackBaseUrl}`);
        break;
      } catch (e) {
        if (p === BASE_HTTP_PORT + 39)
          this.homey.error('Could not start HTTP callback server — all ports busy');
      }
    }
  }

  // Snapshot of the current hub catalog, used by flow-card autocomplete and onInit store.
  getCatalog() {
    return {
      activities: [...this.sofaBaton.activities.values()],
      devices:    [...this.sofaBaton.devices.values()],
      commands:   [...this.sofaBaton.commands.values()],
    };
  }

  // Return the base URL for this Homey device's HTTP callback server.
  // WiFi device command URLs should be: {callbackBaseUrl}/{mac}/{device_id}/{cmd_index}/{short|long}
  getCallbackInfo() {
    const base = this._callbackBaseUrl || null;
    const manageUrl = base ? base.replace('/launch', '/manage/') : null;
    return {
      url:        base,
      port:       this._callbackPort || null,
      manage_url: manageUrl,
    };
  }

  _dlog(msg) {
    this.homey.log(msg);
    if (!this._logBuf) this._logBuf = [];
    this._logBuf.push(`${new Date().toISOString()} ${msg}`);
    if (this._logBuf.length > 100) this._logBuf.shift();
  }

  async handleActivityChange(id, name) {
    this._dlog(`ACTIVITY_CHANGE: id=${id} name="${name}"`);
    const previous = await Promise.resolve(this.getStoreValue('current_activity_id')).catch(() => null);
    await this.setStoreValue('current_activity_id', id).catch(() => {});
    this.activityTrigger.trigger(
      this,
      { activity_name: name, activity_id: id, previous_activity_id: previous },
      { activity_id: id }
    ).catch(e => this.homey.error(`Activity trigger error: ${e.message}`));
  }

  async handleButtonPress(event) {
    const deviceEntry = this.sofaBaton.devices.get(event.device_id);
    // When a WiFi device hasn't made it into the hub catalog yet, fall back to
    // the config name so bindings are saved with the real name, not "Device N".
    let deviceName = deviceEntry?.name;
    if (!deviceName && this.sofaBaton._wifiCommandsByName) {
      for (const [n, entry] of this.sofaBaton._wifiCommandsByName) {
        if (entry.deviceId === event.device_id) {
          const cfgs = this.getStoreValue('wifi_configs') || [];
          const cfg = cfgs.find(c => c.name.toLowerCase() === n);
          deviceName = cfg?.name || n;
          break;
        }
      }
    }
    const cmdMap      = this.sofaBaton.commandsByDevice.get(event.device_id);
    const irCommand   = cmdMap?.get(event.key_id) || this.sofaBaton.commands.get(event.key_id);
    const wifiCmd     = this.sofaBaton._wifiDeviceCommands?.get(event.device_id)?.get(event.key_id);
    const command     = wifiCmd || irCommand;
    const rawLabel    = command?.label || BUTTON_NAMES[event.key_id] || `Key ${event.key_id}`;
    const labelKey    = `${event.device_id}:${event.key_id}`;
    const buttonLabels = this.homey.settings.get('button_labels') || {};
    const button      = buttonLabels[labelKey] || rawLabel;

    const resolvedDevName = deviceName || `Device ${event.device_id}`;
    this._lastButtonPress = { keyId: event.key_id, sofaDeviceId: event.device_id, button, rawLabel, deviceName: resolvedDevName };
    const eventDevName = resolvedDevName.toLowerCase();
    this.homey.log(`Button: key=${event.key_id} dev=${event.device_id}(${eventDevName}) bindings=${this._bindings.size}`);
    // Match bindings by name OR numeric ID so bindings survive hub restarts
    // (hub can reassign device IDs, but names are stable).
    for (const b of this._bindings.values()) {
      const bName = (b.sofaDeviceName || '').toLowerCase();
      const bDevId = b.sofaDeviceId ?? b.deviceId;
      const nameMatch = bName && eventDevName && bName === eventDevName;
      const idMatch   = bDevId === event.device_id;
      if (b.keyId === event.key_id && (nameMatch || idMatch)) {
        this.homey.log(`Exec binding: cap=${b.capability} val=${b.value}`);
        this._execBinding(b);
      }
    }
    this.buttonTrigger.trigger(
      this,
      {
        button,
        device_name: resolvedDevName,
        device_id:   event.device_id,
        key_id:      event.key_id,
        activity_id: this.sofaBaton.currentActivityId,
      },
      { device_id: event.device_id, key_id: event.key_id }  // state for run listener
    ).catch(e => this.homey.error(`Button trigger error: ${e.message}`));
  }

  _execBinding(b, callback) {
    const token = this.homey.settings.get('homey_local_token');
    if (!token) {
      const err = 'No homey_local_token stored — paste token in Button Controls';
      this.homey.error('Binding exec: ' + err);
      if (callback) callback({ ok: false, error: err });
      return;
    }

    if (b.value === '__toggle__') {
      // GET current capability value, then PUT the opposite
      const gh = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      const devPath = `/api/manager/devices/device/${b.homeyDeviceId}`;
      const getAndFlip = (proto, port, done) => {
        const mod = require(proto);
        const opts = { hostname: '127.0.0.1', port, path: devPath, method: 'GET', headers: gh };
        if (proto === 'https') opts.rejectUnauthorized = false;
        const rq = mod.request(opts, rp => {
          let raw = ''; rp.on('data', c => { raw += c; });
          rp.on('end', () => { try { done(null, JSON.parse(raw)); } catch(e) { done(e); } });
        });
        rq.on('error', done); rq.end();
      };
      const flip = (dev) => {
        const cur = dev?.capabilitiesObj?.[b.capability]?.value;
        const newVal = !cur;
        this.homey.log(`Toggle binding: ${b.capability} cur=${cur} → ${newVal}`);
        this._execBinding({ ...b, value: newVal }, callback);
      };
      getAndFlip('https', 443, (err, dev) => {
        if (err) { getAndFlip('http', 80, (err2, dev2) => { if (err2) { if (callback) callback({ ok: false, error: 'Toggle GET failed: ' + err2.message }); return; } flip(dev2); }); return; }
        flip(dev);
      });
      return;
    }

    const body = JSON.stringify({ value: b.value });
    // Try PUT /capability/{cap} first, then /setCapabilityValue, then HTTP fallback
    const tryReq = (proto, port, apiPath, done) => {
      const mod = require(proto);
      const hdrs = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
      const opts = { hostname: '127.0.0.1', port, path: apiPath, method: 'PUT', headers: hdrs };
      if (proto === 'https') opts.rejectUnauthorized = false;
      const rq = mod.request(opts, rp => {
        let raw = ''; rp.on('data', c => { raw += c; });
        rp.on('end', () => done(null, rp.statusCode, raw));
      });
      rq.on('error', e => done(e));
      rq.write(body); rq.end();
    };
    const capPath  = `/api/manager/devices/device/${b.homeyDeviceId}/capability/${b.capability}`;
    const fallback = () => tryReq('http', 80, capPath, (err, status, raw) => {
      const msg = err ? err.message : `${status}: ${raw.slice(0,120)}`;
      this.homey.log(`Binding exec HTTP fallback: ${msg}`);
      if (callback) callback(err ? { ok: false, error: err.message } : { ok: status < 300, status, raw: raw.slice(0,200) });
    });
    tryReq('https', 443, capPath, (err, status, raw) => {
      if (err) { fallback(); return; }
      this.homey.log(`Binding exec HTTPS ${status}: ${raw.slice(0,120)}`);
      if (status >= 400) { fallback(); return; }
      if (callback) callback({ ok: true, status, raw: raw.slice(0,200) });
    });
  }

  async onDeleted() {
    try { this._httpServer?.close(); } catch {}
    await this.sofaBaton?.close();
  }

  // Called by Homey when device settings are saved; reconnects only if network settings changed.
  async onSettings({ newSettings }) {
    const keys = ['ip', 'mqtt_host', 'mqtt_port', 'mqtt_username', 'mqtt_password'];
    const changed = keys.some(k => String(newSettings[k] ?? '') !== String(this.getSetting(k) ?? ''));
    if (!changed) return;
    await this.sofaBaton.close();
    this.sofaBaton.ip = newSettings.ip || this.getSetting('ip');
    this.sofaBaton.options.mqtt = {
      host:     newSettings.mqtt_host,
      port:     newSettings.mqtt_port || 1883,
      username: newSettings.mqtt_username,
      password: newSettings.mqtt_password,
    };
    await this.sofaBaton.connectAndCatalog();
    this.setAvailable();
  }
}

SofaBatonDevice.SofaBatonClient = SofaBatonClient;
module.exports = SofaBatonDevice;
