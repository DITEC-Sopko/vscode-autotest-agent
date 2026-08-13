# Change Log

All notable changes to the "TestPilot AI" extension.

## [1.1.0] - 2026-08-13

### Added ✨
- **Upozornenia na významové nezhody v názvoch prvkov** — keď scenár očakáva prvok s určitým názvom (napr. tlačidlo „nájsť školu") a v aplikácii je významovo rovnaký prvok pod iným názvom (napr. „vyhľadať školu"), agent to berie ako ten istý prvok a **pokračuje v teste** (verdikt kvôli tomu neklesá). Každú takú nezhodu zapíše do `result.md` do sekcie `## Upozornenia` a v reporte sa zobrazí v **oranžovom rámiku** s odporúčaním preveriť (aký názov čakal scenár vs. aký je v realite).

---

## [1.0.1] - 2026-07-28

### Changed 🔄
- **Premenovanie na TestPilot AI** — extension má nový zobrazovaný názov "TestPilot AI" (activity bar, dashboard footer, README).
- **AI disclaimer v reporte** — `result.md` teraz na konci vždy obsahuje upozornenie, že analýza bola vygenerovaná AI a je potrebné ju overiť.

---

## [1.0.0] - 2026-07-27

### Added ✨
- **Automatizovaný GitHub Release proces** — pridaná GitHub Actions workflow, ktorá automaticky vytvára release s .vsix súborom pri push tagu. Extension teraz možno stiahnuť priamo z GitHub Releases.

### Changed 🔄
- **Stabilná 1.0 verzia** — projekt dosiahol stabilitu a kompletnú funkcionalitu pre produkčné nasadenie.

---

## [0.9.1]

### Added ✨
- **Verzia extension v pätičke dashboardu** — na spodku panela Autotest sa zobrazuje aktuálna verzia (napr. `Autotest Agent · v0.9.1`), aby bolo hneď jasné, ktorá verzia beží.

## [0.9.0]

### Added ✨
- **Analýza pravdepodobnej príčiny pri zlyhaní** — keď test skončí verdiktom `FAILED`, agent sa pokúsi nájsť **pravdepodobnú príčinu v zdrojovom kóde**: najprv prehľadá kód v **aktuálnom workspace**, a ak zdroják nie je po ruke, využije dostupný **Azure DevOps / TFS MCP** na vyhľadanie a prečítanie relevantného kódu v repozitári. Príčinu **neopravuje** — len ju zapíše do `result.md` do sekcie `## Pravdepodobná príčina`.

### Changed 🔄
- **Beh testu sa spúšťa v aktuálnej Copilot relácii** — spustenie už nezakladá novú chat reláciu (zrušené správanie z 0.7.0). Test beží tam, kde práve pracuješ. Tlačidlo spustenia premenované späť na **„▶️ Spustiť test"**.

### Fixed 🐛
- **Do reportu sa už nedostanú screenshoty z predchádzajúceho behu** — priečinok `steps/` sa teraz **premaže pred každým spustením** testu. Pri opätovnom spustení toho istého testu/bugu report obsahuje len screenshoty z aktuálneho behu.

## [0.8.2]

### Changed 🔄
- **Efektívna práca s dropdownmi/dlhými zoznamami** — pokyn pre agenta (web) doplnený tak, aby pri dropdown/combobox/listbox s vyhľadávaním **vždy najprv použil filter** (napísal názov položky) namiesto opakovaného snapshotovania celého dlhého zoznamu. Znižuje počet iterácií agenta a zrýchľuje beh na formulároch s dlhými číselníkmi.

## [0.8.1]

### Changed 🔄
- **Zrýchlený beh web testov (Playwright MCP)** — screenshoty sa už neposielajú do kontextu modelu (`--image-responses omit`), len sa ukladajú na disk do reportu. Tým sa výrazne zmenší kontext agenta a zrýchli sa každý krok agent-loopu. Pokyn pre agenta zmenený tak, aby robil screenshoty len pri kľúčových krokoch a stav overoval cez accessibility snapshot, nie cez obrázky.

## [0.8.0]

### Added ✨
- **Hľadanie prepojeného Test Casu na TFS** — pri vytváraní aj regenerácii testu z bugu agent nájde Test Case prepojený cez reláciu **Related** alebo **Tested By**. Ak nejaký existuje, priamo v chate ponúkne tlačidlá na výber:
  - **🐞 Len podľa popisu bugu** — scenár sa vygeneruje iba z popisu a komentárov bugu (pôvodné správanie).
  - **📋 Celý test case #id** — do scenára sa zahrnú kroky test casu (načítané z poľa `Microsoft.VSTS.TCM.Steps`) a otestuje sa ako celok spolu s overením opravy bugu.

