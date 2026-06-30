# Change Log

All notable changes to the "autotest-agent" extension.

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