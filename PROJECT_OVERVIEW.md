# Autotest Agent – Ako projekt funguje

## Čo to je

VS Code rozšírenie s AI chat participantom `@autotest`, ktorý automatizuje testovanie webových aj desktopových aplikácií pomocou GitHub Copilot (vision AI modely).

---

## Architektúra

```
Používateľ → @autotest príkaz → extension.ts (Chat Participant)
                                       │
                        ┌──────────────┼──────────────┐
                        ▼              ▼               ▼
                   TFS Client     AI Model        Config Store
                (bug detaily)  (generovanie     (URL, credentials,
                               scenára + skriptu)  TFS PAT, model)
                                       │
                        ┌──────────────┼──────────────┐
                        ▼              ▼               ▼
                  Web (Playwright)   Desktop PS    Desktop WinAppDriver
                  (.js skripty)     (.ps1 skripty)   (.js skripty)
                                       │
                                  autotest/bug_NNN/
                                  ├── test_scenario.md
                                  ├── test.js / test.ps1
                                  └── screenshots/
```

---

## Tok dát pre typický test

1. **Init** – `@autotest init` uloží konfiguráciu (URL app, credentials, TFS, AI model, typ aplikácie)
2. **Vstup bugu** – `@autotest over bug 622116` načíta popis bugu z TFS, alebo ho zadá používateľ manuálne
3. **AI generovanie** – AI model dostane popis bugu + metadata aplikácie → vygeneruje `test_scenario.md` (kroky) + spustiteľný testovací skript
4. **Spustenie testu** – extension spustí skript cez `child_process`; Playwright (web) alebo PowerShell UI Automation / WinAppDriver (desktop)
5. **Screenshot analýza** – AI (vision) analyzuje výsledný screenshot → určí PASS / FAIL
6. **Iterácia** – pri zlyhaní navrhne opravy; `@autotest regenerate` prepíše scenár a skript

---

## Módy testovania

| Mód | Backend | Výstup | Prerekvizity |
|-----|---------|--------|--------------|
| **Web** | Playwright | `.js` | auto-inštalácia |
| **Desktop – PS** | PowerShell UI Automation | `.ps1` | nič (natívny Windows) |
| **Desktop – WAD** | WinAppDriver | `.js` | Developer Mode + inštalácia |

---

## Kľúčové súbory

| Súbor | Účel |
|-------|------|
| `src/extension.ts` | Hlavná logika, chat participant, AI volania |
| `src/config.ts` | Ukladanie/načítanie konfigurácie (VS Code SecretStorage) |
| `src/tfs-client.ts` | HTTP klient pre TFS / Azure DevOps API |
| `src/ui-automation-memory.ts` | Pamäť stratégií pre desktop UI lokátory |
| `autotest/bug_NNN/` | Generované súbory pre každý testovaný bug |
| `autotest/desktop_app_metadata.json` | Automaticky zistené metadata okna (probe feature) |

---

## Príkazy

```
@autotest init              – prvotná konfigurácia
@autotest model             – výber AI modelu
@autotest debug             – headed / headless prepínanie
@autotest over bug 12345    – test bugu z TFS
@autotest test              – manuálny test (bez TFS)
@autotest regenerate bug_N  – prepísanie scenára a skriptu
```
