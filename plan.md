# Plan: Oprava generovania testov — web + desktop + auto-healing

## TL;DR
Extension generuje nekvalitné skripty a pri zlyhaní nezasahuje automaticky.
Problémy sú na 3 úrovniach: (1) chybné hardcoded veci v promptoch, (2) pamäť
existuje ale nikdy sa nepoužíva, (3) žiadny auto-healing loop.
Platí pre web (Playwright) aj desktop (pywinauto).

---

## Phase 1 — Fix hardcoded bugov v login šablóne (extension.ts, 2 miesta)

**1a. Line ~1303 — generate loginCredentials**
- Nahraď: `await page.waitForLoadState('networkidle', { timeout: 10000 });`
- Za: `await page.waitForFunction(() => !document.body?.innerText?.includes('Completing login'), { timeout: 30000 });`
  + `await page.waitForTimeout(2000);`
- Dôvod: Blazor SPA — `waitForLoadState` vždy timeoutuje

**1b. Line ~2290 — regenerate loginCredentials**
- Rovnaká oprava ako 1a

---

## Phase 2 — Posilniť web test prompt (generate + regenerate)

**2a. "POVINNÉ SELEKTORY" sekcia z project_overview**
- Ak `projectOverview` nie je prázdny, pridaj explicitnú sekciu s vzormi:
  - tab: `page.locator('li.tab a:has-text("...")')`
  - filter: `label[for=ID] → #ID`
  - dropdown: `div.dtc-dropdown-trigger → input.dtc-dropdown-filter → getByTitle`
  - detail ikona: `.v-icon-detail`
- Zakázať: `waitForLoadState` (okrem po goto), placeholder komentáre

**2b. "KOMPLETNÝ KÓD" príkaz**
- Pridaj: "Každý krok scenára MUSÍ mať reálny fungujúci kód. NIKDY nevytváraj placeholder komentáre."

**2c. Inject `memoryContext` do web promptu**
- Ak `automationMemory.formatForPrompt()` vracia string → vložiť do promptu

---

## Phase 3 — Desktop (pywinauto) problémy (extension.ts + ui-automation-memory.ts)

**3a. Memory sa nikdy nepoužíva v prompte — KRITICKÉ**
- Line ~1332: `memoryContext` sa vypočíta ale zahodí (nikdy nevložený do promptu)
- Line ~2317: rovnaký problém v regenerate
- Oprava: Pridaj `${memoryContext}` do pywinauto promptu (generate + regenerate)

**3b. `parseStrategyLogsFromFile` nikdy nič nevráti**
- Čaká `{"message": "STRATEGY_SUCCESS: type|name|strategy"}` — PS formát
- Pywinauto zapisuje `{"logs": ["[ts] Kliknuté na: \"X\"", ...], "test_passed": false}`
  alebo starý formát: pole stringov `["[ts] message", ...]`
- Oprava v `ui-automation-memory.ts`:
  - Detekuj pywinauto formát (pole stringov v `logs` alebo root pole)
  - `'Kliknuté na: "X"'` → `{elementType: 'click', elementName: 'X', strategyName: 'click_by_text', result: 'success'}`
  - `'Element "X" nebol nájdený'` → `{..., result: 'failure'}`

**3c. Vision analýza dáva C# kód namiesto pywinauto**
- V `errorAnalysisPrompt` (line ~1793) chýba kontext o Python/pywinauto
- Oprava: Pridaj "Všetky opravy MUSIA byť Python pywinauto syntax."

**3d. Memory notes sú nekvalitné text bloby**
- Ukladá sa `errorAnalysis.substring(0, 200)` — orezaná blob analýza
- Oprava: ak `notFoundInfo.searching_for` existuje → ulož konkrétnu info:
  `"[not_found] '${searching_for}' → ${jednoriadkové zhrnutie}"`

---

## Phase 4 — Web test memory

**4a. Inicializuj `automationMemory` aj pre web testy**
- Aktuálne: podmienka `if (isPywinautoBackend)` obmedzuje init na desktop
- Oprava: inicializuj pre VŠETKY typy testov (generate + regenerate)

---

## Phase 5 — Auto-healing loop (web + desktop, max 2 pokusy)

**5a. Po každom zlyhaní testu — auto-regenerate s vision feedbackom:**
1. Spusti vision analýzu (ako doteraz)
2. Ak NIE je "VIZUÁLNE PASSED" → auto-regenerate s vision kontextom v prompte
3. Znova spusti test (max 2 auto-pokusy)
4. Ak stále zlyháva → daj kontrolu používateľovi

**5b. Vision feedback v auto-regenerate prompte:**
- Pridaj: `DÔVOD PREDCHÁDZAJÚCEHO ZLYHANIA:\n${visionAnalysis}`
- Ak `not_found_info.json`: `ELEMENT '${searching_for}' NEBOL NÁJDENÝ. Vision vidí: ...`

**5c. Platí pre oba typy:**
- Desktop: po `sys.exit(1)` / catch block → auto-regenerate
- Web: po `error_screenshot.png` / catch block → auto-regenerate

---

## Relevantné súbory

- `src/extension.ts` — všetky zmeny (prompty, login template, memory init, auto-healing)
  - Line ~1273: loginCredentials šablóna (web generate)
  - Line ~1312: memory init (len pywinauto → rozšíriť na všetky)
  - Line ~1332: memoryContext variable (zahodí sa → uložiť do outer scope)
  - Line ~1415: pywinauto generate prompt (pridať memoryContext)
  - Line ~1580: web generate prompt (POVINNÉ SELEKTORY + KOMPLETNÝ KÓD)
  - Line ~1793: errorAnalysisPrompt (pridať pywinauto context)
  - Line ~1875: po not_found → auto-healing namiesto return
  - Line ~2250: regenerate loginCredentials
  - Line ~2296: regenerate memory init
  - Line ~2330: regenerate pywinauto prompt (memoryContext)
  - Line ~2430: regenerate web prompt (POVINNÉ SELEKTORY)
  - catch block (~2540+): auto-healing po failure
- `src/ui-automation-memory.ts`
  - `parseStrategyLogsFromFile`: rozšíriť pre pywinauto log formát

---

## Verification

1. Web: vygenerovaný skript — žiadny `waitForLoadState` okrem po goto, žiadne placeholder komentáre
2. Web: skript používa `.tab a:has-text()` / `.v-icon-detail` z project_overview
3. Desktop: memory notes sa vložia do promptu pri regenerate
4. Desktop: vision analýza dáva Python/pywinauto fix (nie C#)
5. Web + Desktop: po zlyhaní auto-regenerate bez zásahu používateľa
6. `ui_automation_memory.json` → `strategies[]` rastie po pywinauto behu
