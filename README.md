# Lab Mon · Proxmox

Dashboard do samodzielnego hostowania w LAN. Pokazuje węzły Proxmox VE,
kontenery LXC i maszyny VM w widoku topologii oraz tabeli adresów. Menu po
lewej przełącza widoki. Filtry obejmują źródło, typ i stan gościa oraz wyszukiwanie
po nazwie, adresie, moście i usłudze. Interfejs używa lokalnego Bootstrap 5.3.8.

Aplikacja wykonuje zapytania GET do Proxmoxa, a token przechowuje w środowisku
procesu. Repozytorium i obraz zawierają wyłącznie kod, przykładową konfigurację
i fikcyjne dane trybu demo. Dane z API trafiają do pamięci aplikacji i przeglądarki
osoby korzystającej z dashboardu. GitHub Actions używa wyłącznie trybu demo.

## 1. Token Proxmoxa

Utwórz dedykowanego użytkownika `monitor@pve` oraz token `dashboard` z włączoną
separacją uprawnień. Do odczytu całego klastra nadaj rolę **PVEAuditor** z
dziedziczeniem na ścieżce `/` zarówno użytkownikowi, jak i tokenowi. Gdy chcesz
ograniczyć widoczność, zawęź ACL do właściwych węzłów i gości. Zasoby niewidoczne
dla tokenu nie pojawią się w dashboardzie.

Token ma postać `monitor@pve!dashboard`, a sekret jest osobną wartością zwracaną
przy utworzeniu. Do integracji wystarcza rola odczytu. Użyj ważnego certyfikatu TLS
zgodnego z nazwą lub IP w adresie API. W przypadku własnego CA umieść jego publiczny
certyfikat obok lokalnej konfiguracji i ustaw `ca_file` na nazwę pliku.

