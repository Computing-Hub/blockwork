/*
 * MqttClient — a non-visible component that talks to an MQTT broker so apps can
 * read IoT sensors and build live dashboards.
 *
 * Browsers can't open raw MQTT/TCP, so this connects over WebSockets — the
 * BrokerUrl must be a ws:// or (over HTTPS) wss:// address. A Python/paho
 * publisher can still use plain TCP; the broker bridges the two.
 *
 * The MQTT.js library is loaded from a CDN on first Connect (kept out of the
 * editor's initial load). Incoming messages land in the read-only LastTopic /
 * LastMessage properties and fire MessageReceived — so a dashboard is just:
 *   when MqttClient.MessageReceived -> set Label.Text to MqttClient.LastMessage
 *
 * Typical usage: Connect, then Subscribe inside the Connected event.
 *
 * Several readings can share one topic: the payload says which is which.
 * Each message is decoded into named fields, so blocks can route them:
 *   when MqttClient.MessageReceived
 *     if MqttClient.HasField("temp")     -> set Gauge.Value to MqttClient.GetField("temp")
 *     if MqttClient.HasField("humidity") -> call LineChart.AddPoint(MqttClient.GetField("humidity"))
 * Understood payloads (see decodePayload): temp:23.5 · temp=23.5 ·
 * temp:23.5,humidity:60 · {"temp": 23.5, "humidity": 60}. A plain value
 * like 23.5 has no fields; use LastMessage for those.
 */

const MQTT_CDN = "https://unpkg.com/mqtt@5/dist/mqtt.min.js";

// One live client per component instance (so Disconnect ends the right one).
const clients = new Map();
// The decoded fields of each instance's last message.
const lastFields = new Map();

/**
 * Turn a payload into named fields: { temp: 23.5, humidity: 60 }.
 * Numbers become numbers; anything that isn't name/value pairs gives {}.
 */
export function decodePayload(payload) {
  const text = String(payload ?? "").trim();
  const value = (v) => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    return t !== "" && Number.isFinite(Number(t)) ? Number(t) : t;
  };
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, value(v)]));
      }
    } catch { /* not JSON: fall through */ }
  }
  const fields = {};
  for (const part of text.split(/[,;&\n]+/)) {
    const m = /^\s*([A-Za-z_][\w.-]*)\s*[:=]\s*(.*?)\s*$/.exec(part);
    if (!m) return {};                     // not all name/value pairs: treat as a plain value
    fields[m[1]] = value(m[2]);
  }
  return fields;
}

let mqttLoad = null;
function loadMqtt() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  if (!mqttLoad) {
    mqttLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = MQTT_CDN;
      s.onload = () => resolve(window.mqtt);
      s.onerror = () => reject(new Error("Could not load the MQTT library (needs a network connection)."));
      document.head.append(s);
    });
  }
  return mqttLoad;
}