### Changed 🔄
- **Bohatší kontext bugu pre generátor scenára** — z bugu sa už neberá len jedno pole, ale skladajú sa všetky relevantné: **Popis**, **Kroky na reprodukciu**, **Akceptačné kritériá** a **Systémové informácie** — plus **diskusia/komentáre** ako doteraz.

## [0.7.2]

### Fixed 🐛
- **Zvyšné markery `.running` už falošne nerozsvietia „beží…" pri iných testoch** — `.running` marker sa doteraz mazal len po dokončení testu (zápis `result.md`). Nedobehnutý test tak nechal marker, ktorý spolu so zdieľaným `autotest/_mcp_output` (kam píše ktorýkoľvek bežiaci test) falošne rozsvietil „beží…" pri všetkých testoch so zvyšným markerom. `isRunning` teraz marker zmaže vždy, keď indikátor „beží…" pre daný test zhasne (test dobehol alebo marker prežil štartovacie okno a už nie je aktivita).

## [0.7.1]

### Fixed 🐛
- **Indikátor „beží…" už nezhasína počas bežiaceho testu** — počas behu sa reálne mení len `autotest/_mcp_output` (screenshoty/výstupy Playwrightu), kým `steps/` a `transcript.md` sa napĺňajú až na konci. Detekcia behu preto po uplynutí štartovacieho okna (90 s) falošne zhasla. `isRunning` teraz berie do úvahy aj aktivitu v zdieľanom `_mcp_output` (viazané na `.running` marker konkrétneho testu) a pribudol `mcpWatcher`, ktorý pri každom novom výstupe obnoví dashboard a posunie časovač zhasnutia. Doplnená poistka, aby dokončený test (novší `result.md` než marker) nesvietil, kým sa marker odstráni.

## [0.7.0]

### Changed 🔄
- **Beh testu v novej Copilot relácii** — spustenie testu najprv založí novú chat reláciu (`workbench.action.chat.newChat`) a až potom pošle dopyt. Pôvodná konverzácia zostáva v zozname relácií, takže používateľ môže ďalej pracovať a beh testu mu nezaberie aktuálny chat. (VS Code 1.127+ podporuje viac paralelných relácií.)
- Tlačidlo spustenia premenované na **„▶️ Spustiť v novej relácii"**.

### Fixed 🐛
- **`.gitignore` sa už nezobrazuje v Changes** — `autotest/.gitignore` teraz ignoruje aj sám seba (`*` bez výnimky `!.gitignore`), takže celý priečinok vrátane `.gitignore` je mimo gitu.

## [0.6.0]

### Added ✨
- **Zmazať test** — tlačidlo 🗑 na každej test karte (s potvrdzím dialógom), odstráni celý priečinok testu.
- **Regenerovať scenár z TFS** — pri zmene bugu tlačidlo „↻ Regen" znova vygeneruje `test_scenario.md` z **aktuálneho** stavu bugu (nový popis + komentáre); pôvodný sa zazálohuje do `test_scenario.bak.md`. Len pre TFS testy (`bug_*`).
- **Upozornenie na neaktuálny scenár** — ak sa bug zmenil po vytvorení scenára, na bug karte sa zobrazí „⚠ Test scenár nemusí byť aktuálny — došlo k zmene v bug_xxxx" + tlačidlo Regenerovať (podľa `meta.json` s dátumom zmeny bugu).

### Changed 🔄
- **TFS karty** — typ work itemu je teraz **ľavý** pásik, stav **horný** pásik.
- **Indikátor „beží"** svieti len pri reálnom spustení v agent mode; skrátené a rozdelené časové okná (štart 90 s, aktivita 45 s) so spoľahlivým zhasnutím po dokončení/zrušení.
- **Jednotný štýl** tlačidla „+ Test" (tyrkysové, bez gradientu).
- **Automatický refresh** dashboardu po regenerácii aj zmazaní testu.
- Aktualizovaná ikona (`icon.png` pregenerovaný z upraveného `icon.svg`).

### Removed 🗑️
- Tlačidlo „✕ Zrušiť" indikátora behu — nahradené automatickým časovým vypnutím.

## [0.5.0]

