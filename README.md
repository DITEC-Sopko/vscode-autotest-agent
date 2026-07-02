# Autotest Agent

AI agent pre VS Code, ktorý **overí opravu bugu alebo test scenár tak, že priamo ovláda aplikáciu** — web cez [Playwright MCP](https://github.com/microsoft/playwright-mcp), desktop cez [Terminator MCP](https://github.com/mediar-ai/terminator). Žiadne generované test skripty, žiadne ručné ladenie selektorov. Scenár vykoná GitHub Copilot agent mode cez MCP nástroje a zapíše jediný výsledok so screenshotmi krok‑po‑kroku.

> Cieľ: ušetriť čas testerom aj programátorom — namiesto písania a opravovania krehkých testov necháš agenta scenár reálne odklikať a vizuálne overiť.

[![Stiahnuť .vsix](https://img.shields.io/badge/⬇%20Stiahnuť%20.vsix-v0.7.0-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://github.com/DITEC-Sopko/vscode-autotest-agent/raw/main/autotest-agent-0.7.0.vsix)

---

## Hlavné vlastnosti

- 🧭 **Dashboard so sprievodcom** — inicializácia projektu v krokoch (aplikácia → prihlásenie → TFS), prehľad testov, reporty.
- 🌐 **Web aj 🖥️ desktop** — jednotný tok cez MCP servery (Playwright / Terminator).
- 🤖 **Vykonanie v Copilot agent mode** — agent klika, píše a screenshotuje sám; pýta sa len keď chýba prihlásenie alebo údaj zo scenára.
- 🔗 **TFS / Azure DevOps** — načítanie pridelených work items a vytvorenie testu priamo z bugu.
- 📊 **Pekný report** — verdikt PASSED/FAILED + zhrnutie + screenshoty každého kroku.
- ♻️ **Auto‑refresh** — dashboard sa po dokončení testu sám obnoví.

---

## Požiadavky

- **VS Code** `^1.120.0`
- **GitHub Copilot** (Chat + agent mode)
- **Node.js** (kvôli `npx`, ktorý spúšťa MCP servery)

MCP servery sa sťahujú automaticky cez `npx` pri prvom spustení testu.

---

## Inštalácia

Extension zatiaľ nie je v Marketplace — inštaluje sa z priloženého `.vsix`:

[![Stiahnuť .vsix](https://img.shields.io/badge/⬇%20Stiahnuť%20.vsix-v0.7.0-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://github.com/DITEC-Sopko/vscode-autotest-agent/raw/main/autotest-agent-0.7.0.vsix)

1. Stiahni súbor `autotest-agent-0.7.0.vsix`.
2. Vo VS Code otvor **Extensions** (`Ctrl+Shift+X`).
3. Klikni na **`...`** (vpravo hore) → **Install from VSIX…**.
4. Vyber stiahnutý `.vsix` a potvrď.

Alebo cez príkazový riadok:

```bash
code --install-extension autotest-agent-0.7.0.vsix
```

---

## Rýchly štart

1. Otvor panel **Autotest** v Activity Bare → **Dashboard**.
2. Klikni **„🚀 Inicializovať projekt"** a prejdi sprievodcom:
   - **Krok 1** — rola, typ projektu (web/desktop), URL alebo cesta k aplikácii.
   - **Krok 2** — či projekt vyžaduje prihlásenie (meno + heslo do secure storage).
   - **Krok 3** — voliteľné pripojenie TFS / Azure DevOps (organization URL, projekt, PAT).
3. **„+ Test"** — vytvor test z manuálneho popisu (`test_NNN`) alebo z TFS bugu (`bug_<id>`).
4. Agent vygeneruje scenár a ponúkne spustenie v **agent mode** — potvrď a sleduj priebeh.
5. Po dokončení klikni **„Report"** na karte testu pre verdikt a screenshoty.

---

## Chat príkazy (`@autotest`)

| Príkaz | Popis |
| --- | --- |
| `@autotest init` | Inicializovať konfiguráciu |
| `@autotest test` | Otestovať bug podľa manuálneho popisu |
| `@autotest model` | Vybrať AI model |
| `@autotest debug` | Prepnúť viditeľný / headless režim |
| `@autotest regenerate <folder>` | Znova spustiť podľa upraveného scenára |
| `@autotest history` | Zobraziť históriu testov |

---

## Ako to funguje

```
Používateľ → Dashboard / @autotest → vygenerovaný scenár (test_scenario.md)
        → delegácia do Copilot agent mode → MCP server (Playwright / Terminator)
        → agent vykoná kroky priamo v aplikácii
        → result.md (VERDIKT: PASSED/FAILED) + steps/ screenshoty + transcript.md
        → Dashboard zobrazí stav a report
```

Pri delegovaní extension:
- zapíše `.vscode/mcp.json` (server `playwright` alebo `terminator`),
- pripraví `autotest/<test>/agent_prompt.md` (bez hesla),
- zapne auto‑schvaľovanie nástrojov a vyšší limit krokov **len pre tento workspace**.

---

## Štruktúra testu

```
autotest/
  bug_637890/            # alebo test_001
    test_scenario.md     # vygenerovaný scenár (editovateľný)
    agent_prompt.md      # pokyn pre agent mode
    result.md            # VERDIKT: PASSED | FAILED + zhrnutie
    transcript.md        # zoznam MCP akcií
    steps/               # screenshoty krokov
```

Priečinok `autotest/` sa automaticky pridáva do `.gitignore`.

---

## TFS / Azure DevOps

- V nastaveniach (alebo v 3. kroku sprievodcu) zapni TFS, zadaj organization URL, projekt a **PAT** (Personal Access Token, scope `Work Items → Read`).
- Sekcia **„TFS bugy"** v dashboarde načíta pridelené work items (default stavy `Proposed, Active`).
- Bug, z ktorého už test existuje, je v zozname **zvýraznený na zlato** a má tlačidlo **„K testu →"**.

> Token sa ukladá do VS Code Secret Storage, nikdy nie do súboru ani do promptu agenta.

---

## Bezpečnosť

- Heslá a PAT tokeny sa ukladajú do **Secret Storage**, neukladajú sa do `autotest/` ani do git.
- Auto‑schvaľovanie nástrojov sa nastavuje na **úroveň workspace** (ostatné projekty zostanú s tvojím nastavením). Pri prvom spustení VS Code raz zobrazí bezpečnostný dialóg.
- Lokálne MCP servery spúšťajú kód na tvojom stroji — používaj len dôveryhodné zdroje.

---

## Vývoj

```bash
npm install
npm run compile      # webpack build
npm run watch        # build v watch režime
npm run lint
npm test
```

Spustenie rozšírenia: stlač `F5` (Extension Development Host).

Architektúru a detailnú špecifikáciu nájdeš v [PROJECT_SPEC.md](PROJECT_SPEC.md).

---

## Licencia

MIT
