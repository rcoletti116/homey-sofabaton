'use strict';

// App-level API — called from settings/index.html via Homey.api().
// Delegates to SofaBatonApp methods so homey.app is the only entry point.
module.exports = {

  async getDevices({ homey }) {
    return homey.app.getX2Devices();
  },

  async getWifiDevices({ homey, query }) {
    return homey.app.getWifiDevicesForHub(query.deviceId);
  },

  async createWifiDevice({ homey, body }) {
    return homey.app.createWifiDeviceOnHub(body);
  },

};
