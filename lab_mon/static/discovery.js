"use strict";

(() => {
  const view = document.getElementById("discovery-view");
  const status = document.getElementById("discovery-status");
  const results = document.getElementById("discovery-results");
  const rows = document.getElementById("discovery-rows");
  const refresh = document.getElementById("discovery-refresh");

  async function loadDiscovery() {
    if (refresh.disabled) return;
    refresh.disabled = true;
    try {
      const response = await fetch("/api/discovery");
      if (!response.ok) throw new Error();
      const data = await response.json();
      results.hidden = !data.services.length;
      if (!data.enabled) {
        status.textContent = "Wykrywanie jest wyłączone. Włącz je w konfiguracji TOML.";
        return;
      }
      if (!data.scanned_at) {
        status.textContent = "Oczekiwanie na wynik pierwszego skanu.";
        return;
      }
      const summary = [
        data.demo ? "Dane demonstracyjne" : "Ostatni skan " + new Date(data.scanned_at).toLocaleString("pl-PL"),
        "Adresy: " + data.addresses,
        "Wykryte wpisy: " + data.services.length,
      ];
      if (data.source_errors) summary.push("Pominięte niedostępne źródła: " + data.source_errors);
      if (data.limit_reached) summary.push("Osiągnięto limit 64 adresów");
      if (!data.addresses) summary.push("Brak kwalifikujących się adresów. Sprawdź podsieci i odczyt konfiguracji sieci gości");
      status.textContent = summary.join(" · ");
      rows.replaceChildren(...data.services.map(item => {
        const row = document.createElement("tr");
        const values = [
          (item.kind === "lxc" ? "CT " : "VM ") + item.vmid + " · " + item.name,
          item.source + " / " + item.node, item.address ?? "—", item.port, item.hint ?? "—",
        ];
        for (const value of values) row.insertCell().textContent = value;
        return row;
      }));
    } catch {
      results.hidden = true;
      status.textContent = "Nie można pobrać wyników wykrywania.";
    } finally {
      refresh.disabled = false;
    }
  }

  document.querySelector('[data-view="discovery"]').addEventListener("click", loadDiscovery);
  refresh.addEventListener("click", loadDiscovery);
  setInterval(() => {
    if (!view.hidden && !document.hidden) loadDiscovery();
  }, 15000);
})();
