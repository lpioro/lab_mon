"use strict";

const byId = id => document.getElementById(id);
const text = (id, value) => { byId(id).textContent = value; };
const html = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const guestKey = guest => `${guest.source}/${guest.kind}/${guest.vmid}`;
const statusNames = { running: "Uruchomiony", stopped: "Zatrzymany", online: "Online", offline: "Offline" };

let data = { dashboard: {}, sources: [], services: [] };
let selected = null;
let currentView = "topology";
let initialized = false;
let refreshing = false;
let timer;
const configForm = byId("config-form");
const preferenceKey = "lab-mon-appearance-v1";
let downloadUrl = null;

function stateBadge(status) {
  const active = status === "online" || status === "running";
  const label = Object.hasOwn(statusNames, status) ? statusNames[status] : "Brak stanu";
  return `<span class="badge ${active ? "text-bg-success" : "text-bg-secondary"}">${label}</span>`;
}

function addresses(guest) {
  return guest.networks.flatMap(network => [network.ipv4, network.ipv6]).filter(Boolean);
}

function guestName(guest) {
  return `${guest.kind === "lxc" ? "CT" : "VM"} ${guest.vmid}`;
}

function guestServices(guest) {
  return data.services.filter(service => service.source === guest.source && service.vmid === guest.vmid);
}

function selectView(view) {
  currentView = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
  }
  byId("topology-view").hidden = view !== "topology";
  byId("table-view").hidden = view !== "table";
  byId("config-view").hidden = view !== "config";
  byId("history-view").hidden = view !== "history";
  byId("inventory-view").hidden = view !== "topology" && view !== "table";
  text("view-title", view === "table" ? "Tabela adresów" : "Topologia");
}

function setAppearance(appearance) {
  document.title = appearance.title;
  document.documentElement.dataset.bsTheme = appearance.theme;
  text("title", appearance.title);
  text("description", appearance.description);
}

function appearanceValues() {
  return Object.fromEntries(["title", "description", "theme", "default_view"]
    .map(key => [key, configForm.elements.namedItem(key).value.trim()]));
}

function addSettingsEntry(kind, values = {}) {
  const entry = byId(kind + "-template").content.firstElementChild.cloneNode(true);
  for (const field of entry.querySelectorAll("input, textarea")) {
    const value = values[field.name] ?? "";
    field.value = Array.isArray(value) ? value.join(", ") : value;
    if (Array.isArray(value)) {
      entry.dataset.dependencies = JSON.stringify(value);
      field.defaultValue = field.value;
    }
  }
  entry.querySelector("[data-remove]").addEventListener("click", () => {
    entry.remove();
    clearConfigOutput();
  });
  byId(kind === "source" ? "config-sources" : "config-services").append(entry);
}

function initConfiguration(settings) {
  const appearance = { ...settings };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    if (typeof saved?.title === "string" && saved.title && typeof saved.description === "string"
        && ["light", "dark"].includes(saved.theme) && ["topology", "table"].includes(saved.default_view)) {
      Object.assign(appearance, saved);
      text("appearance-status", "Wygląd zapisany w tej przeglądarce.");
    }
  } catch {
    // A private browser context may block storage.
  }
  for (const key of ["title", "description", "theme", "default_view", "refresh_seconds", "timeout_seconds"]) {
    configForm.elements.namedItem(key).value = appearance[key] ?? 5;
  }
  configForm.elements.namedItem("show_addresses").checked = settings.show_addresses;
  configForm.elements.namedItem("read_guest_networks").checked = settings.read_guest_networks ?? true;
  configForm.elements.namedItem("history_enabled").checked = settings.history?.enabled ?? true;
  configForm.elements.namedItem("interval_seconds").value = settings.history?.interval_seconds ?? 60;
  configForm.elements.namedItem("retention_days").value = settings.history?.retention_days ?? 30;
  if (settings.demo) {
    addSettingsEntry("source", {
      id: "lab", label: "Laboratorium", url: "https://proxmox.example.invalid:8006",
      token_id_env: "PVE_TOKEN_ID", token_secret_env: "PVE_TOKEN_SECRET",
    });
    text("config-origin", "Tryb demonstracyjny. Formularz zawiera przykładowe źródło.");
  } else {
    for (const source of data.source_configuration) addSettingsEntry("source", source);
    for (const service of data.services) addSettingsEntry("service", service);
    text("config-origin", settings.show_addresses
      ? "Ustawienia wczytane przy starcie aplikacji."
      : "Ustawienia wczytane przy starcie. Adresy źródeł i usług ukrywa opcja show_addresses.");
  }
  byId("restore-appearance").disabled = false;
  setAppearance(appearance);
  if (currentView === "topology") selectView(appearance.default_view);
}

