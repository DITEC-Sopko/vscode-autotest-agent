# Autotest Agent 🤖

AI-powered automatizované testovanie pre VS Code s GitHub Copilot vision API.

## 🎯 Pre koho je tento agent?

### **👨‍💻 Developer Workflow** (aktuálny focus)
- Automatické testovanie bugov z TFS/Azure DevOps
- Vizuálna kontrola či je bug opravený
- Generovanie Playwright testov pomocou AI
- Iteratívne ladenie testov cez test scenáre

### **🧪 Tester Workflow** (budúca funkcionalita)
- Vytváranie test cases
- Bug reporting do TFS
- Test suite management
- Regression testing

---

## 📦 Inštalácia

1. **Nainštaluj extension** v VS Code
2. **GitHub Copilot** subscription (pre AI modely s vision support)
3. **Playwright** sa nainštaluje automaticky pri prvom teste

---

## 🚀 Quick Start (Developer)

### 1. **Prvá konfigurácia:**
```
@autotest init
```
- Vyber rolu: **Developer**
- Nastav URL aplikácie: `http://localhost:3000` alebo tvoj server
- Pridaj login credentials ak aplikácia vyžaduje prihlásenie
- Pripoj TFS/Azure DevOps (voliteľné)

### 2. **Vyber AI model s vision support:**
```
@autotest model
```
Odporúčame GPT-4o alebo model s "vision" v názve.

### 3. **Zapni viditeľný browser (pre debugging):**
```
@autotest debug
→ Vyber: 👁️ Viditeľný browser (Headed)
```

### 4. **Testuj bug:**
```
@autotest over bug 622116
```
alebo bez TFS:
```
@autotest test
```

### 5. **Desktop mode (PowerShell UI Automation):**
Pri `@autotest init` vyber:
- Typ aplikácie: `Desktop`
- Backend: `PowerShell UI Automation` (odporúčané - žiadna inštalácia)
- App target: absolútna cesta k `.exe` alebo App User Model ID
- Probe: Áno (extension otvorí app a zistí presné údaje o okne)

Príklady targetu:
```text
C:\Program Files\MyApp\MyApp.exe
Microsoft.WindowsCalculator_8wekyb3d8bbwe!App
```

**Probe feature:** Extension skúšobne otvorí aplikáciu a automaticky zistí:
- Názov hlavného okna
- ClassName
- AutomationId

Tieto údaje sa uložia do `autotest/desktop_app_metadata.json` a AI ich použije pri generovaní testov → výrazne vyššia spoľahlivosť!

Extension potom v desktop mode generuje PowerShell `.ps1` script (nie JavaScript).

---

## 📁 Štruktúra generovaných testov

```
váš-projekt/                    ← Váš VS Code workspace
├── .gitignore                  ← Automaticky updatovaný! ✨
├── src/
├── package.json
└── autotest/                   ← Automaticky v .gitignore
    └── bug_622116/
        ├── test_scenario.md     ← Ľudsky čitateľné kroky (editovateľné!)
        ├── test.spec.js         ← Playwright script (auto-generated)
        ├── test_result.md       ← 🆕 Detail report (čo zlyhalo, prečo)
        ├── success_screenshot.png  ← Ak test prejde
        └── error_screenshot.png    ← Ak test zlyhá
```

**Automatická Git integrácia:** 🎉
- Pri **prvom teste** extension automaticky pridá `autotest/` do `.gitignore`
- Ak `.gitignore` neexistuje, vytvorí ho
- Ak už existuje, pridá autotest entries na koniec
- **Nemusíš nič robiť manuálne!**

📖 *Detaily: [GITIGNORE_AUTO_UPDATE.md](./GITIGNORE_AUTO_UPDATE.md)*

---

---

## 🔄 Workflow pri zlyhaniach

1. **Test zlyhá** → automaticky sa vytvorí `error_screenshot.png`
2. **AI analyzuje** screenshot a povie čo je problém
3. **test_result.md** obsahuje detailný report:
   - Kde test zlyhala
   - Čo nenašla (tlačidlo, tabuľka prázdna, ...)
   - Console output
   - Návrh na opravu
