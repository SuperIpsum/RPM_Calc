/* ---------------------------------------------------------
   RPM Coach — lógica principal
   Vistas: profiles | editor | dashboard | settings
--------------------------------------------------------- */

const STORAGE_PROFILES = "rpmcoach_profiles";
const STORAGE_ACTIVE = "rpmcoach_active";

const state = {
  view: "profiles",
  editingId: null,
  profiles: loadProfiles(),
  activeId: localStorage.getItem(STORAGE_ACTIVE),
  speedKmh: 0,
  speedHistory: [],
  speedSourceStatus: "Buscando GPS…",
  obdConnected: false,
  watchId: null,
  lastFix: null,
};

function loadProfiles() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_PROFILES)) || [];
  } catch (e) {
    return [];
  }
}
function saveProfiles() {
  localStorage.setItem(STORAGE_PROFILES, JSON.stringify(state.profiles));
}
function setActive(id) {
  state.activeId = id;
  localStorage.setItem(STORAGE_ACTIVE, id);
}
function getActiveProfile() {
  return state.profiles.find((p) => p.id === state.activeId) || null;
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------------- RPM math ---------------- */

function tireCircumferenceM(width, aspect, rim) {
  const sidewallMm = width * (aspect / 100);
  const diameterMm = rim * 25.4 + 2 * sidewallMm;
  return (Math.PI * diameterMm) / 1000;
}

function engineRpmForGear(speedKmh, circumferenceM, gearRatio, finalDrive) {
  if (speedKmh <= 0) return 0;
  const speedMPerMin = (speedKmh * 1000) / 60;
  const wheelRpm = speedMPerMin / circumferenceM;
  return wheelRpm * gearRatio * finalDrive;
}

function zoneBreaks(profile) {
  const range = profile.maxRpm - profile.idleRpm;
  return {
    blueMax: profile.idleRpm + (range * profile.zones.blue) / 100,
    greenMax: profile.idleRpm + (range * profile.zones.green) / 100,
    yellowMax: profile.idleRpm + (range * profile.zones.yellow) / 100,
  };
}

function zoneFor(rpm, profile) {
  const b = zoneBreaks(profile);
  if (rpm <= b.blueMax) return "blue";
  if (rpm <= b.greenMax) return "green";
  if (rpm <= b.yellowMax) return "yellow";
  return "red";
}

function recommendGear(speedKmh, profile) {
  const circ = tireCircumferenceM(profile.tireWidth, profile.tireAspect, profile.tireRim);
  const options = profile.gearRatios.map((ratio, idx) => {
    const rpm = engineRpmForGear(speedKmh, circ, ratio, profile.finalDrive);
    return { gear: idx + 1, rpm, zone: zoneFor(rpm, profile) };
  });

  const greens = options.filter((o) => o.zone === "green");
  if (greens.length) {
    const best = greens.reduce((a, b) => (b.gear > a.gear ? b : a));
    return { ...best, options };
  }

  const b = zoneBreaks(profile);
  const greenMid = (b.blueMax + b.greenMax) / 2;
  const best = options.reduce((a, c) =>
    Math.abs(c.rpm - greenMid) < Math.abs(a.rpm - greenMid) ? c : a
  );
  return { ...best, options };
}

/* ---------------- Speed sources ---------------- */

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function startGPS() {
  stopGPS();
  if (!("geolocation" in navigator)) {
    state.speedSourceStatus = "GPS no disponible en este navegador";
    render();
    return;
  }
  state.speedSourceStatus = "Buscando GPS…";
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      let kmh;
      if (typeof pos.coords.speed === "number" && pos.coords.speed !== null) {
        kmh = Math.max(0, pos.coords.speed * 3.6);
      } else if (state.lastFix) {
        const dist = haversineMeters(state.lastFix, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        const dt = (pos.timestamp - state.lastFix.t) / 1000;
        kmh = dt > 0 ? Math.max(0, (dist / dt) * 3.6) : state.speedKmh;
      } else {
        kmh = 0;
      }
      state.lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: pos.timestamp };
      state.speedKmh = smoothSpeed(kmh);
      state.speedSourceStatus = "GPS activo";
      pushHistory(state.speedKmh);
      tick();
    },
    (err) => {
      state.speedSourceStatus = "Sin señal GPS (" + err.message + ")";
      state.speedKmh = 0;
      state.lastFix = null;
      pushHistory(0);
      tick();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 8000 }
  );
}