function clearConfigOutput() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  byId("download-config").hidden = true;
  byId("download-config").removeAttribute("href");
  byId("config-output-label").hidden = true;
  byId("config-output").value = "";
  text("config-message", "");
}

function collectEntries(id) {
  return [...byId(id).querySelectorAll("fieldset")].map(entry =>
    Object.fromEntries([...entry.querySelectorAll("input, textarea")].map(field => {
      if (field.name === "depends_on") {
        const values = entry.dataset.dependencies && field.value === field.defaultValue
          ? JSON.parse(entry.dataset.dependencies)
          : field.value.split(",").map(item => item.trim()).filter(Boolean);
        return [field.name, values];
      }
      return [field.name, field.value.trim()];
    })));
}

function configToml() {
  const sources = collectEntries("config-sources");
  const sourceIds = new Set(sources.map(source => source.id));
  if (!sources.length) throw new Error("Dodaj przynajmniej jedno źródło.");
  if (sources.length !== sourceIds.size) throw new Error("Identyfikatory źródeł muszą być unikalne.");
  for (const source of sources) {
    const url = new URL(source.url);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
        || url.search || url.hash || url.port === "0") {
      throw new Error("Adres źródła musi być bazowym adresem HTTPS.");
    }
    if (!source.label) source.label = source.id;
    if (!source.ca_file) delete source.ca_file;
  }
  const services = collectEntries("config-services");
  for (const service of services) {
    if (!sourceIds.has(service.source) || !service.name) {
      throw new Error("Każda usługa wymaga nazwy i identyfikatora istniejącego źródła.");
    }
    service.vmid = Number(service.vmid);
  }
  const appearance = appearanceValues();
  if (!appearance.title) throw new Error("Wpisz tytuł dashboardu.");
  const dashboard = { ...appearance };
  for (const key of ["refresh_seconds", "timeout_seconds"]) {
    dashboard[key] = Number(configForm.elements.namedItem(key).value);
  }
  for (const key of ["read_guest_networks", "show_addresses"]) {
    dashboard[key] = configForm.elements.namedItem(key).checked;
  }
  const block = (name, fields) => [
    name, ...Object.entries(fields).map(([key, value]) =>
      `${key} = ${JSON.stringify(value).replace(/\x7f/g, "\\u007f")}`),
  ].join("\n");
  return [
    block("[dashboard]", dashboard),
    block("[history]", {
      enabled: configForm.elements.namedItem("history_enabled").checked,
      interval_seconds: Number(configForm.elements.namedItem("interval_seconds").value),
      retention_days: Number(configForm.elements.namedItem("retention_days").value),
    }),
    ...sources.map(source => block("[[proxmox]]", source)),
    ...services.map(service => block("[[services]]", service)),
  ].join("\n\n") + "\n";
}

