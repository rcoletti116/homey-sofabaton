SofaBaton for Homey

Local, cloud-free integration between the SofaBaton X2 universal remote hub and Homey Pro. Press buttons on any X2-paired remote to control Homey devices directly — no cloud, no MQTT broker required.


FEATURES

- LAN-only — all communication stays on your local network; no Homey Cloud required
- Button → Homey action — bind any X2 remote button to a Homey device action (lights, switches, climate, media, etc.) without writing a Flow
- Button → Flow trigger — "A button was pressed" trigger card fires for every button press, with the device name, button name, key ID, and active activity as tokens
- Activity tracking — "The active activity changed" trigger card fires whenever the X2 switches activities
- WiFi devices — create virtual HTTP devices on the X2 hub so SofaBaton remotes can call back into Homey
- Proxy Control — temporarily release the hub so the SofaBaton mobile app can connect directly, then Homey reconnects automatically
- Flow actions — send any X2 command, start or stop activities, create WiFi devices, and release the hub
- Manage page — a local web UI (port 8300) for pairing buttons to device actions, managing WiFi devices, and debugging


REQUIREMENTS

- Homey Pro 2023 or later, firmware >= 12.0.0
- SofaBaton X2 hub on the same LAN subnet as Homey
- Homey local API token (optional — needed only for device-binding and auto-flow features in the Manage page)

Note: The SofaBaton X1 and X1S are not supported. The X2 uses a different local protocol.


SETUP

1. Pair the X2 hub
   Open the Homey app > Devices > + > search SofaBaton > select SofaBaton X2.
   Enter the hub's local IP address (find it in your router's DHCP list or the SofaBaton mobile app under hub settings).
   Tap Connect — Homey will handshake with the hub and import the device and activity catalog.

2. Open the Manage page
   The Manage page runs on Homey at port 8300 and is reachable only from your local network.
   In the Homey app: Devices > open the SofaBaton X2 device card > three-dot menu > Settings > Manage Device Control.
   Or navigate directly to: http://<homey-ip>:8300/manage/

3. Bind a button to a Homey device
   On the Manage page, expand a WiFi device card, tap "+ Add Control", press the remote button you want to use, choose a Homey device and action, then tap Save.

4. Create WiFi devices (optional)
   WiFi devices are virtual devices registered on the X2 hub. When a remote button triggers a WiFi device command, the X2 calls back into Homey over LAN.
   On the Manage page > Devices tab > expand "Add WiFi Device", enter a name and commands, then tap Create on X2.


FLOW CARDS

Triggers:
- A button was pressed — fires on any X2 button press; tokens: button, device_name, device_id, key_id, activity_id
- The active activity changed — fires when the X2 switches activities; tokens: activity_name, activity_id, previous_activity_id

Actions:
- Send SofaBaton command
- Start SofaBaton activity
- Stop SofaBaton activity
- Create SofaBaton WiFi device
- Get SofaBaton callback URL
- Refresh SofaBaton catalog
- Release hub for SofaBaton app


PROXY CONTROL

The SofaBaton mobile app and Homey cannot both hold the hub connection simultaneously. Proxy Control lets them coexist.

One-time setup: In the Manage page > Config tab, tap a release button (5 / 10 / 30 min). While released, open the SofaBaton app > Hub settings > set the hub IP to your Homey's local IP. From then on, the SofaBaton app routes through Homey.

Day-to-day: Tap any release button when you need the SofaBaton app; Homey resumes automatically when the timer expires, or tap "Resume Homey now".


KNOWN LIMITATIONS

- X2 only — X1 and X1S are not supported
- Single hub — only one X2 per Homey device is supported
- LAN access required — the Manage page is not reachable outside your local network (by design)
- Unofficial protocol — the X2 local API is reverse-engineered; SofaBaton firmware updates may require app updates


CREDITS

This app would not exist without the reverse-engineering work in the home-assistant-sofabaton-x1s project by @m3tac0de (https://github.com/m3tac0de/home-assistant-sofabaton-x1s), which documented the undisclosed SofaBaton local protocol from scratch. This Homey app is an independent reimplementation in Node.js targeting the X2. SofaBaton does not officially document or support this local API.


LICENSE

MIT — see LICENSE file.
