'use strict';

const Homey = require('homey');

class SofaBatonApp extends Homey.App {

  async onInit() {
    this.log('SofaBaton app initialized');
    this._hubs = new Map();
    this.homey.settings.on('set', key => {
      if (key === 'wifi_create') this._handleWifiCreate().catch(e => this.error(e.message));
    });
  }

  _registerHub(device) {
    this._hubs.set(String(device.getData().id), device);
    this.log('Hub registered:', device.getData().id);
  }

  async _handleWifiCreate() {
    const raw = this.homey.settings.get('wifi_create');
    if (!raw) return;
    let req;
    try { req = JSON.parse(raw); } catch { return; }

    try {
      const device = this._hubs.get(String(req.deviceId)) ||
        [...this._hubs.values()].find(d => String(d.getSetting?.('ip') || '') === String(req.deviceId));
      if (!device) throw new Error(`Hub "${req.deviceId}" not found (registered: ${[...this._hubs.keys()].join(', ')})`);
      if (!device.sofaBaton?.connected) throw new Error('X2 not connected');

      const transport = device.sofaBaton.options.mqtt?.host ? 'mqtt' : 'http';
      const result = await device.sofaBaton.createWifiDevice(
        String(req.name).trim(),
        req.commands.map(c => String(c).trim()).filter(Boolean),
        device._callbackPort,
        transport,
      );
      const existing = device.getStoreValue('wifi_configs') || [];
      existing.push({ name: req.name.trim(), commands: req.commands.map(c => String(c).trim()).filter(Boolean), transport });
      await device.setStoreValue('wifi_configs', existing);
      this.homey.settings.set('wifi_status', JSON.stringify({ ok: true, result }));
      this.updateHubsCache();
    } catch (err) {
      this.homey.settings.set('wifi_status', JSON.stringify({ ok: false, error: err.message }));
    } finally {
      this.homey.settings.set('wifi_create', '');
    }
  }

  // Called whenever a device connects/refreshes so the settings page has fresh hub data
  updateHubsCache() {
    try {
      this.log('updateHubsCache called');
      const driver = this.homey.drivers.getDriver('x2');
      const devices = driver.getDevices();
      // Populate _hubs here — driver.getDevices() works in this context
      devices.forEach(d => this._hubs.set(String(d.getData().id), d));
      const hubs = devices.map(d => ({
        id:         String(d.getData().id),
        name:       d.getName(),
        connected:  d.sofaBaton?.connected ?? false,
        manageUrl:  d.getCallbackInfo?.()?.manage_url?.replace('/manage/', '/manage/') || null,
        wifiDevices: (() => {
          const wfNames = new Set((d.getStoreValue?.('wifi_configs') || []).map(c => c.name));
          return [...(d.sofaBaton?.devices.values() || [])].filter(x => wfNames.has(x.name)).map(x => ({ id: x.id, name: x.name }));
        })(),
      }));
      this.homey.settings.set('hubs_cache', JSON.stringify(hubs));
    } catch (e) { this.error('updateHubsCache error:', e.message); }
  }


}

module.exports = SofaBatonApp;