byId("save-appearance").addEventListener("click", () => {
  const appearance = appearanceValues();
  if (!appearance.title) {
    text("appearance-status", "Wpisz tytuł dashboardu.");
    return;
  }
  setAppearance(appearance);
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(appearance));
    text("appearance-status", "Zapisano w tej przeglądarce.");
  } catch {
    text("appearance-status", "Zastosowano w bieżącym widoku.");
  }
});
byId("restore-appearance").addEventListener("click", () => {
  for (const key of ["title", "description", "theme", "default_view"]) {
    configForm.elements.namedItem(key).value = data.dashboard[key];
  }
  setAppearance(data.dashboard);
  clearConfigOutput();
  try {
    localStorage.removeItem(preferenceKey);
    text("appearance-status", "Przywrócono wygląd z konfiguracji.");
  } catch {
    text("appearance-status", "Przywrócono wygląd w bieżącym widoku.");
  }
});
byId("add-source").addEventListener("click", () => {
  addSettingsEntry("source");
  clearConfigOutput();
});
byId("add-service").addEventListener("click", () => {
  addSettingsEntry("service");
  clearConfigOutput();
});
configForm.addEventListener("input", clearConfigOutput);
configForm.addEventListener("submit", event => {
  event.preventDefault();
  clearConfigOutput();
  try {
    const result = configToml();
    byId("config-output").value = result;
    byId("config-output-label").hidden = false;
    downloadUrl = URL.createObjectURL(new Blob([result], { type: "application/toml" }));
    byId("download-config").href = downloadUrl;
    byId("download-config").hidden = false;
    text("config-message", "TOML gotowy do pobrania lub skopiowania.");
  } catch (error) {
    text("config-message", error.message);
  }
});

function render() {
  const terms = byId("search").value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = values => {
    const searchable = values.join(" ").toLowerCase();
    return terms.every(term => searchable.includes(term));
  };
  const sourceFilter = byId("source-filter").value;
  const kindFilter = byId("kind-filter").value;
  const statusFilter = byId("status-filter").value;
  const allGuests = data.sources.flatMap(source => source.guests.map(guest => ({ ...guest, source: source.id })));
  const sources = data.sources.filter(source => !sourceFilter || source.id === sourceFilter);
  const groups = [];
  for (const source of sources) {
    const guests = allGuests.filter(guest => guest.source === source.id);
    const nodes = new Map(source.nodes.map(node => [node.name, node]));
    for (const guest of guests) {
      if (!nodes.has(guest.node)) nodes.set(guest.node, { name: guest.node });
    }
    for (const node of nodes.values()) {
      const identity = [source.label, source.id, node.name, node.ip];
      const visibleGuests = guests.filter(guest =>
        guest.node === node.name && (!kindFilter || guest.kind === kindFilter)
        && (!statusFilter || guest.status === statusFilter)
        && matches([...identity, guestName(guest), guest.name, ...addresses(guest),
          ...guest.networks.flatMap(network => [network.bridge, network.gateway, network.gateway6]),
          ...guestServices(guest).flatMap(service => [service.name, service.endpoint, ...service.depends_on])])
      );
      if (visibleGuests.length || (!kindFilter && !statusFilter && matches(identity))) {
        groups.push({ source, node, guests: visibleGuests });
      }
    }
  }
  const guests = groups.flatMap(group => group.guests);
  if (!guests.some(guest => guestKey(guest) === selected)) selected = guests[0] ? guestKey(guests[0]) : null;
  text("node-count", data.sources.reduce((count, source) => count + source.nodes.length, 0));
  text("lxc-count", allGuests.filter(guest => guest.kind === "lxc").length);
  text("vm-count", allGuests.filter(guest => guest.kind === "qemu").length);
  text("service-count", data.services.length);
  text("results", `${guests.length} / ${allGuests.length} gości`);

  const empty = '<p class="small text-body-secondary mb-0">Brak zasobów pasujących do filtrów.</p>';
  byId("topology-view").innerHTML = groups.length ? renderTopology(sources, groups) : empty;
  byId("table-view").innerHTML = groups.length ? renderTable(groups, guests) : empty;
  renderDetails(guests.find(guest => guestKey(guest) === selected));
}

