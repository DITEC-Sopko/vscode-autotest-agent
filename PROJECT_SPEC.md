# Autotest Agent — Špecifikácia (čistá verzia)

> Cieľ: AI agent vo VS Code, ktorý overí opravu bugu/test scenár tak, že **priamo ovláda
> aplikáciu cez MCP server** (desktop = Terminator, web = Playwright). Žiadny code-gen,
> žiadne python/JS test skripty, žiadna vision-assert berlička. MCP servery fungujú.

## 1. Čo chceme dosiahnuť
- Tester/dev zadá scenár (manuálne alebo z TFS bugu) → agent ho **vykoná v Copilot agent mode** cez MCP → zapíše **jeden** výsledok + screenshoty → dashboard zobrazí stav a pekný krok-po-kroku report.
- Auto-schvaľovanie nástrojov: agent klika/píše/screenshotuje sám; pýta sa **len** keď chýba prihlásenie alebo údaj, ktorý nie je v scenári.

## 2. Rozsah
- Platformy: **desktop (Terminator MCP)** + **web (Playwright MCP)**.
- TFS: **áno** (import popisu bugu, voliteľné).
- Record (nahrávanie akcií): **nie** — odstránené.

## 3. Tok (jediný, pre obe platformy)
1. `init` → QuickPick wizard: rola, typ app (web/desktop), URL/cesta, prostredie, login, TFS.
2. Pridať test: manuálny popis (→ `test_NNN`) alebo TFS bug (→ `bug_<id>`).
3. Agent vygeneruje `test_scenario.md` (LLM z popisu).
4. Extension zapíše `.vscode/mcp.json` (terminator/playwright) + `.vscode/settings.json` (`chat.tools.autoApprove`) + `agent_prompt.md`.
5. Handoff tlačidlo → `workbench.action.chat.open` (mode agent) s pokynom.
6. Agent cez MCP vykoná kroky, ukladá `steps/NN.png`, na konci **`result.md`** (`VERDIKT: PASSED|FAILED` + zhrnutie) a `transcript.md`.
7. Dashboard číta `result.md` → badge, history, report panel.

## 4. Štruktúra testu (`autotest/<folder>/`)
- `test_scenario.md` — kroky a očakávaný výsledok
- `agent_prompt.md` — pokyn pre agenta (bez hesla)
- `result.md` — JEDINÝ status: prvý riadok `VERDIKT: PASSED` alebo `VERDIKT: FAILED`
- `transcript.md` — zoznam MCP akcií
- `steps/` — screenshoty krokov
- Naming: TFS = `bug_<id>`, manuál = `test_NNN`

## 5. Architektúra (cieľ)
- `extension.ts` — activate, registrácia chat participant + commands, tenký dispatcher (< 300 r.)
- `config.ts` — konfig (zachované, bez `desktopBackend`)
- `tfs-client.ts` — TFS bug import (zachované)
- `mcp.ts` — zápis mcp.json + settings.json (auto-approve) pre terminator/playwright
- `runner.ts` — generateScenario + delegateToAgentMode (spoločné pre web/desktop, líši sa MCP server a prompt)
- `dashboard.ts` — webview view + report panel
- `setup.ts` — init wizard (QuickPick), settings menu
- `history.ts` — bug/test history
- Žiadne: pywinauto, python runner, vision-assert, ui-automation-memory, healing.

## 6. Dashboard UI
- Toolbar ikonky: ⟳ obnoviť, ➕ test, ⚙ nastavenia (init len keď neinicializované).
- Sekcie: Stav konfigurácie (kompakt), Zoznam testov (karty: stav-bodka, názov, čas, Spustiť/Report) + filter stavov.
- Report panel: verdikt badge, zhrnutie, kroky so screenshotmi, transcript.
- Čisté HTML + theme CSS premenné, žiadny toolkit (deprecated).

## 7. Status mapping
- `result.md` riadok `VERDIKT: PASSED` → success, `FAILED` → failed, inak unknown.
- Spustiť: VŽDY MCP (žiadne python/js). Webové aj desktop = delegateToAgentMode.

## 8. Out of scope
- Žiadny code-gen, žiadne lokálne spúšťanie skriptov, žiadne dva status súbory.
