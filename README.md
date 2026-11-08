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
| `dashboard.show_addresses` | Ukrywa adresy i bramy z API oraz pole `endpoint` usług w danych wysyłanych do przeglądarki |
| `[[proxmox]]` | Adres, etykieta, nazwy zmiennych tokenu i opcjonalne CA każdego źródła |
| `[[services]]` | Nazwa, endpoint, opis i lista zależności przypisane przez `source` i `vmid` |

Dla Compose pliki konfiguracji i CA muszą być czytelne dla użytkownika kontenera
o UID 10001. Sekret trafia do kontenera przez `env_file`. Po zmianach uruchom
aplikację ponownie.

Zakładka **Konfiguracja** w lewym menu pozwala zapisać wygląd w przeglądarce
i wygenerować TOML z wpisanych ustawień, źródeł oraz usług. Porównaj wynik
z dotychczasową konfiguracją przed zapisaniem do `config/config.toml`.
Pola tokenu przyjmują wyłącznie nazwy zmiennych środowiskowych. Ich wartości
wpisujesz lokalnie w `.env`.

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