function renderTopology(sources, groups) {
  return sources.map(source => {
    const nodes = groups.filter(group => group.source.id === source.id);
    if (!nodes.length) return "";
    return `<section class="canvas cluster">
      <h3 class="cluster-title">${html(source.label)}</h3>
      ${nodes.map(({node, guests}) => `<article class="node-box">
        <div class="d-flex align-items-center flex-wrap gap-2">
          <h4 class="host-title">${html(node.name)}</h4>${stateBadge(node.status)}
          ${node.ip ? `<code class="small">${html(node.ip)}</code>` : ""}
        </div>
        ${guests.length ? `<div class="guest-grid">${guests.map(guest => `<button type="button" class="guest" data-guest="${html(guestKey(guest))}" aria-controls="detail" aria-pressed="${guestKey(guest) === selected}">
          <span class="guest-label">${guestName(guest)}</span><span class="guest-name">${html(guest.name)}</span>
          <span class="guest-meta">${html(guest.networks.map(network => network.bridge).filter(Boolean).join(" · ") || "Most do ustalenia")}</span>
          <span class="guest-meta">${html(addresses(guest).join(" · ") || "Adres niedostępny")}</span>
        </button>`).join("")}</div>` : '<span class="small text-body-secondary">Brak widocznych gości.</span>'}
      </article>`).join("")}
    </section>`;
  }).join("");
}

function renderTable(groups, guests) {
  const addressCell = values => values.length ? values.map(value => `<code>${html(value)}</code>`).join("<br>") : "—";
  return `<div class="table-responsive" tabindex="0" role="region" aria-label="Węzły Proxmoxa">
    <table class="table table-sm align-middle"><caption class="caption-top">Węzły Proxmoxa</caption>
      <thead><tr><th scope="col">Źródło</th><th scope="col">Węzeł</th><th scope="col">Adres z API</th><th scope="col">Stan</th></tr></thead>
      <tbody>${groups.map(({source, node}) => `<tr><td>${html(source.label)}</td><th scope="row">${html(node.name)}</th>
        <td>${addressCell(node.ip ? [node.ip] : [])}</td><td>${stateBadge(node.status)}</td></tr>`).join("")}</tbody>
    </table>
  </div>${guests.length ? `<div class="table-responsive mt-3" tabindex="0" role="region" aria-label="Adresy gości">
    <table class="table table-sm align-middle"><caption class="caption-top">Adresy VM i LXC z konfiguracji</caption>
      <thead><tr><th scope="col">Zasób</th><th scope="col">Węzeł</th><th scope="col">Adres</th><th scope="col">Most</th><th scope="col">Stan</th></tr></thead>
      <tbody>${guests.map(guest => `<tr><th scope="row"><button type="button" class="btn btn-outline-secondary btn-sm text-start" data-guest="${html(guestKey(guest))}" aria-controls="detail" aria-pressed="${guestKey(guest) === selected}">
        <strong>${guestName(guest)}</strong> ${html(guest.name)}</button></th><td>${html(guest.node)}</td>
        <td>${addressCell(addresses(guest))}</td><td>${addressCell(guest.networks.map(network => network.bridge).filter(Boolean))}</td>
        <td>${stateBadge(guest.status)}</td></tr>`).join("")}</tbody>
    </table>
  </div>` : ""}`;
}

