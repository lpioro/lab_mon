"use strict";

(() => {
  const view = document.querySelector("#history-view");
  const host = view.querySelector("#history-host");
  const range = view.querySelector("#history-range");
  const content = view.querySelector("#history-content");
  const message = view.querySelector("#history-message");
  const formatDate = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" });
  const formatTime = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" });
  const formatDayTime = new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const formatDay = new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit" });
  const formatNumber = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });
  const statusNames = { online: "Online", offline: "Offline", unknown: "Nieznany" };
  let request;
  let history;

  const hostKey = item => JSON.stringify([item.source, item.node]);
  const percent = value => Number.isFinite(value) ? formatNumber.format(value) + "%" : "—";

  function uptime(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds / 3600) % 24;
    const minutes = Math.floor(seconds / 60) % 60;
    return [days ? days + " d" : "", hours + " h", minutes + " min"].filter(Boolean).join(" ");
  }

  function drawPlot(container, metric, label) {
    const width = Math.max(245, Math.floor(container.clientWidth));
    const height = 176;
    const left = 38;
    const right = width - 9;
    const top = 10;
    const bottom = height - 26;
    const x = ts => left + (ts - history.start) / (history.end - history.start) * (right - left);
    const y = value => bottom - Math.max(0, Math.min(value, 100)) / 100 * (bottom - top);
    const valid = history.points.filter(point => Number.isFinite(point[metric]));
    if (!valid.length) {
      container.textContent = "Brak odczytów " + label + " w tym zakresie.";
      return;
    }
    const groups = [];
    let previous = null;
    for (const point of history.points) {
      if (!Number.isFinite(point[metric])) {
        previous = null;
        continue;
      }
      if (!previous || (point.bucket > previous.bucket + 1
          && point.ts - previous.ts > history.bucket_seconds * 1.5)) groups.push([]);
      groups.at(-1).push([x(point.ts).toFixed(1), y(point[metric]).toFixed(1)]);
      previous = point;
    }
    const dates = { "1h": formatTime, "24h": formatDayTime }[range.value] ?? formatDay;
    const xLabels = [0, 0.5, 1].map((part, index) => {
      const ts = history.start + (history.end - history.start) * part;
      return `<text x="${x(ts)}" y="${height - 5}" text-anchor="${["start", "middle", "end"][index]}">${dates.format(ts * 1000)}</text>`;
    }).join("");
    const grid = [0, 25, 50, 75, 100].map(level =>
      `<line x1="${left}" x2="${right}" y1="${y(level)}" y2="${y(level)}"/><text x="${left - 6}" y="${y(level) + 4}" text-anchor="end">${level}%</text>`
    ).join("");
    const paths = groups.map(points => points.length === 1
      ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="2.5"/>`
      : `<polyline points="${points.map(pair => pair.join(",")).join(" ")}"/>`).join("");
    container.innerHTML = `<svg class="history-svg history-${metric}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Użycie ${label} w procentach w wybranym okresie">${grid}${xLabels}${paths}</svg>`;
  }

  function drawCharts() {
    if (!history?.points.length || content.hidden || view.hidden) return;
    drawPlot(view.querySelector("#history-cpu"), "cpu", "CPU");
    drawPlot(view.querySelector("#history-ram"), "ram", "RAM");
  }

  function render() {
    host.replaceChildren(new Option("Brak węzłów", ""));
    if (history.hosts.length) {
      host.replaceChildren(...history.hosts.map(item => new Option(item.label + " · " + item.node, hostKey(item))));
      host.value = hostKey(history.selected);
    }
    content.hidden = !history.points.length;
    if (content.hidden) {
      message.textContent = history.hosts.length
        ? "Brak próbek w wybranym zakresie."
        : "Historia pojawi się po pierwszym udanym odczycie z Proxmoxa.";
      return;
    }
    message.textContent = "Średnie z przedziałów " + formatNumber.format(history.bucket_seconds / 60)
      + " min. Przerwa na wykresie oznacza brak pomiaru.";
    const rows = history.recent.map(item => {
      const row = document.createElement("tr");
      const cells = [formatDate.format(item.ts * 1000), statusNames[item.status] ?? "Nieznany",
        percent(item.cpu), percent(item.ram), uptime(item.uptime)];
      for (const value of cells) row.insertCell().textContent = value;
      return row;
    });
    view.querySelector("#history-recent").replaceChildren(...rows);
    drawCharts();
  }

  async function loadHistory() {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const params = new URLSearchParams({ range: range.value });
    if (host.value) {
      const [source, node] = JSON.parse(host.value);
      params.set("source", source);
      params.set("node", node);
    }
    message.textContent = "Pobieranie historii…";
    try {
      const response = await fetch("/api/history?" + params, { signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.error || "Historia niedostępna.");
      if (!result.enabled) {
        content.hidden = true;
        message.textContent = "Historia jest wyłączona w konfiguracji.";
        return;
      }
      history = result;
      render();
    } catch (error) {
      if (controller.signal.aborted) return;
      content.hidden = true;
      message.textContent = error.message || "Historia niedostępna.";
    }
  }

  document.querySelector('[data-view="history"]').addEventListener("click", loadHistory);
  host.addEventListener("change", loadHistory);
  range.addEventListener("change", loadHistory);
  view.querySelector("#history-refresh").addEventListener("click", loadHistory);
  new ResizeObserver(drawCharts).observe(view.querySelector("#history-cpu"));
  setInterval(() => {
    if (!view.hidden && !document.hidden) loadHistory();
  }, 60000);
})();