function stopGPS() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.lastFix = null;
}

function smoothSpeed(kmh) {
  const prev = state.speedKmh;
  return prev + (kmh - prev) * 0.35;
}

function pushHistory(v) {
  state.speedHistory.push(v);
  if (state.speedHistory.length > 40) state.speedHistory.shift();
}

/* ---- OBD2 (experimental, Web Bluetooth / ELM327 BLE) ---- */

let obdDevice = null;
let obdChar = null;

async function connectOBD2() {
  if (!navigator.bluetooth) {
    state.speedSourceStatus = "Este navegador no soporta Bluetooth (probá Chrome Android)";
    render();
    return;
  }
  try {
    state.speedSourceStatus = "Buscando adaptador OBD2…";
    render();
    obdDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        "0000ffe0-0000-1000-8000-00805f9b34fb",
        "0000fff0-0000-1000-8000-00805f9b34fb",
      ],
    });
    const server = await obdDevice.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService("0000ffe0-0000-1000-8000-00805f9b34fb");
    } catch (e) {
      service = await server.getPrimaryService("0000fff0-0000-1000-8000-00805f9b34fb");
    }
    const chars = await service.getCharacteristics();
    obdChar = chars.find((c) => c.properties.notify) || chars[0];
    await obdChar.startNotifications();
    obdChar.addEventListener("characteristicvaluechanged", onOBDData);
    state.obdConnected = true;
    state.speedSourceStatus = "OBD2 conectado";
    render();
    pollOBD();
  } catch (e) {
    state.speedSourceStatus = "No se pudo conectar OBD2 (" + e.message + ")";
    render();
  }
}

async function pollOBD() {
  if (!state.obdConnected) return;
  try {
    const encoder = new TextEncoder();
    await obdChar.writeValue(encoder.encode("010D\r")); // Vehicle speed PID
  } catch (e) {
    /* ignore single poll failure */
  }
  setTimeout(pollOBD, 500);
}

function onOBDData(event) {
  const decoder = new TextDecoder();
  const text = decoder.decode(event.target.value);
  const match = text.match(/41\s?0D\s?([0-9A-Fa-f]{2})/);
  if (match) {
    const kmh = parseInt(match[1], 16);
    state.speedKmh = smoothSpeed(kmh);
    pushHistory(state.speedKmh);
    tick();
  }
}

function disconnectOBD2() {
  state.obdConnected = false;
  try {
    if (obdDevice && obdDevice.gatt.connected) obdDevice.gatt.disconnect();
  } catch (e) {}
}

function setSpeedSource(profile, source) {
  profile.speedSource = source;
  saveProfiles();
  if (source === "gps") {
    disconnectOBD2();
    startGPS();
  } else {
    stopGPS();
    connectOBD2();
  }
  render();
}

/* ---------------- Rendering ---------------- */

const app = document.getElementById("app");

function render() {
  if (state.view === "profiles") return renderProfiles();
  if (state.view === "editor") return renderEditor();
  if (state.view === "dashboard") return renderDashboard();
  if (state.view === "settings") return renderSettings();
}

function go(view, editingId = null) {
  state.view = view;
  state.editingId = editingId;
  render();
}

