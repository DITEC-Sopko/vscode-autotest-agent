# 👨‍💻 Developer Workflow Guide

Tento guide je pre **developerov** ktorí chcú automaticky testovať svoje bugy.

---

## 🎯 Use Case

Dostal si bug z TFS: **"Bug #622116: Zobrazenie prehľadu o klientovi nefunguje"**

**Klasický postup:**
1. Prečítať bug ✅
2. Opraviť kód ✅
3. **Manuálne testovať** ❌ (otváraš browser, klikáš, kontroluješ...)
4. Commit & push

**S Autotest Agent:**
1. Prečítať bug ✅
2. Opraviť kód ✅
3. `@autotest over bug 622116` ✅ (automatický test + vizuálna kontrola)
4. Commit & push

---

## ⚡ Quick Start (5 minút)

### **Setup (raz):**
```
@autotest init
```
- Rola: **Developer**
- URL: `http://localhost:3000` (alebo tvoj dev server)
- Login: `admin` / `heslo123` (ak aplikácia vyžaduje)
- TFS: `http://tfs-server:8080/tfs/project`

```
@autotest model
```
- Vyber GPT-4o alebo model s vision support

```
@autotest debug
```
- Vyber: **Viditeľný browser** (na začiatku odporúčame)

### **Každodenné použitie:**
```
@autotest over bug 622116
```

**Agent automaticky:**
1. ✅ Načíta popis bugu z TFS
2. ✅ Vygeneruje test scenár (kroky)
3. ✅ Vygeneruje Playwright script
4. ✅ Spustí test (vidíš browser ak je headed mode)
5. ✅ Spraví screenshot
6. ✅ AI analyzuje či je bug fixed

**Výsledok:**
- `autotest/bug_622116/test_scenario.md` - kroky testu
- `autotest/bug_622116/test.spec.js` - Playwright kód
- `autotest/bug_622116/test_result.md` - 🆕 Detail report
- `autotest/bug_622116/success_screenshot.png` - screenshot ak prejde
- `autotest/bug_622116/error_screenshot.png` - screenshot ak zlyhá

---

## 🎯 Nové Inteligentné Features

### **1. test_result.md - Detail Report** 📄

Každý test vytvorí `test_result.md` s kompletnou analýzou:

**Pri úspechu:**
```markdown
# Test Result: PASSED ✅

## Test Info
- Bug ID: 622116
- Timestamp: 28.5.2026 14:30
- Status: PASSED

## AI Vision Analysis
Test prebehol úspešne. Tabuľka s klientmi sa zobrazila 
s 15 riadkami. Detail panel je viditeľný...

## Console Output
Krok 1: Prihlásenie - OK
Krok 2: Navigácia na Klienti - OK
Počet riadkov: 15
TEST PASSED: Všetky kroky úspešné
```

**Pri zlyhaní:**
```markdown
# Test Result: FAILED ❌

## Problém
Test zlyhala na kroku 3: "Klikni na tlačidlo Detail"

Na obrazovke vidím:
- Tabuľka s klientmi je zobrazená
- Button má text "Detaily" (nie "Detail")
- Button má class "btn-show-details"

Návrh: Zmeň v test_scenario.md krok 3 na:
"Klikni na tlačidlo 'Detaily' alebo class 'btn-show-details'"

## Console Output
Krok 1: OK
Krok 2: OK  
Krok 3: TimeoutError: waiting for locator('button[text="Detail"]')
```

### **2. Flexibilné Selektory** 🎯

AI automaticky generuje **fallback stratégie** pre elementy:

**Príklad:** Scenár hovorí *"Zobrazí detail klienta"*

AI vygeneruje:
```javascript
// Možnosť 1: Text v buttone
try {
  await page.getByRole('button', { name: /detail/i }).click({ timeout: 5000 });
} catch {
  try {
    // Možnosť 2: Icon class/data atribúty
    await page.locator('[class*="icon-detail"], [data-action="detail"]')
              .first().click({ timeout: 5000 });
  } catch {
    // Možnosť 3: ARIA label
    await page.locator('[aria-label*="detail" i]').first().click({ timeout: 5000 });
  }
}
```

**Nemusíš špecifikovať presný selector!** AI skúša všetko.

### **3. Smart Defaults** 🤖

Ak scenár neuvádza konkrétne údaje, AI použije **rozumné defaulty**:

| Scenár hovorí | AI automaticky |
|---------------|----------------|
| "Vyber klienta" | `await page.locator('table tbody tr').first().click();` |
| "Otvor dokument" | Prvý v zozname |
| "Zadaj dátum" | Dnešný dátum |
| "Filtruj záznamy" | Klikne na tlačidlo/ikonu filter |

**Nemusíš písať:** *"Vyber prvého klienta z tabuľky s ID 12345"*  
**Stačí:** *"Vyber klienta"* → AI vie čo robiť!

### **4. Automatické Validácie** ✅

AI pridáva kontroly do testu:

```javascript
// Kontrola počtu riadkov
const rowCount = await page.locator('table tbody tr').count();
console.log('Počet riadkov:', rowCount);
if (rowCount === 0) {
  console.error('PROBLÉM: Tabuľka je prázdna!');
}

// Kontrola viditeľnosti
await page.waitForSelector('.detail-panel', { timeout: 5000 });
console.log('Krok X: Detail panel sa zobrazil - OK');
```

Vidíš presne čo sa deje v `test_result.md`!

---

## 🔄 Keď test zlyhá

### **Scenár:** Test nenájde button "Zobrazenie prehľadu o klientovi"

