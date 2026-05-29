# Change Log

All notable changes to the "autotest-agent" extension.

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