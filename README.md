# SofaBaton for Homey

Local, cloud-free integration between **SofaBaton X2 and X1S** universal remote hubs and **Homey Pro**. No MQTT broker required — communicates directly with the hub over LAN using the native binary protocol. Press buttons on any paired remote to control Homey devices directly. An MQTT broker is optional (needed only for activity-change triggers).

---

## Features

- **LAN-only** — all communication stays on your local network; no Homey Cloud required
- **Button → Homey action** — bind any X2 remote button to a Homey device action (lights, switches, climate, media, etc.) without writing a Flow
- **Button → Flow trigger** — `A button was pressed` trigger card fires for every button press, with the device name, button name, key ID, and active activity as tokens
- **Activity tracking** — `The active activity changed` trigger card fires whenever the X2 switches activities (requires MQTT broker — see Requirements)
- **WiFi devices** — create virtual HTTP devices on the X2 hub so SofaBaton remotes can call back into Homey; useful for custom buttons that aren't in the device catalog
- **Proxy Control** — temporarily release the hub so the SofaBaton mobile app can connect directly, then Homey reconnects automatically
- **Flow actions** — send any X2 command, start or stop activities, create WiFi devices, and release the hub — all scriptable from Homey Flows
- **Manage page** — a local web UI (port 8300) for pairing buttons to device actions, managing WiFi devices, and debugging

---

## Requirements

| Requirement | Detail |
|---|---|
| Homey Pro | 2023 model or later, firmware ≥ 12.0.0 |
| SofaBaton X2 or X1S | Hub on the same LAN subnet as Homey. X1S support is designed-in but untested — feedback welcome. |
| Homey local API token | Optional — needed only for device-binding and auto-flow features in the Manage page |
| MQTT broker | Optional — needed only for the `activity changed` Flow trigger (e.g. Mosquitto). All other features work without it. |

> The original **X1** is not supported. The **X1S** shares the X2 binary protocol and is designed to work, but is currently untested due to hardware availability.

---

## Installation

### From the Homey App Store
Search for **SofaBaton** in the Homey app → Apps tab, or install directly from the App Store page.

### Sideload / development
```bash
git clone https://github.com/rcoletti116/homey-sofabaton.git
cd homey-sofabaton
npm install
homey app run        # runs on your Homey with live reload
# or
homey app install    # installs without live reload
```

---

## Setup

### 1 — Pair the X2 hub

1. Open the Homey app → **Devices** → **+** → search **SofaBaton**
2. Select **SofaBaton X2**
3. Enter the hub's local IP address (find it in your router's DHCP list or the SofaBaton mobile app under hub settings)
4. Tap **Connect** — Homey will handshake with the hub and import the device and activity catalog

### 2 — Open the Manage page

The Manage page is the main UI for button bindings and WiFi devices. It runs on Homey at port 8300 and is only reachable from your local network.

**How to find the URL:**
1. In the Homey app, go to **Devices** → open the SofaBaton X2 device card
2. Tap the three-dot menu → **Settings**
3. Tap **Manage Device Control** — this opens the Manage page in your browser

Or navigate directly to:
```
http://<homey-ip>:8300/manage/
```

### 3 — Bind a button to a Homey device

1. On the Manage page, tap a WiFi device card to expand it
2. Tap **+ Add Control**
3. Press the physical remote button you want to use — it appears as a "detected" chip
4. Choose the Homey device and action (capability + value)
5. Optionally tick **Also create a Homey flow** to get a programmable Flow alongside the direct binding
6. Tap **Save control**

### 4 (optional) — Create WiFi devices

WiFi devices are virtual HTTP devices registered on the X2 hub. When a remote button press triggers a WiFi device command, the X2 calls back into Homey over LAN.

1. On the Manage page → **Devices** tab, expand **Add WiFi Device**
2. Enter a name and the commands you want (e.g. `On`, `Off`, `Dim`)
3. Tap **Create on X2**

The new device appears in SofaBaton's device catalog and can be assigned to buttons in the SofaBaton app.

---

## Flow cards

### Triggers

| Card | Description |
|---|---|
| `A button was pressed` | Fires when any X2 remote button activates a device command. Tokens: `button`, `device_name`, `device_id`, `key_id`, `activity_id`. Use the filter args to match a specific device or button. |
| `The active activity changed` | Fires when the X2 switches activities. Tokens: `activity_name`, `activity_id`, `previous_activity_id`. **Requires an MQTT broker** — the X2 only publishes activity state over MQTT; configure the broker in device settings. |

### Actions

| Card | Description |
|---|---|
| `Send SofaBaton command` | Send a command to any X2-paired device. |
| `Start SofaBaton activity` | Switch the hub to a specific activity. |
| `Stop SofaBaton activity` | Deactivate the current activity. |
| `Create SofaBaton WiFi device` | Programmatically create a WiFi device on the hub. |
| `Get SofaBaton callback URL` | Returns the LAN callback URL and port as flow tokens — useful for scripting advanced integrations. |
| `Refresh SofaBaton catalog` | Forces a catalog reload from the hub. |
| `Release hub for SofaBaton app` | Temporarily disconnects Homey so the SofaBaton mobile app can connect. Homey reconnects after the specified number of minutes. |

---

## Proxy Control

The SofaBaton mobile app and Homey cannot both hold the hub connection simultaneously. Proxy Control lets them coexist:

- **Setup (one time):** In the Manage page → **Config** tab, tap one of the release buttons (5 / 10 / 30 min). While the hub is released, open the SofaBaton app → Hub settings → set the hub IP to your Homey's local IP. Save. From that point on, the SofaBaton app routes through Homey.
- **Day-to-day:** The hub connection is held by Homey. Tap any release button when you need to use the SofaBaton mobile app; Homey resumes automatically when the timer expires, or immediately if you tap **Resume Homey now**.

---

## Known limitations

- **X1 not supported** — the original X1 uses a different protocol; X1S shares the X2 protocol and should work but is untested
- **Single hub** — only one X2 per Homey device is supported currently
- **Activity triggers require MQTT** — the X2 hub only broadcasts activity state over MQTT; without a broker configured, the `activity changed` trigger will not fire
- **LAN access required** — the Manage page is not reachable outside your local network (by design)
- **Unofficial protocol** — the X2 local API is reverse-engineered; SofaBaton firmware updates may require app updates

---

## Credits

This app would not exist without the reverse-engineering work done in the [**home-assistant-sofabaton-x1s**](https://github.com/m3tac0de/home-assistant-sofabaton-x1s) project by [@m3tac0de](https://github.com/m3tac0de). That project documented the undisclosed SofaBaton local protocol from scratch, including:

- The UDP `CALL_ME` handshake (port 8102) and TCP callback connection
- The binary frame format: `A5 5A` header, opcode, payload, checksum
- Activity catalog rows (`0xD53B`), device catalog rows (`0xD50B`), command requests (`0x025C`), and activation (`0x023F`)
- The mDNS service name `_sofabaton_hub._udp.local.`
- Activity and device ID semantics across the X1S / X2 protocol variants

This Homey app is an independent reimplementation in Node.js targeting the X2, not a fork or port of the Home Assistant integration. The upstream project is MIT-licensed; see [its repository](https://github.com/m3tac0de/home-assistant-sofabaton-x1s) for the original protocol documentation. SofaBaton does not officially document or support this local API.

---

## Contributing

Bug reports and pull requests are welcome at the [GitHub repository](https://github.com/rcoletti116/homey-sofabaton). Please open an issue before starting a large change.

---

## License

MIT — see [LICENSE](./LICENSE).