**Agent ti povie:**
```
⚠️ Test zlyhala pred dokončením!
📸 error_screenshot.png

🔍 Analýza zlyhania:
Test zlyhala na kroku 3: "Klikni na Zobrazenie prehľadu o klientovi"

Na obrazovke vidím:
- Menu je viditeľné
- Button existuje, ale má text "Prehľad klienta" (kratší text)

Návrh: Zmeň krok 3 v test_scenario.md na: "Klikni na button 'Prehľad klienta'"
```

### **Čo urobíš:**

1. **Otvor scenár:**
   ```
   autotest/bug_622116/test_scenario.md
   ```

2. **Uprav krok 3:**
   ```markdown
   ## Test kroky:
   1. Prihlás sa do aplikácie
   2. Klikni na menu "Klienti"
   3. Klikni na button 'Prehľad klienta'  ← Opravené!
   4. Skontroluj že sa zobrazí tabuľka
   ```

3. **Regeneruj test:**
   ```
   @autotest regenerate bug_622116
   ```

4. **Agent:**
   - Načíta upravený scenár
   - Vygeneruje nový `test.spec.js`
   - Spustí test znova
   - ✅ Teraz prejde!

---

## 🎬 Debug Mode Tips

### **Viditeľný browser (Headed):**
- Vidíš presne čo test robí
- Spomalené akcie (100ms delay)
- Ideálne na začiatku alebo pri problémoch

### **Pomalý debug:**
- Každá akcia trvá 500ms
- Sledovať detail by detail
- Pre komplikované scenáre

### **Rýchly headless:**
- Test beží na pozadí
- Maximálna rýchlosť
- Keď vieš že test funguje

**Prepínanie:**
```
@autotest debug
→ Vyber požadovaný mód
```

---

## 📊 História testov

```
@autotest history
```

Vidíš:
- Ktoré bugy si testoval
- Kedy (timestamp)
- Výsledok (success/failed)

---

## 🔒 Git & Autotest

**Extension automaticky updatuje váš `.gitignore`!** 🎉

Pri **prvom spustení testu** v projekte:
1. Extension vytvorí `autotest/` priečinok
2. Automaticky pridá do `.gitignore`:
   ```gitignore
   # Autotest Agent - generované testy
   autotest/
   *.spec.js
   error_screenshot.png
   success_screenshot.png
   ```
3. Ak `.gitignore` neexistuje, vytvorí ho
4. Ak už existuje, pridá entries na koniec (bez duplikátov)

**Čo to znamená:**
- ✅ Žiadne manuálne editovanie `.gitignore`
- ✅ Generované testy sa **automaticky negitujú**
- ✅ Každý developer má vlastné lokálne testy
- ✅ Žiadne git konflikty
- ✅ Bezpečnosť (credentials nie sú v gite)

**Výsledok po prvom `@autotest` spustení:**
```bash
$ git status
On branch main
Changes not staged for commit:
  modified:   .gitignore        ← Extension to updatoval
  modified:   src/myfile.ts     ← Tvoje zmeny

Untracked files:
  (nothing - autotest/ je ignorovaný)
```

📖 **Viac detailov:** [GITIGNORE_AUTO_UPDATE.md](./GITIGNORE_AUTO_UPDATE.md)

---

---

## 💡 Best Practices

### **1. Používaj Headed mode pri novom projekte**
Vidíš čo sa deje, ľahšie debuguješ.

### **2. Ulož test scenáre pre komplexné bugy**
Editovateľný markdown je zlatý - môžeš ho používať opakovane.

### **3. AI analýza je tvoj priateľ**
Keď test zlyhá, AI ti presne povie čo zmeniť.

### **4. Iteruj rýchlo**
Uprav scenár → regeneruj → testuj. Nemeň JavaScript kód ručne.

### **5. TFS integrácia šetrí čas**
Automatické načítanie bug detailov = menej kopírovania.

---

## 🚦 Typický Workflow

```
1. TFS: Priradený bug #622116
   ↓
2. Prečítaš popis
   ↓
3. Opravíš kód v IDE
   ↓
4. @autotest over bug 622116
   ↓
5. Agent spustí test + vizuálna kontrola
   ↓
6a. ✅ Test prejde → commit & push
   ↓
6b. ❌ Test zlyhá → oprav scenár → regeneruj
   ↓
7. Updatni TFS bug status
```

---

## 🎓 Advanced: Custom Test Scenarios

Môžeš si **vytvoriť vlastné scenáre** pre často používané workflows:

```markdown
# test_scenario.md

## Test kroky:
1. Prihlás sa ako admin
2. Prejdi na sekciu "Reports"
3. Vyber "Monthly summary"
4. Skontroluj graf
5. Export do PDF
```

Potom len:
```
@autotest regenerate custom_report_test
```

A máš vždy čerstvý test script!

---

## 🆘 Troubleshooting

### **"Nenašiel sa AI model"**
→ Skontroluj GitHub Copilot subscription
→ `@autotest model` a vyber model s vision support

### **"Cannot find module 'playwright'"**
→ Agent to automaticky nainštaluje pri prvom teste
→ Alebo manuálne: `npm install playwright`

### **"Test timeout 30000ms exceeded"**
→ Zapni headed mode (`@autotest debug`)
→ Sleduj kde test zasekne
→ Uprav `test_scenario.md`

### **TFS API error**
→ Skontroluj PAT token permissions
→ Skús iný PAT token
→ `@autotest init` pre rekonfiguráciu

---

## 📞 Feedback

Máš nápady na vylepšenie? Našiel si bug?
→ Otvor issue v GitHub repo

---

Enjoy automated testing! 🎉