- [Dokumentacja uprawnień Proxmox VE](https://pve.proxmox.com/pve-docs/chapter-pveum.html)
- [Proxmox VE API Viewer](https://pve.proxmox.com/pve-docs/api-viewer/)

## 2. Konfiguracja lokalna

```bash
git clone https://github.com/lpioro/lab_mon.git
cd lab_mon
mkdir -p config
cp config.example.toml config/config.toml
cp .env.example .env
chmod 600 .env
```

Wpisz adres API w `config/config.toml` i dane tokenu w `.env`. W przypadku klastra
dodaj jedno źródło wskazujące dowolny dostępny węzeł, aby uniknąć powielania zasobów.
Dla samodzielnych instalacji dodaj osobne bloki `[[proxmox]]` z unikalnym `id`
i oddzielnymi zmiennymi środowiskowymi. Aplikacja łączy się bezpośrednio z API
z hosta lub kontenera, na którym działa. Zwykle potrzebuje dostępu do portu TCP 8006.

| Ustawienie | Działanie |
| --- | --- |
| `dashboard.title`, `description` | Nagłówek i opis dashboardu |
| `dashboard.theme`, `default_view` | Motyw jasny/ciemny i widok początkowy |
| `dashboard.refresh_seconds`, `timeout_seconds` | Minimalny odstęp odczytów i limit czasu połączenia API |
| `dashboard.read_guest_networks` | Odczyt konfiguracji sieci VM i LXC |
| `dashboard.show_addresses` | Ukrywa adresy i bramy z API, adresy źródeł i pole `endpoint` usług w danych wysyłanych do przeglądarki |
| `history.enabled`, `interval_seconds`, `retention_days` | Włączenie historii węzłów, częstotliwość próbkowania i retencja |
| `[[proxmox]]` | Adres, etykieta, nazwy zmiennych tokenu i opcjonalne CA każdego źródła |
| `[[services]]` | Nazwa, endpoint, opis i lista zależności przypisane przez `source` i `vmid` |

Dla Compose pliki konfiguracji i CA muszą być czytelne dla użytkownika kontenera
o UID 10001. Sekret trafia do kontenera przez `env_file`. Po zmianach uruchom
aplikację ponownie.

Zakładka **Konfiguracja** pokazuje ustawienia pliku TOML wczytane przy starcie.
Można je edytować i pobrać jako nowy TOML. Przy ukrywaniu adresów uzupełnij
adresy źródeł i usług przed użyciem wyeksportowanego pliku. Zapisany lokalnie
wygląd ma pierwszeństwo do chwili użycia przycisku **Przywróć wygląd z pliku**.
Pola tokenu pokazują nazwy zmiennych środowiskowych. Ich wartości wpisujesz
lokalnie w `.env`.

## 3. Docker

Obraz `ghcr.io/lpioro/lab_mon:latest` jest budowany dla Linux/amd64 przez GitHub
Actions. Dla prywatnej paczki zaloguj się do GHCR przy użyciu tokenu GitHub
z prawem odczytu paczek. To osobny token, niezależny od tokenu Proxmoxa.

```bash
docker compose pull
docker compose up -d
```

Otwórz [http://127.0.0.1:8080](http://127.0.0.1:8080). Domyślne wiązanie Compose
ogranicza dostęp do lokalnego hosta. Do dostępu z innej maszyny użyj tunelu SSH
lub reverse proxy z TLS i uwierzytelnianiem. Dashboard ma model dostępu oparty na
wiązaniu adresu i warstwie reverse proxy.

Budowa lokalna oraz uruchomienie z własnej kopii obrazu

```bash
docker build -t lab-mon:local .
LAB_MON_IMAGE=lab-mon:local docker compose up -d
```

Próba obrazu z danymi przykładowymi

```bash
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/lpioro/lab_mon:latest --demo
```

## 4. Python w venv

Wymagany Python 3.11 lub nowszy. Polecenia dla Linux i macOS

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt

# Demo bez Proxmoxa
python -m lab_mon --demo

# Uruchomienie z lokalnym tokenem
set -a
. ./.env
set +a
python -m lab_mon --config config/config.toml
```

Aplikacja nasłuchuje domyślnie pod `127.0.0.1:8080`. Opcje `--host` i `--port`
oraz zmienne `LAB_MON_HOST` i `LAB_MON_PORT` pozwalają zmienić adres i port.

## Zakres odczytu

Zakładka **Historia** pokazuje CPU i RAM wybranego węzła w zakresie 1 godziny,
24 godzin, 7 lub 30 dni. W tabeli są ostatnie odczyty stanu i czasu pracy.
Wykresy pokazują średnie w przedziałach czasu. Gdy API nie odpowiada,
aplikacja zostawia lukę. Stan offline zapisuje tylko wtedy, gdy raportuje go Proxmox.

Kolektor pracuje w tle, gdy działa aplikacja. Domyślnie zapisuje próbkę co 60 s
i usuwa odczyty starsze niż 30 dni. Historia zaczyna się od pierwszego
udanego odczytu po uruchomieniu. W trybie `--demo` wykresy pokazują fikcyjne dane.

Przy uruchomieniu przez venv baza SQLite trafia do `data/history.sqlite3`
w katalogu roboczym. Docker Compose przechowuje ją w wolumenie `lab-mon-history`
pod ścieżką `/data/history.sqlite3`. Po aktualizacji użyj również nowego
`compose.yaml`, aby kontener miał wolumen do zapisu. Ścieżkę pliku można zmienić
zmienną `LAB_MON_HISTORY_DB`. Próbki zawierają identyfikator źródła, nazwę węzła,
czas odczytu, CPU, RAM, stan i czas pracy. Pozostają na hoście Lab Mon.

- `/cluster/resources` zwraca zasoby widoczne dla tokenu i przypisanie gości do węzłów.
- `/cluster/status` uzupełnia adresy węzłów, jeśli API je udostępnia.
- Sieć LXC jest czytana z konfiguracji `netN`, a VM z `netN` i `ipconfigN`.
  Wartości DHCP i konfiguracja cloud-init opisują ustawienia, nie aktualną dzierżawę.
- Usługi i zależności są deklaracjami z TOML. Obecność wpisu nie oznacza aktywnego nasłuchu.
- Po awarii źródła dashboard pokazuje ostatni udany odczyt z pamięci z oznaczeniem
  **Dane archiwalne**. Pierwsza awaria jest oznaczona jako **Niedostępne**.
- `/healthz` sprawdza dostępność aplikacji. Połączenie z każdym źródłem widać w dashboardzie.

Testy lokalne

```bash
python -m unittest discover -s tests -v
```