### Added ✨
- **Čítanie reportov (PDF/DOCX/XLSX/XML/CSV/TXT)** — nový Language Model nástroj `#readReport` (`autotest_readReport`), ktorým agent prečíta obsah vygenerovaného reportu priamo z disku namiesto otvárania v prehliadači (`file:` URL je blokované). PDF cez `unpdf` (bez natívnych závislostí), DOCX cez `mammoth`, XLSX cez `xlsx`.
- Agent prompt teraz inštruuje, aby na overenie obsahu reportov používal tento nástroj.

## [0.4.0]

### Added ✨
- **TFS komentáre v scenári** — pri tvorbe testu z bugu sa načítajú aj komentáre/diskusia work itemu (podstatné info sa často presunie tam).

### Changed 🔄
- **Farby TFS bugov podľa stavu** — zhodujú sa s Azure DevOps (New/Proposed sivá, Active modrá, Resolved zlatá, Closed zelená, Removed červená), aby nemýlili.
- **Prilinkované bugy** (už majú test) sa označujú **fialovým** akcentom + odznakom „✓ test" (nie zlatá/zelená, ktoré v TFS znamenajú Resolved/Closed).
- **Dashboard sa obnoví** aj po vytvorení testu z TFS (watcher sleduje všetky `.md` v teštoch, bug sa ihneď označí ako prilinkovaný).

### Fixed 🐛
- **`.gitignore`** — celý obsah `autotest/` (výsledky, scenáre, reporty, screenshoty) je teraz ignorovaný; už neznečísťuje git repozitár projektu.

## [0.3.3]

### Changed 🔄
- Aktualizovaná ikona rozšírenia (`icon.png` pregenerovaný z upraveného `icon.svg`).

## [0.3.2]

### Added ✨
- **Ikona rozšírenia** (`icon.png`) — zobrazuje sa v zozname Extensions aj v Marketplace.

## [0.3.1]

### Removed 🗑️
- **Výber roly (developer/tester)** z dashboardu, sprievodcu aj `@autotest init` — pole nemalo žiadny funkčný efekt, len mýlilo. Správanie je pre všetkých rovnaké.

## [0.3.0]

### Changed 🔄
- **Prechod na MCP delegáciu** — testy už negenerujú Playwright/PowerShell skripty. Scenár vykoná GitHub Copilot agent mode cez MCP servery: web = Playwright MCP, desktop = Terminator MCP.
- **Jednotný report** — výsledok je `result.md` s `VERDIKT: PASSED|FAILED`, zhrnutím a screenshotmi krokov v `steps/`.
- Default TFS stavy zmenené na `Proposed, Active`.

### Added ✨
- **Dashboard sprievodca** inicializáciou v 3 krokoch (rola → aplikácia → prihlásenie → TFS).
- **TFS discovery** z `mcp.json` a zvýraznenie bugov, ktoré už majú test.
- Auto‑refresh dashboardu po dokončení testu.
- Info nápoveda pre vytvorenie PAT tokenu priamo v UI.

### Removed 🗑️
- Vision API analýza screenshotov a generovanie test skriptov.
- WinAppDriver backend (nahradený Terminator MCP).

## [0.2.0] - 2026-05-28

### Added ✨
- **test_result.md** - Automatický detail report po každom teste
  - Success: Kompletná analýza, console output, AI vision results
  - Failure: Presný problém, čo nenašlo, návrh na opravu
- **Flexibilné selektory** - AI generuje fallback stratégie pre elementy
  - Text-based (button text, link text)
  - Icon/class-based (icon-detail, btn-action)
  - ARIA labels (aria-label, aria-describedby)
- **Smart defaults** - AI použije rozumné defaulty
  - "Vyber klienta" → prvý v tabuľke
  - "Otvor dokument" → prvý v zozname
- **Automatické validácie** - Kontrola počtu riadkov, viditeľnosti
- **Automatický .gitignore update** - Pri prvom teste

### Improved 🔧
- Test scenario generation - Konkrétnejšie kroky
- Playwright generation - Robustnejšie error handling
- Documentation - Kompletne prepísané guides

### Fixed 🐛
- Duplikátne entries v .gitignore
- Vision API syntax errors

## [0.1.0] - 2026-05-27

### Added ✨
- Initial release
- Chat participant `@autotest`
- AI-powered Playwright test generation
- TFS/Azure DevOps integration
- Vision API screenshot analysis
- Test regeneration from markdown scenarios
- Debug mode (headed/headless)
- Login credentials management (SecretStorage)

### Commands
- `@autotest init` - Configuration
- `@autotest model` - AI model selection
- `@autotest debug` - Debug mode
- `@autotest over bug 123` - Test from TFS
- `@autotest test` - Manual test
- `@autotest regenerate` - Regenerate
- `@autotest history` - History