export const MqttClient = {
  name: "MqttClient",
  category: "IoT",
  icon: "📡",
  visible: false,
  help: "Connects to an MQTT broker over WebSockets to send/receive messages.",

  properties: {
    BrokerUrl: { type: "string", default: "wss://test.mosquitto.org:8081", editable: true },
    Username: { type: "string", default: "", editable: true },
    Password: { type: "password", default: "", editable: true },
    ClientId: { type: "string", default: "", editable: true }, // blank = auto-generated
    // Read-only readings (getter blocks only):
    LastTopic: { type: "string", default: "", editable: false },
    LastMessage: { type: "string", default: "", editable: false },
    // For one-reading messages like temp:23.5 -> LastKey "temp", LastValue 23.5
    LastKey: { type: "string", default: "", editable: false },
    LastValue: { type: "string", default: "", editable: false },
    IsConnected: { type: "boolean", default: false, editable: false },
  },

  events: {
    Connected: { params: [] },
    Disconnected: { params: [] },
    MessageReceived: { params: [] },
    MqttError: { params: [] },
  },

  methods: {
    Connect: {
      params: [],
      run: async (_el, _args, ctx) => {
        // The live Preview runs in a sandboxed iframe with an opaque ("null")
        // origin, and browsers block WebSockets there — so MQTT can only connect
        // in the exported app (a real origin). Fail fast with a clear reason
        // instead of silently flapping "Disconnected".
        if (window.location.origin === "null") {
          console.warn(
            "MQTT can't connect inside the sandboxed Preview (no network origin). " +
            "Use Export PWA and open the app to connect to the broker."
          );
          // Defer so a `when MqttError` handler registered later in the same
          // startup run (block order) is in place to receive it.
          setTimeout(() => ctx.dispatch("MqttError"), 0);
          return;
        }

        let mqtt;
        try { mqtt = await loadMqtt(); }
        catch (err) { console.warn(err.message); ctx.dispatch("MqttError"); return; }

        // Replace any existing connection (lets you change BrokerUrl and reconnect).
        const existing = clients.get(ctx.id);
        if (existing) { try { existing.end(true); } catch {} clients.delete(ctx.id); }

        const opts = {};
        const user = ctx.app.get(ctx.id, "Username");
        const pass = ctx.app.get(ctx.id, "Password");
        const cid = ctx.app.get(ctx.id, "ClientId");
        if (user) opts.username = user;
        if (pass) opts.password = pass;
        if (cid) opts.clientId = cid;

        const url = ctx.app.get(ctx.id, "BrokerUrl");
        let client;
        try { client = mqtt.connect(url, opts); }
        catch (err) { console.warn("MQTT connect failed:", err.message); ctx.dispatch("MqttError"); return; }
        clients.set(ctx.id, client);

        client.on("connect", () => { ctx.app.set(ctx.id, "IsConnected", true); ctx.dispatch("Connected"); });
        client.on("close", () => { ctx.app.set(ctx.id, "IsConnected", false); ctx.dispatch("Disconnected"); });
        client.on("error", (err) => { console.warn("MQTT error:", err && err.message); ctx.dispatch("MqttError"); });
        client.on("message", (topic, payload) => {
          const text = payload.toString();
          const fields = decodePayload(text);
          const [firstKey = "", firstValue = ""] = Object.entries(fields)[0] ?? [];
          lastFields.set(ctx.id, fields);
          ctx.app.set(ctx.id, "LastTopic", topic);
          ctx.app.set(ctx.id, "LastMessage", text);
          ctx.app.set(ctx.id, "LastKey", firstKey);
          ctx.app.set(ctx.id, "LastValue", firstValue);
          ctx.dispatch("MessageReceived");
        });
      },
    },

    Subscribe: {
      params: [{ name: "topic", type: "string" }],
      run: (_el, [topic], ctx) => {
        const client = clients.get(ctx.id);
        if (!client) { console.warn("MqttClient: call Connect before Subscribe."); return; }
        client.subscribe(String(topic));
      },
    },

    Unsubscribe: {
      params: [{ name: "topic", type: "string" }],
      run: (_el, [topic], ctx) => {
        const client = clients.get(ctx.id);
        if (client) client.unsubscribe(String(topic));
      },
    },

    Publish: {
      params: [{ name: "topic", type: "string" }, { name: "message", type: "string" }],
      run: (_el, [topic, message], ctx) => {
        const client = clients.get(ctx.id);
        if (!client) { console.warn("MqttClient: call Connect before Publish."); return; }
        client.publish(String(topic), String(message));
      },
    },

    // Read a named reading from the last message, e.g. GetField("temp") -> 23.5
    GetField: {
      params: [{ name: "name", type: "string" }],
      returns: "any",
      run: (_el, [name], ctx) => {
        const fields = lastFields.get(ctx.id) ?? {};
        return Object.prototype.hasOwnProperty.call(fields, String(name)) ? fields[String(name)] : "";
      },
    },

    // Is this reading in the last message? Use it to send each reading to its widget.
    HasField: {
      params: [{ name: "name", type: "string" }],
      returns: "boolean",
      run: (_el, [name], ctx) => Object.prototype.hasOwnProperty.call(lastFields.get(ctx.id) ?? {}, String(name)),
    },

    Disconnect: {
      params: [],
      run: (_el, _args, ctx) => {
        const client = clients.get(ctx.id);
        if (client) { client.end(); clients.delete(ctx.id); }
        ctx.app.set(ctx.id, "IsConnected", false);
      },
    },
  },

  runtime: { create: () => null, update: () => {}, wireEvents: () => {} },
};