/* ---- Profiles list ---- */
function renderProfiles() {
  const list = state.profiles
    .map(
      (p) => `
      <div class="profile-card" data-select="${p.id}">
        <div>
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${p.gearRatios.length} marchas · ${p.tireWidth}/${p.tireAspect} R${p.tireRim} · máx ${p.maxRpm} rpm</div>
        </div>
        <button class="edit-btn" data-edit="${p.id}">Editar</button>
      </div>`
    )
    .join("");

  app.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <span class="app-title">RPM Coach</span>
      </div>
      <h1 class="page-title">Tus perfiles</h1>
      ${list || `<div class="empty-state">Todavía no cargaste ningún auto.<br/>Creá tu primer perfil para empezar.</div>`}
      <div class="spacer"></div>
      <button class="btn-primary" id="newProfileBtn">+ Nuevo perfil</button>
    </div>
  `;

  app.querySelectorAll("[data-select]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit]")) return;
      const id = el.getAttribute("data-select");
      setActive(id);
      go("dashboard");
      const profile = getActiveProfile();
      if (profile.speedSource === "obd2") connectOBD2();
      else startGPS();
    })
  );
  app.querySelectorAll("[data-edit]").forEach((el) =>
    el.addEventListener("click", () => go("editor", el.getAttribute("data-edit")))
  );
  document.getElementById("newProfileBtn").addEventListener("click", () => go("editor", null));
}

/* ---- Profile editor ---- */
function blankProfile() {
  return {
    id: uid(),
    name: "",
    tireWidth: 195,
    tireAspect: 65,
    tireRim: 15,
    gearRatios: [3.5, 2.1, 1.4, 1.0, 0.8],
    finalDrive: 1.0,
    idleRpm: 800,
    maxRpm: 6000,
    zones: { blue: 40, green: 75, yellow: 90 },
    speedSource: "gps",
  };
}

function renderEditor() {
  const editing = state.editingId ? state.profiles.find((p) => p.id === state.editingId) : null;
  const draft = editing ? JSON.parse(JSON.stringify(editing)) : blankProfile();

  const gearRows = () =>
    draft.gearRatios
      .map(
        (r, i) => `
      <div class="gear-ratio-row">
        <span class="g-label">Marcha ${i + 1}</span>
        <input type="number" step="0.01" min="0.1" value="${r}" data-gear-idx="${i}" />
        ${draft.gearRatios.length > 1 ? `<button class="icon-btn" data-remove-gear="${i}" style="width:34px;height:34px;font-size:15px;">✕</button>` : ""}
      </div>`
      )
      .join("");

  function paint() {
    app.innerHTML = `
      <div class="screen">
        <div class="topbar">
          <button class="icon-btn" id="backBtn">←</button>
          <span class="app-title">${editing ? "Editar perfil" : "Nuevo perfil"}</span>
          <span style="width:42px"></span>
        </div>

        <div class="field">
          <label>Nombre del perfil</label>
          <input type="text" id="f-name" placeholder="Ej: Fiat 128 de casa" value="${escapeAttr(draft.name)}" />
        </div>

        <div class="section-title">Neumático</div>
        <div class="row3">
          <div class="field"><label>Ancho</label><input type="number" id="f-width" value="${draft.tireWidth}" /></div>
          <div class="field"><label>Perfil</label><input type="number" id="f-aspect" value="${draft.tireAspect}" /></div>
          <div class="field"><label>Rodado</label><input type="number" id="f-rim" value="${draft.tireRim}" /></div>
        </div>
        <div class="field"><span class="hint">Se lee en el costado de la goma, ej: 195/65 R15</span></div>

        <div class="section-title">Caja de cambios</div>
        <div id="gearRows">${gearRows()}</div>
        <button class="btn-ghost" id="addGearBtn" style="margin-bottom:16px;">+ Agregar marcha</button>

        <div class="field">
          <label>Relación final (diferencial)</label>
          <input type="number" step="0.01" min="0.1" id="f-final" value="${draft.finalDrive}" />
          <span class="hint">Obligatoria. Si no la sabés, dejá 1.00 y ajustala con el uso.</span>
        </div>

        <div class="section-title">RPM del motor</div>
        <div class="row2">
          <div class="field"><label>RPM ralentí</label><input type="number" id="f-idle" value="${draft.idleRpm}" /></div>
          <div class="field"><label>RPM máximo</label><input type="number" id="f-max" value="${draft.maxRpm}" /></div>
        </div>

        <div class="section-title">Zonas de color (% entre ralentí y máximo)</div>
        <div class="zone-slider-row">
          <div class="zs-head"><span style="color:var(--zone-blue)">Azul hasta</span><span id="v-blue">${draft.zones.blue}%</span></div>
          <input type="range" min="5" max="90" id="f-zblue" value="${draft.zones.blue}" />
        </div>
        <div class="zone-slider-row">
          <div class="zs-head"><span style="color:var(--zone-green)">Verde hasta</span><span id="v-green">${draft.zones.green}%</span></div>
          <input type="range" min="10" max="95" id="f-zgreen" value="${draft.zones.green}" />
        </div>
        <div class="zone-slider-row">
          <div class="zs-head"><span style="color:var(--zone-yellow)">Amarillo hasta</span><span id="v-yellow">${draft.zones.yellow}%</span></div>
          <input type="range" min="15" max="99" id="f-zyellow" value="${draft.zones.yellow}" />
        </div>
        <div class="field"><span class="hint">Por encima del amarillo, la zona es roja.</span></div>

        <div class="spacer"></div>
        <button class="btn-primary" id="saveBtn">Guardar perfil</button>
        ${editing ? `<button class="danger-link" id="deleteBtn">Eliminar perfil</button>` : ""}
      </div>
    `;

    document.getElementById("backBtn").addEventListener("click", () => go(editing ? "profiles" : "profiles"));

    app.querySelectorAll("[data-gear-idx]").forEach((el) =>
      el.addEventListener("input", (e) => {
        draft.gearRatios[parseInt(el.getAttribute("data-gear-idx"))] = parseFloat(e.target.value) || 0;
      })
    );
    app.querySelectorAll("[data-remove-gear]").forEach((el) =>
      el.addEventListener("click", () => {
        draft.gearRatios.splice(parseInt(el.getAttribute("data-remove-gear")), 1);
        document.getElementById("gearRows").innerHTML = gearRows();
        rebindGearRows();
      })
    );
    document.getElementById("addGearBtn").addEventListener("click", () => {
      draft.gearRatios.push(0.7);
      document.getElementById("gearRows").innerHTML = gearRows();
      rebindGearRows();
    });

    function rebindGearRows() {
      app.querySelectorAll("[data-gear-idx]").forEach((el) =>
        el.addEventListener("input", (e) => {
          draft.gearRatios[parseInt(el.getAttribute("data-gear-idx"))] = parseFloat(e.target.value) || 0;
        })
      );
      app.querySelectorAll("[data-remove-gear]").forEach((el) =>
        el.addEventListener("click", () => {
          draft.gearRatios.splice(parseInt(el.getAttribute("data-remove-gear")), 1);
          document.getElementById("gearRows").innerHTML = gearRows();
          rebindGearRows();
        })
      );
    }

    const zblue = document.getElementById("f-zblue");
    const zgreen = document.getElementById("f-zgreen");
    const zyellow = document.getElementById("f-zyellow");
    zblue.addEventListener("input", () => {
      document.getElementById("v-blue").textContent = zblue.value + "%";
    });
    zgreen.addEventListener("input", () => {
      document.getElementById("v-green").textContent = zgreen.value + "%";
    });
    zyellow.addEventListener("input", () => {
      document.getElementById("v-yellow").textContent = zyellow.value + "%";
    });

    document.getElementById("saveBtn").addEventListener("click", () => {
      draft.name = document.getElementById("f-name").value.trim() || "Mi auto";
      draft.tireWidth = parseFloat(document.getElementById("f-width").value) || 195;
      draft.tireAspect = parseFloat(document.getElementById("f-aspect").value) || 65;
      draft.tireRim = parseFloat(document.getElementById("f-rim").value) || 15;
      draft.finalDrive = parseFloat(document.getElementById("f-final").value) || 1.0;
      draft.idleRpm = parseFloat(document.getElementById("f-idle").value) || 800;
      draft.maxRpm = parseFloat(document.getElementById("f-max").value) || 6000;
      draft.zones = {
        blue: parseInt(zblue.value),
        green: parseInt(zgreen.value),
        yellow: parseInt(zyellow.value),
      };
      draft.gearRatios = draft.gearRatios.filter((r) => r > 0);
      if (draft.gearRatios.length === 0) draft.gearRatios = [1];

      const idx = state.profiles.findIndex((p) => p.id === draft.id);
      if (idx >= 0) state.profiles[idx] = draft;
      else state.profiles.push(draft);
      saveProfiles();
      setActive(draft.id);
      go("dashboard");
      startGPS();
    });

    if (editing) {
      document.getElementById("deleteBtn").addEventListener("click", () => {
        state.profiles = state.profiles.filter((p) => p.id !== editing.id);
        saveProfiles();
        if (state.activeId === editing.id) {
          state.activeId = null;
          localStorage.removeItem(STORAGE_ACTIVE);
        }
        go("profiles");
      });
    }
  }

  paint();
}

/* ---- Dashboard ---- */
function renderDashboard() {
  const profile = getActiveProfile();
  if (!profile) return go("profiles");

  const rows = profile.gearRatios
    .map(
      (_, idx) => `
      <div class="reel-row" data-gear="${idx}" data-offset="9">
        <span class="g-name"></span>
        <span class="g-rpm"></span>
      </div>`
    )
    .join("");

  app.innerHTML = `
    <div class="screen dash">
      <div class="topbar">
        <button class="icon-btn" id="profilesBtn">☰</button>
        <span class="app-title">RPM Coach</span>
        <button class="icon-btn" id="gearIconBtn">⚙</button>
      </div>

      <div class="speed-pill">
        <span class="speed-value" id="speedValue">${pad3(Math.round(state.speedKmh))} km/h</span>
      </div>

      <svg class="trace" viewBox="0 0 300 70" preserveAspectRatio="none">
        <polyline id="traceLine" points="${tracePoints()}" fill="none" stroke="var(--line)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>

      <div class="source-tag" id="sourceTag"><b>${profile.speedSource === "gps" ? "GPS" : "OBD2"}</b> · ${state.speedSourceStatus}</div>

      <div class="wheel-wrap">
        <div class="gear-reel">
          <div class="reel-frame-bg"></div>
          <div class="reel-track" id="reelTrack">${rows}</div>
          <div class="reel-lens" id="reelLens"></div>
          <div class="reel-edge-fade"></div>
          <span class="reel-axle left"></span>
          <span class="reel-axle right"></span>
        </div>
      </div>

      <div class="profile-strip">Perfil activo: <b>${escapeHtml(profile.name)}</b></div>
    </div>
  `;

  document.getElementById("profilesBtn").addEventListener("click", () => go("profiles"));
  document.getElementById("gearIconBtn").addEventListener("click", () => go("settings"));

  state.dashboardBuiltFor = profile.id;
  updateDashboardData(profile);
}

function updateDashboardData(profile) {
  profile = profile || getActiveProfile();
  if (!profile) return;

  const speedEl = document.getElementById("speedValue");
  if (speedEl) speedEl.textContent = pad3(Math.round(state.speedKmh)) + " km/h";

  const traceEl = document.getElementById("traceLine");
  if (traceEl) traceEl.setAttribute("points", tracePoints());

  const sourceEl = document.getElementById("sourceTag");
  if (sourceEl) {
    sourceEl.innerHTML = `<b>${profile.speedSource === "gps" ? "GPS" : "OBD2"}</b> · ${state.speedSourceStatus}`;
  }

  const rec = recommendGear(state.speedKmh, profile);
  const centerIdx = rec.gear - 1;

  document.querySelectorAll(".reel-row").forEach((row) => {
    const idx = parseInt(row.getAttribute("data-gear"));
    const opt = rec.options[idx];
    const offset = idx - centerIdx;
    const absOffset = Math.abs(offset);

    row.classList.remove("zone-blue", "zone-green", "zone-yellow", "zone-red");
    if (absOffset <= 2) {
      row.classList.add("zone-" + opt.zone);
      row.setAttribute("data-offset", String(absOffset));
      row.style.transform = reelRowTransform(offset);
      row.style.opacity = absOffset === 0 ? "1" : absOffset === 1 ? "0.82" : "0.4";
      row.style.pointerEvents = "none";
      row.querySelector(".g-name").textContent = gearOrdinal(idx + 1);
      row.querySelector(".g-rpm").textContent = Math.round(opt.rpm) + " RPM";
    } else {
      row.style.opacity = "0";
      row.style.transform = reelRowTransform(offset);
    }
  });

  const lens = document.getElementById("reelLens");
  if (lens) {
    lens.classList.remove("zone-blue", "zone-green", "zone-yellow", "zone-red");
    lens.classList.add("zone-" + rec.zone);
  }
}

function tick() {
  if (state.view !== "dashboard") return;
  const profile = getActiveProfile();
  if (profile && state.dashboardBuiltFor === profile.id) {
    updateDashboardData(profile);
  } else {
    render();
  }
}

function tracePoints() {
  const h = state.speedHistory.slice(-30);
  if (h.length < 2) return "0,35 300,35";
  const max = Math.max(...h, 1);
  const min = Math.min(...h, 0);
  const range = Math.max(max - min, 1);
  return h
    .map((v, i) => {
      const x = (i / (h.length - 1)) * 300;
      const y = 60 - ((v - min) / range) * 50;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function zoneLabel(zone) {
  return { blue: "Muy por debajo", green: "Marcha ideal", yellow: "Precaución", red: "Riesgo" }[zone];
}

const GEAR_ORDINALS = ["1ERA", "2DA", "3ERA", "4TA", "5TA", "6TA", "7MA", "8VA", "9NA"];
function gearOrdinal(n) {
  return GEAR_ORDINALS[n - 1] || n + "ª";
}

const REEL_ANGLE = 20; // degrees of tilt per step (visual only, never enlarges)
const REEL_STEP = 60; // px vertical distance per gear step
const REEL_PUSHBACK = 46; // px pushed away from viewer per step (shrinks, never grows)

function reelRowTransform(offset) {
  const abs = Math.abs(offset);
  return `translateY(${offset * REEL_STEP}px) rotateX(${-offset * REEL_ANGLE}deg) translateZ(${-abs * REEL_PUSHBACK}px)`;
}

function pad3(n) {
  return String(Math.max(0, n)).padStart(3, "0");
}

/* ---- Settings ---- */
function renderSettings() {
  const profile = getActiveProfile();
  if (!profile) return go("profiles");

  app.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="icon-btn" id="backBtn">←</button>
        <span class="app-title">Ajustes</span>
        <span style="width:42px"></span>
      </div>

      <div class="section-title" style="margin-top:0;">Fuente de velocidad</div>
      <div class="toggle-row">
        <button id="srcGps" class="${profile.speedSource === "gps" ? "active" : ""}">GPS</button>
        <button id="srcObd" class="${profile.speedSource === "obd2" ? "active" : ""}">OBD2 (Bluetooth)</button>
      </div>
      <p class="status-note ${profile.speedSource === "obd2" ? "warn" : ""}">
        ${profile.speedSource === "obd2"
          ? "Experimental: requiere un adaptador ELM327 por Bluetooth Low Energy y Chrome en Android. No todos los adaptadores son compatibles."
          : "Usa la ubicación del celular para calcular la velocidad. Funciona en cualquier auto, incluso sin OBD2."}
      </p>

      <div class="section-title">Perfil</div>
      <button class="btn-ghost" id="editProfileBtn" style="margin-bottom:10px; width:100%;">Editar datos de "${escapeHtml(profile.name)}"</button>
      <button class="btn-ghost" id="switchProfileBtn" style="width:100%;">Cambiar de perfil</button>

      <div class="spacer"></div>
      <p class="status-note">RPM Coach calcula las revoluciones a partir de la velocidad y los datos que cargaste — no lee el tacómetro real del auto.</p>
    </div>
  `;

  document.getElementById("backBtn").addEventListener("click", () => go("dashboard"));
  document.getElementById("srcGps").addEventListener("click", () => setSpeedSource(profile, "gps"));
  document.getElementById("srcObd").addEventListener("click", () => setSpeedSource(profile, "obd2"));
  document.getElementById("editProfileBtn").addEventListener("click", () => go("editor", profile.id));
  document.getElementById("switchProfileBtn").addEventListener("click", () => go("profiles"));
}

/* ---------------- Utils ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------------- Boot ---------------- */
function boot() {
  const active = getActiveProfile();
  if (active) {
    state.view = "dashboard";
    render();
    if (active.speedSource === "obd2") connectOBD2();
    else startGPS();
  } else {
    render();
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

boot();
