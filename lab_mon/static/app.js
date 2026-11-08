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
  text("view-title", view === "table" ? "Tabela adresów" : "Topologia");
}

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
      document.title = settings.title;
      document.documentElement.dataset.bsTheme = settings.theme;
      text("title", settings.title);
      text("description", settings.description);
      text("mode", settings.demo ? "Tryb demonstracyjny" : "Tylko odczyt");
      selectView(settings.default_view);
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