4. **Upravíš** `test_scenario.md` (napr. zmeníš názov buttonu)
5. **Regeneruješ** test:
   ```
   @autotest regenerate bug_622116
   ```
6. Test sa znova vygeneruje a spustí podľa upraveného scenára

---

## 🎯 Inteligentné Features

### **Flexibilné selektory:**
- AI automaticky skúša viacero spôsobov nájsť element:
  - Text v buttone: `"Detail"`, `"Detaily"`, `"detail"`
  - Icon classes: `icon-detail`, `fa-info-circle`
  - ARIA labels: `aria-label="Show detail"`
- Ak scenár hovorí "zobrazí detail", AI hľadá všetky možnosti automaticky

### **Smart defaults:**
- "Vyber klienta" → automaticky vyberie **prvého v tabuľke**
- "Otvor dokument" → prvý v zozname
- "Zadaj dátum" → dnešný dátum
- Nemusíš špecifikovať každý detail!

### **Validácie:**
- AI automaticky kontroluje:
  - Či je tabuľka naplnená (alebo prázdna)
  - Či sa panel zobrazil
  - Počet riadkov v grid
- Console output v `test_result.md` ukazuje presné čísla

---

## 📋 Všetky príkazy

| Príkaz | Popis |
|--------|-------|
| `@autotest init` | Inicializácia konfigurácie |
| `@autotest model` | Výber AI modelu s vision support |
| `@autotest debug` | Prepnutie viditeľný/neviditeľný browser |
| `@autotest over bug 123` | Testovať bug z TFS |
| `@autotest test` | Testovať bez TFS (manuálny popis) |
| `@autotest regenerate bug_123` | Regenerovať test zo scenára |
| `@autotest history` | História testov |

---

## ⚙️ Konfigurácia

### **TFS/Azure DevOps:**
- Organization URL: `http://tfs-server:8080/tfs/project` alebo `https://dev.azure.com/org`
- PAT token s read permissions
- Automatické načítavanie bug detailov

### **Login Credentials:**
- Username a heslo sa ukladajú bezpečne (SecretStorage)
- Automaticky sa použijú v každom teste
- Každý workspace má vlastné credentials

### **Debug módy:**
- **Viditeľný (Headed):** Vidíš browser, slowMo 100ms
- **Pomalý debug:** Každá akcia trvá 500ms
- **Rýchly (Headless):** Na pozadí, bez UI

---

## 🔧 Requirements

- VS Code 1.120.0+
- GitHub Copilot subscription
- Node.js (pre Playwright)
- Prístup k TFS/Azure DevOps (voliteľné)

---

## 🐛 Troubleshooting

### Test nenájde element?
1. Zapni viditeľný mód: `@autotest debug`
2. Sleduj čo sa deje v browseri
3. Uprav `test_scenario.md`
4. Regeneruj: `@autotest regenerate bug_XXX`

### Playwright sa nenainštaloval?
```bash
npm install playwright
npx playwright install chromium
```

### Desktop test sa nespustí (WinAppDriver)?
- Skontroluj, že WinAppDriver beží na `127.0.0.1:4723`
- Over, že app target v konfigurácii je správny (`.exe` path alebo App User Model ID)
- Spusť test znova cez `@autotest test` alebo `@autotest over bug 123`

### TFS pripojenie zlyhá?
- Skontroluj URL (HTTP aj HTTPS funguje)
- Validuj PAT token permissions
- Skús `@autotest init` znova

---

## 📝 Developer Tips

- **Test scenáre sú editovateľné** - nemusíš meniť JavaScript
- **Error screenshoty** ti povedia presne kde test zlyhala
- **Vision AI** analyzuje výsledky automaticky
- **Iteruj rýchlo:** uprav scenár → regeneruj → testuj

---

## 🎯 Roadmap

- [ ] Tester workflow (test case management)
- [ ] Bug reporting do TFS s attachmentami
- [ ] Test suite organization
- [ ] CI/CD integrácia
- [ ] Multi-browser testing
- [ ] Paralelné spúšťanie testov

---

## 📄 Licencia

MIT

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
