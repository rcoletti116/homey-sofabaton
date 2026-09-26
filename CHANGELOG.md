# Changelog

All notable changes to this project will be documented here. Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.2.89] — 2026-09-12

### Added
- **MQTT transport for WiFi devices**: when `mqtt_host` is set in settings, new WiFi devices are registered on the hub as `wifi_mqtt` type (`code_type 0x20`, per HA `protocol_const.py`) instead of `wifi_http` (`0x1C`). The hub then publishes button presses to `{mac}/up` on the MQTT broker rather than HTTP-POSTing to Homey — so button events work even if Homey's IP changes or the hub can't reach Homey directly. Command records are written as 2-byte inert payloads (`[0x00, slot]`) that the hub ignores at press time, matching the `wifi_mqtt_profile.py` spec from the HA reference.
- The `transport` field (`'http'` or `'mqtt'`) is stored in `wifi_configs` alongside name/commands, so auto-restore on reconnect and re-register both use the same transport the device was originally created with.
- All three create paths (flow action, `/manage/create`, `/manage/wifi-device/re-register`) auto-detect transport from whether `mqtt_host` is configured.

---

## [0.2.88] — 2026-09-12

### Removed
- **Protocol sniffer**: debug tool used to reverse-engineer the hub delete protocol — now understood. Removed `_proxySniffEnabled`/`_proxyAppLog` state, bidirectional frame logging in `onData` and `_connectToApp`, `/manage/proxy-sniff/*` HTTP endpoints, and the sniffer UI panel. Code preserved at git tag `sniffer` for future protocol work.

---

## [0.2.87] — 2026-09-12

### Fixed
- **Hub-side WiFi device deletion (third attempt)**: stripped the 8-frame sequence down to the two frames that actually matter — `0x0109 [id]` (OP_DELETE_DEVICE, per HA `protocol_const.py`) and `0x0064` (SAVE_COMMIT), each followed by `_waitForAck(0x0103)` — exactly mirroring `createWifiDevice`'s proven ACK-based pattern. The preceding 6 frames (REQ_ACTIVITIES, REQ_COMMANDS, REQ_BUTTONS, load-device, two 0x0140s) were the SofaBaton app loading device details for its confirmation dialog, not part of the protocol; the queue-based `request()` approach in 0.2.85 still sent those unnecessary frames plus used fixed delays instead of ACK waiting.

---

## [0.2.86] — 2026-09-12

### Added
- **Bidirectional protocol sniffer**: the sniffer now captures hub→Homey frames alongside the existing app→hub capture, labeled `HUB→` and `APP→HUB`. A new "Send delete" button in the sniffer panel lets you trigger a hub-side delete while the sniffer is running, so you can see exactly what the hub sends back — needed to diagnose why delete isn't working on Homey's catalog session.

---

## [0.2.85] — 2026-09-12

### Fixed
- **Hub-side WiFi device deletion**: the delete frames were being sent with `this.socket.write()` directly, bypassing the `requestQueue` that every other hub operation serializes through. If a catalog refresh was in flight (e.g., the periodic reconnect had just triggered one), the delete frames raced into the middle of a streaming response and the hub ignored them. Fixed by routing all delete frames through `this.request()`, which chains onto the queue. Also added proper inter-group delays (600ms after session init, 500ms after load group, 400ms after mark-delete group, 1200ms after commit) to give the hub time to process each phase before the next arrives.

---

## [0.2.84] — 2026-09-12

### Added
- **Hub device list**: Config tab → "Hub device list (all)" expander shows every device currently in the hub catalog — including orphaned duplicates that don't appear in the WiFi devices list. Each row has a Delete button that removes it from the hub by ID directly, without needing a matching Homey store entry.

---

## [0.2.83] — 2026-09-12

