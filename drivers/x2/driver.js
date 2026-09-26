'use strict';

const Homey = require('homey');

// Sentinel returned from autocompletes to mean "no filter / match any"
const ANY_ID = '__any__';
const ANY_ENTRY = (label) => ({ name: `— ${label} —`, id: ANY_ID });

module.exports = class SofaBatonDriver extends Homey.Driver {

  async onInit() {

    // ── ACTION: START ACTIVITY ───────────────────────────────────────────────
    this.startActivityCard = this.homey.flow.getActionCard('start_activity');

    this.startActivityCard.registerArgumentAutocompleteListener('activity', async (query, args) => {
      const device = args.device;
      if (!device?.sofaBaton) return [];
      const q = String(query || '').toLowerCase();
      return [...device.sofaBaton.activities.values()]
        .filter(a => a.name.toLowerCase().includes(q))
        .map(a => ({ name: a.name, description: `ID ${a.id}`, id: a.id }));
    });

    this.startActivityCard.registerRunListener(async (args) => {
      return args.device.sofaBaton.startActivity(Number(args.activity.id));
    });


    // ── ACTION: SEND COMMAND ─────────────────────────────────────────────────
    this.sendCommandCard = this.homey.flow.getActionCard('send_command');

    this.sendCommandCard.registerArgumentAutocompleteListener('entity', async (query, args) => {
      const device = args.device;
      if (!device?.sofaBaton) return [];
      const q = String(query || '').toLowerCase();
      return [
        ...[...device.sofaBaton.devices.values()]
          .map(d => ({ name: d.name, id: d.id, description: 'Device' })),
        ...[...device.sofaBaton.activities.values()]
          .map(a => ({ name: a.name, id: a.id, description: 'Activity' })),
      ].filter(e => e.name.toLowerCase().includes(q));
    });

    this.sendCommandCard.registerArgumentAutocompleteListener('command', async (query, args) => {
      const device = args.device;
      if (!device?.sofaBaton) return [];
      const q = String(query || '').toLowerCase();
      const entityId = args.entity?.id != null ? Number(args.entity.id) : null;

      let commands;
      if (entityId != null && device.sofaBaton.commandsByDevice?.has(entityId)) {
        commands = [...device.sofaBaton.commandsByDevice.get(entityId).values()];
      } else {
        commands = [...device.sofaBaton.commands.values()];
      }

      return commands
        .filter(c => c.label.toLowerCase().includes(q))
        .map(c => ({ name: c.label, description: `ID ${c.id}`, id: c.id }));
    });

    this.sendCommandCard.registerRunListener(async (args) => {
      return args.device.sofaBaton.sendCommand(Number(args.entity.id), Number(args.command.id));
    });


    // ── ACTION: STOP ACTIVITY ────────────────────────────────────────────────
    this.homey.flow.getActionCard('stop_activity').registerRunListener(async (args) => {
      return args.device.sofaBaton.stopActivity();
    });


    // ── ACTION: RELEASE HUB ──────────────────────────────────────────────────
    this.homey.flow.getActionCard('release_hub').registerRunListener(async (args) => {
      const minutes = Math.max(1, Math.min(60, Number(args.minutes) || 10));
      await args.device.releaseHub(minutes);
      return true;
    });

    // ── ACTION: REFRESH CATALOG ──────────────────────────────────────────────
    this.homey.flow.getActionCard('refresh_catalog').registerRunListener(async (args) => {
      await args.device.sofaBaton.refreshCatalog();
      await args.device.setStoreValue('catalog', args.device.getCatalog()).catch(() => {});
      return true;
    });


    // ── ACTION: FIND REMOTE ──────────────────────────────────────────────────
    this.homey.flow.getActionCard('find_remote').registerRunListener(async (args) => {
      await args.device.sofaBaton.findRemote();
      return true;
    });


    // ── ACTION: GET CALLBACK URL ─────────────────────────────────────────────
    // Returns the Homey HTTP callback base URL for this device — used when
    // manually configuring WiFi-device commands in the SofaBaton app.
    this.homey.flow.getActionCard('get_callback_url').registerRunListener(async (args) => {
      const info = args.device.getCallbackInfo?.() || {};
      return { callback_url: info.url || '', callback_port: info.port || 0, manage_url: info.manage_url || '' };
    });


    // ── ACTION: CREATE WIFI DEVICE ───────────────────────────────────────────
    // Provisions a virtual HTTP device on the X2 so physical remote buttons
    // POST back to Homey and fire the 'button_pressed' trigger.
    this.homey.flow.getActionCard('create_wifi_device').registerRunListener(async (args) => {
      const commandNames = String(args.commands || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!commandNames.length) throw new Error('Enter at least one command name');
      const deviceName = String(args.device_name || '').trim();
      if (!deviceName) throw new Error('Device name cannot be blank');

      const transport = args.device.sofaBaton.options.mqtt?.host ? 'mqtt' : 'http';
      const result = await args.device.sofaBaton.createWifiDevice(
        deviceName,
        commandNames,
        args.device._callbackPort,
        transport,
      );
      return { hub_device_id: result.deviceId, device_name: result.name };
    });


    // ── TRIGGER: BUTTON PRESSED ──────────────────────────────────────────────
    // Args on the card let the user optionally filter by SofaBaton device and button.
    // Selecting "— Any … —" (id === ANY_ID) means no filter on that dimension.
    this.buttonTriggerCard = this.homey.flow.getDeviceTriggerCard('button_pressed');

    this.buttonTriggerCard.registerArgumentAutocompleteListener('sofabaton_device', async (query, args) => {
      const device = args.device;
      if (!device?.sofaBaton) return [];
      const q = String(query || '').toLowerCase();
      return [
        ANY_ENTRY('Any device'),
        ...[...device.sofaBaton.devices.values()]
          .filter(d => d.name.toLowerCase().includes(q))
          .map(d => ({ name: d.name, id: String(d.id) })),
      ];
    });

    this.buttonTriggerCard.registerArgumentAutocompleteListener('button', async (query, args) => {
      const device = args.device;
      if (!device?.sofaBaton) return [];
      const q = String(query || '').toLowerCase();
      const sbDeviceId = args.sofabaton_device?.id;
      const buttonLabels = device.homey.settings.get('button_labels') || {};

      let commands;
      if (sbDeviceId && sbDeviceId !== ANY_ID) {
        const cmdMap = device.sofaBaton.commandsByDevice?.get(Number(sbDeviceId));
        commands = cmdMap ? [...cmdMap.values()] : [];
      } else {
        commands = [...device.sofaBaton.commands.values()];
      }

      return [
        ANY_ENTRY('Any button'),
        ...commands
          .map(c => {
            const friendlyName = buttonLabels[`${c.deviceId}:${c.id}`] || c.label;
            return { name: friendlyName, id: String(c.id), description: friendlyName !== c.label ? `Raw: ${c.label}` : undefined };
          })
          .filter(c => c.name.toLowerCase().includes(q)),
      ];
    });

    // Run listener: return true only if the event matches the user's filter selections.
    // state is { device_id, key_id } set when the trigger fires in device.js.
    this.buttonTriggerCard.registerRunListener(async (args, state) => {
      const selectedDevice = args.sofabaton_device?.id;
      const selectedButton = args.button?.id;
      const devMatch = !selectedDevice || selectedDevice === ANY_ID ||
        Number(selectedDevice) === Number(state.device_id);
      const btnMatch = !selectedButton || selectedButton === ANY_ID ||
        Number(selectedButton) === Number(state.key_id);
      return devMatch && btnMatch;
    });


    // ── TRIGGER: ACTIVITY CHANGED ────────────────────────────────────────────
    this.activityTriggerCard = this.homey.flow.getDeviceTriggerCard('activity_changed');

    this.activityTriggerCard.registerArgumentAutocompleteListener('activity', async (query, args) => {
      const device = args.device;
      if (!device?.sofaBaton) return [];
      const q = String(query || '').toLowerCase();
      return [
        ANY_ENTRY('Any activity'),
        ...[...device.sofaBaton.activities.values()]
          .filter(a => a.name.toLowerCase().includes(q))
          .map(a => ({ name: a.name, id: String(a.id) })),
      ];
    });

    // state is { activity_id } set when the trigger fires in device.js.
    this.activityTriggerCard.registerRunListener(async (args, state) => {
      const selected = args.activity?.id;
      return !selected || selected === ANY_ID ||
        Number(selected) === Number(state.activity_id);
    });
  }


  // ── PAIRING ──────────────────────────────────────────────────────────────
  async onPair(session) {
    let ip = null;

    session.setHandler('validate_ip', async (data) => {
      ip = String(data.ip || '').trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Enter a valid IPv4 address.');
      if (ip.split('.').map(Number).some(p => p < 0 || p > 255)) throw new Error('Enter a valid IPv4 address.');

      const { SofaBatonClient } = require('./device');
      const test = new SofaBatonClient(this.homey, ip);
      try {
        await test.connectAndCatalog({ testOnly: true });
        return true;
      } catch (err) {
        return {
          error: String(err),
          message: err?.message || '',
          ip,
          diagnostic: {
            homeyIp:       test.lastDiagnostic?.homeyIp       || 'unknown',
            listenPort:    test.lastDiagnostic?.listenPort    || 'unknown',
            x2Ip:          test.lastDiagnostic?.x2Ip          || ip,
            serverListening: test.lastDiagnostic?.serverListening ?? 'unknown',
          },
        };
      }
    });

    session.setHandler('list_devices', async () => {
      if (!ip) throw new Error('X2 Hub IP address was not provided.');
      return [{ name: 'SofaBaton X2', data: { id: ip }, settings: { ip } }];
    });
  }
};