function renderDetails(guest) {
  const detail = byId("detail");
  if (!guest) {
    detail.innerHTML = '<h2 class="h5">Szczegóły zasobu</h2><p class="small text-body-secondary mb-0">Brak widocznego gościa.</p>';
    return;
  }
  const services = guestServices(guest);
  const source = data.sources.find(item => item.id === guest.source);
  const cpu = typeof guest.cpu === "number" ? `${Math.round(guest.cpu * 100)}% CPU` : "";
  const memory = typeof guest.mem === "number" && typeof guest.maxmem === "number"
    ? `${Math.round(guest.mem / 1048576)} / ${Math.round(guest.maxmem / 1048576)} MiB RAM` : "";
  detail.innerHTML = `<div class="d-flex align-items-start justify-content-between gap-2">
    <div><span class="guest-label">${guestName(guest)}</span><h2 id="detail-title" class="h5 mb-1" tabindex="-1">${html(guest.name)}</h2></div>${stateBadge(guest.status)}</div>
    <p class="small text-body-secondary mb-1">${html(source.label)} · ${html(guest.node)}</p>
    <p class="small mb-1">${[cpu, memory].filter(Boolean).join(" · ")}</p>
    <h3>Sieć z konfiguracji</h3>
    ${guest.networks.map(network => `<div class="detail-item"><strong>${html(network.name)}</strong>
      ${network.bridge ? ` · <code>${html(network.bridge)}</code>` : ""}${network.vlan ? ` · VLAN ${html(network.vlan)}` : ""}
      <p>${[network.ipv4, network.ipv6].filter(Boolean).map(ip => `<code>${html(ip)}</code>`).join(" · ") || "Adres niedostępny"}</p>
      ${[network.gateway, network.gateway6].filter(Boolean).map(gateway => `<p>Brama <code>${html(gateway)}</code></p>`).join("")}</div>`).join("")
      || `<p class="small text-body-secondary">${html(guest.network_state)}</p>`}
    <h3>Usługi i zależności</h3>
    ${services.map(service => `<div class="detail-item"><strong>${html(service.name)}</strong>
      ${service.endpoint ? `<p><code>${html(service.endpoint)}</code></p>` : ""}
      ${service.depends_on.length ? `<p>Zależy od ${service.depends_on.map(html).join(", ")}</p>` : ""}
      ${service.note ? `<p class="text-body-secondary">${html(service.note)}</p>` : ""}</div>`).join("")
      || '<p class="small text-body-secondary mb-0">Brak wpisów usług dla tego gościa.</p>'}`;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  clearTimeout(timer);
  byId("refresh").disabled = true;
  text("poll-status", "Pobieranie danych…");
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error("Brak odpowiedzi");
    data = await response.json();
    if (!initialized) {
      const settings = data.dashboard;
      text("mode", settings.demo ? "Tryb demonstracyjny" : "Tylko odczyt");
      initConfiguration(settings);
      initialized = true;
    }
    const filter = byId("source-filter");
    const previous = filter.value;
    filter.replaceChildren(new Option("Wszystkie źródła", ""), ...data.sources.map(source => new Option(source.label, source.id)));
    filter.value = data.sources.some(source => source.id === previous) ? previous : "";
    byId("sources").innerHTML = data.sources.map(source => {
      const label = source.error ? (source.collected_at ? "Dane archiwalne" : "Niedostępne") : "Połączono";
      const detail = source.error || (source.collected_at ? new Date(source.collected_at).toLocaleString("pl-PL") : "");
      return `<span class="source-status"><strong>${html(source.label)}</strong>
        <span class="badge ${source.error ? "text-bg-warning" : "text-bg-success"}">${data.dashboard.demo ? "Demo" : label}</span>
        <span class="text-body-secondary">${html(detail)}</span></span>`;
    }).join("");
    text("poll-status", data.dashboard.demo ? "Dane demonstracyjne" : `Odświeżanie co ${data.dashboard.refresh_seconds} s`);
    render();
  } catch {
    text("poll-status", "Dashboard nie może pobrać danych.");
  } finally {
    byId("refresh").disabled = false;
    refreshing = false;
    timer = setTimeout(refresh, 1000 * (data.dashboard.refresh_seconds || 30));
  }
}

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => selectView(button.dataset.view));
}
for (const id of ["source-filter", "kind-filter", "status-filter"]) {
  byId(id).addEventListener("change", render);
}
byId("search").addEventListener("input", render);
byId("refresh").addEventListener("click", refresh);
for (const id of ["topology-view", "table-view"]) {
  byId(id).addEventListener("click", event => {
    const button = event.target.closest("[data-guest]");
    if (!button) return;
    selected = button.dataset.guest;
    render();
    if (matchMedia("(max-width: 1080px)").matches) {
      byId("detail-title").focus();
    } else {
      for (const control of byId(currentView + "-view").querySelectorAll("[data-guest]")) {
        if (control.dataset.guest === selected) {
          control.focus({ preventScroll: true });
          break;
        }
      }
    }
  });
}
refresh();