### Added
- **Hub-side WiFi device deletion**: the Del button in the Manage page now also removes the device from the X2 hub (not just from Homey's local store). Sends the 8-frame delete protocol sequence discovered via the proxy sniffer: 6 select frames (0x5c, 0x3c, 0x4d, 0x40×2, 0x09) each carrying the device ID, then a delete trigger (0x64) and close (0x0a). Falls back to local-only removal if the hub is not connected.

---

## [0.2.82] — 2026-09-12

### Fixed
- **Manage page broken**: `sniffFetch()` used `.join('\n')` inside the Node.js template literal — the `\n` was evaluated as a real newline character, producing an unclosed single-quoted string literal in the rendered JavaScript. Every page load triggered a browser JS parse error that silently prevented the entire `<script>` block from executing, so devices never loaded and no functions worked. Fixed by escaping to `.join('\\n')`.
- **Proxy sniffer frame parsing**: `parseFrames` (undefined) corrected to `parseFrameStream`; result field `remaining` corrected to `rest`; buffer is now properly pre-concatenated before parsing so partial frames accumulate correctly across TCP chunks.

---

## [0.2.81] — 2026-09-12

### Added
- **Proxy frame sniffer**: Debug tools → "Proxy frame sniffer" — release the hub, click Start, perform actions in the SofaBaton app (e.g. delete a device), then Fetch log. Shows every raw TCP frame the SofaBaton app sent to the hub (opcode + full payload hex), logged in memory up to 200 frames. Used to discover unknown hub protocol opcodes such as device deletion.

---

## [0.2.80] — 2026-09-12

### Fixed
- **New WiFi device shows "not in hub" / controls missing**: after `createWifiDevice` completes its 7-step hub protocol, the subsequent `refreshCatalog` sometimes arrives before the hub has committed the new device — so the device never appears in `sofaBaton.devices`. Fixed by inserting the new device into the map immediately after creation, before the catalog refresh, and re-inserting it afterward if the refresh dropped it. Also fixed a second consequence of this race: if a button was pressed on the new device before `sofaBaton.devices` had the entry, `deviceEntry` was null and `_lastButtonPress.deviceName` fell back to `"Device N"`. Bindings saved with that generic name never matched the WiFi device card (`sofaDeviceName` filter). Now `handleButtonPress` falls back to the WiFi config's display name when `deviceEntry` is absent, so bindings are always saved with the correct device name.

---

## [0.2.79] — 2026-09-09

### Added
- **Button Labels**: assign friendly names to remote buttons so they appear clearly in Homey flow card autocomplete instead of raw hub labels like "0" or "Key 3". In the Manage page → Config tab → Button Labels section: press any button on the remote, type a name (e.g. "Menu", "Channel Up"), save. Labels are stored in Homey settings keyed by `deviceId:cmdId` and survive catalog refreshes. The flow card `button_pressed` trigger and the `button` token both use the friendly name; the raw label still shows as "Raw: 0" in the autocomplete description for reference.

---

## [0.2.78] — 2026-09-09

### Fixed
- **Button autocomplete empty**: continuation command pages (`0xD55D`, `0x4D5D`, etc.) have a 3-byte prefix before their 70-byte records, but `_accumulateCommandPage` was appending the full payload — so every continuation page's record offsets were wrong by 3 bytes, causing all cmdIds to read as 0 and the commands to be silently dropped. Fixed by skipping 3 bytes on continuation pages (the existing header-page skip is 7 bytes). Most devices with more than one command page were effectively invisible in the flow card autocomplete; they will now populate correctly after the catalog refreshes on reconnect.

---

## [0.2.77] — 2026-09-09

### Added
- **Debug endpoint** (`/manage/debug-catalog`): shows catalog state (activities, devices, per-device command counts, raw byte counts). Add `?device=<id>` to see the raw hex received from the hub for that device and try three different parse strategies (stride 70 / stride 71, with/without 7-byte header skip) to diagnose why commands show as empty in flow card autocomplete.

---

## [0.2.76] — 2026-09-09

### Fixed
- **Find Remote flow card**: `find_remote.json` was missing the required `device` arg (`type: "device", filter: "driver_id=x2"`), so the card never appeared in the Flow editor and `args.device` was undefined in the run listener; also removed the redundant duplicate entry in `driver.compose.json`

---

## [0.2.75] — 2026-09-09

### Added
- **Find Remote device button**: `find_remote` is now a pressable button capability on the X2 device card — press it in the Homey app to make the remote beep. The existing "Find SofaBaton remote" Flow action card remains and shares the same underlying `findRemote()` call.

---

## [0.2.74] — 2026-09-09

### Added
- **Slider UI for numeric capabilities**: the binding overlay now renders an `<input type="range">` slider (with a live value label) for any numeric capability that declares a `min`/`max` range (e.g. `dim` 0–100%, `light_hue`, `light_saturation`, `light_temperature`, `volume_set`, `thermostat_target_temperature`); falls back to a plain number input when no range is declared
- **Enum capability support**: enum-typed capabilities now render a `<select>` populated with the capability's defined values (e.g. `thermostat_mode`, `media_repeat`)
- Capability `min`, `max`, `step`, `units`, and `values` fields are now passed through from the Homey device API to the manage page client

---

## [0.2.73] — 2026-09-09

### Fixed
- **CPU usage**: mDNS announce socket is now kept open and reused across ticks instead of being created and destroyed every cycle; interval slowed from 15 s to 60 s (mDNS TTL is 255 s, so 60 s is sufficient to hold the cached record)
- **CPU usage**: removed verbose per-frame log (`homey.log` on every incoming TCP frame) — Homey persists device logs to storage, so logging every frame caused unnecessary I/O
- **Dependencies**: removed unused `bonjour-service` npm package (was listed in `package.json` but never imported)

---

## [0.2.72] — 2026-09-09

### Added
- **Device state display**: binding rows now show a live current-value badge (e.g. `● on`, `○ off`, `▸ 75%`) that refreshes every 8 seconds using a `/manage/device-states` endpoint

---

## [0.2.71] — 2026-09-09

### Changed
- **Multi-action UI**: bindings for the same button are now grouped under a shared header with an "+ Action" link, making it clear that multiple actions can fire on a single press

---

## [0.2.70] — 2026-09-09

### Added
- **Toggle mode**: binding value can now be set to "Toggle (flip current state)" — at runtime the app reads the current capability value via Homey's local API and sends the opposite; flow creation maps the toggle binding to Homey's built-in `toggle` action card

---

## [0.2.69] — 2026-09-09

### Fixed
- **Flow creation (toggle)**: `capToOwnerId` now checks for `'__toggle__'` before the boolean coercion so toggle bindings correctly resolve to the `toggle` action card instead of `on`

---

## [0.2.68] — 2026-09-09

### Fixed
- **Flow creation (basic)**: action payload now includes `group: "then"`, `delay: null`, `duration: null` fields required by Homey's basic flow editor to render the Then card; removed spurious `uri` field from trigger and actions

---

## [0.2.67] — 2026-09-09

### Added
- **Debug endpoint**: `/manage/debug-adv-flow` now accepts `?type=basic` to inspect basic flows (`/api/manager/flow/flow`) in addition to advanced flows

---

## [0.2.66] — 2026-09-09

### Changed
- **Flow creation UI**: replaced "Also create a Homey flow" checkbox with a **"Create Homey flow"** select — options: None / Basic (editable in Homey app) / Advanced (web only)
- Basic and Advanced flow creation are now separate independent paths with no fallback between them

---

## [0.2.65] — 2026-09-09

### Fixed
- **Flow creation (advanced)**: completely rewrote advanced flow payload to use Homey's actual `cards` flat map format with `outputSuccess` arrays for node connections — the previous `trigger`/`nodes`/`edges` structure was wrong and caused blank nodes in Homey's flow editor

---

## [0.2.62–0.2.64] — 2026-09-09

### Added
- **Debug endpoint** (`/manage/debug-adv-flow`): lists all advanced flows by id/name; supports `?id=<flowId>` to fetch a single flow's full raw stored format (trigger, nodes, edges / cards) for format comparison

---

## [0.2.61] — 2026-09-09

### Changed
- **Flow creation (advanced)**: verify step now GETs `/api/manager/flow/advancedflow/<id>` after creation and returns `storedCards` in the response

---

## [0.2.51–0.2.60] — 2026-09-09

### Fixed
- **Flow creation**: action cards cannot use capability names as IDs — added `capToOwnerId()` mapping (`windowcoverings_closed+true → close`, `onoff+true → on`, `locked+true → lock`, etc.)
- **Flow creation**: action card compound ID is now looked up dynamically from Homey's `/api/manager/flow/flowcardaction` registry rather than constructed from the capability name
- **Flow creation**: advanced flow URL corrected to `/api/manager/flow/advancedflow` (was `/api/manager/flow/advanced-flow/advancedflow`)
- **Flow creation**: parallel lookup of SofaBaton device UUID and target action card; `verifyFlow` step added to confirm stored trigger and actions after creation
- **Debug endpoint** (`/manage/debug-trigger`): updated to query action card registry and report exact/fuzzy match between stored binding device IDs and available close/open cards

---

## [0.2.50] — 2026-09-09

### Fixed
- **Flow creation**: trigger `id` must be the full compound key `homey:device:<uuid>:button_pressed` (confirmed via `/api/manager/flow/flowcardtrigger`); previous attempts used the short id `button_pressed` which Homey cannot resolve
- **Debug endpoint** (`/manage/debug-trigger`): now queries Homey's trigger card registry and returns matching cards with their real database IDs

## [0.2.49] — 2026-09-09

### Fixed
- **Flow creation**: trigger URI changed to `homey:app:com.sofabaton.homey`; debug endpoint updated to query `/api/manager/flow/flow`
- Manage page version string updated

---

## [0.2.48] — 2026-09-09

### Fixed
- **Flow creation**: basic flow action args used wrong key (`{ capability: value }` → `{ value: value }`)
- **Flow creation**: advanced flow edge socket names corrected (`"output"/"input"` → `"out"/"in"`)
- Flow creation errors now include full Homey API response text for easier diagnosis
- Both API attempts (advanced + basic) now log to Homey's device log

---

## [0.2.47] — 2026-08-30

### Changed
- **Manage page redesign**: reduced from 3 tabs (Devices / Controls / Config) to 2 tabs (Devices + Config)
- Device cards now expand inline to show their saved controls — no separate Controls tab needed
- Add Control now opens as a fixed bottom-sheet overlay instead of navigating to another tab
- Edit binding flow updated to match new overlay UX

---

## [0.2.46] — 2026-08-28

### Fixed
- Manage page failed to load any data and all buttons were inert after the v0.2.45 redesign
- Root cause: `\'` inside a Node.js template literal collapsed to a bare `'`, prematurely terminating JavaScript strings in the dynamically-built `onclick` attributes; fixed by using `\\'` throughout so the evaluated HTML contains the correct `\'` escape sequence

---

## [0.2.45] — 2026-08-28

### Added
- Full Manage page redesign: 3-tab layout (Devices, Controls, Config)
- Devices tab: WiFi device list with Fix / Delete buttons
- Controls tab: binding list with Test / Edit / Delete per binding
- Config tab: Proxy Control with 5 / 10 / 30-minute release buttons and Resume
- "Also create a Homey flow" checkbox on the binding save form — attempts Advanced Flow first, falls back to Basic Flow

### Changed
- Proxy Control renamed from "App Access" for clarity
- Debug tools moved into a collapsible `<details>` block in the Config tab

---

## [0.2.x] — 2026-07 through 2026-08

### Added
- Button-to-device bindings: map any X2 remote button directly to a Homey device action (no Flow required)
- Binding storage via `homey.settings` keyed by device ID
- Button detection endpoint (`/manage/last-press`, `/manage/clear-press`) for interactive button capture in the Manage UI
- Homey device picker in the Manage page using the local API token
- Test-binding endpoint: fire a binding on demand from the UI
- Edit binding: pre-populates the detect + device/action form with saved values
- Homey local API token persistence: saved to `homey.settings` and restored to the Manage page on reload
- Automatic flow creation via Homey's local REST API (Advanced Flow → Basic Flow fallback)
- Settings page in the Homey app: Manage Device Control button, WiFi device creation form, token field
- Proxy Control: `release_hub` flow action and matching `/manage/release` + `/manage/resume` HTTP endpoints
- `app_mode` capability toggle on the device card for quick hub release

### Changed
- HTTP server moved to port 8300 (was ephemeral in earlier builds)
- Manage page served at `/manage/` with all API endpoints under the same origin

---

## [0.2.0] — 2026-06

### Added
- WiFi device support: create virtual HTTP devices on the X2 hub from Homey
- `/manage/create` endpoint registers a new WiFi device with the hub and stores the config
- `/manage/wifi-device/re-register` refreshes the callback URL after Homey's IP changes
- WiFi device delete endpoint
- Manage page: initial web UI for WiFi device management (accessible at `http://<homey-ip>:8300/manage/`)
- `create_wifi_device` Flow action card
- `get_callback_url` Flow action card (returns callback base URL, port, and manage URL as tokens)

---

## [0.1.0] — 2026-05

### Added
- Initial release
- Manual IP pairing via Homey pair wizard
- Local UDP `CALL_ME` handshake with the X2 hub (port 8102)
- TCP callback connection on hub-assigned port
- SofaBaton binary frame parser (A5 5A header, opcode, payload, checksum)
- Activity catalog import (`0xD53B` rows) and device catalog import (`0xD50B` rows)
- `send_command` Flow action — send a raw command to any cataloged device
- `start_activity` and `stop_activity` Flow actions
- `button_pressed` Flow trigger — fires on every X2 button press with button name, device name, key ID, and activity ID tokens
- `activity_changed` Flow trigger — fires when the active activity switches
- `refresh_catalog` Flow action
- mDNS advertisement so the X2 hub can discover Homey's callback address automatically
- MQTT subscription support (optional) for activity state sync
