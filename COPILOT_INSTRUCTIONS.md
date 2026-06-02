# Kontext Projektu: VS Code Autotest Agent

## 🎯 O projekte
VS Code rozšírenie s Chat Participantom `@autotest` pre automatizované testovanie pomocou AI.

**Current Focus:** 👨‍💻 **Developer Workflow**  
Automatické testovanie bugov po oprave kódu.

---

## ✅ Čo je hotové (v1.0 - Developer Workflow):

### **Core Features:**
1. ✅ **Konfigurácia** (`@autotest init`)
   - User role selection (developer/tester)
   - App URL, environment, app type
   - Login credentials (username/password v SecretStorage)
   - TFS/Azure DevOps integrácia (PAT token)
   - AI model selection s vision support

2. ✅ **Test Generation**
   - AI generuje test scenár (markdown) + Playwright script
   - Štruktúrovaný file system: `autotest/bug_{ID}/`
   - Error handling s try-catch
   - Screenshot pri chybe aj úspechu

3. ✅ **Test Execution**
   - Automatická inštalácia Playwright
   - Spustenie cez child_process
   - Headed/headless mode prepínanie
   - SlowMo pre debugging

4. ✅ **Vision Analysis**
   - AI analyzuje success screenshot
   - AI analyzuje error screenshot pri zlyhaniach
   - Návrhy na opravu test scenára

5. ✅ **Test Regeneration** (`@autotest regenerate`)
   - Úprava test_scenario.md
   - Regenerácia Playwright scriptu
   - Iteratívne ladenie testov

6. ✅ **TFS Integration**
   - Načítanie bug detailov z TFS
   - HTTP aj HTTPS support
   - PAT authentication

7. ✅ **Git Integration**
   - `autotest/` priečinok v `.gitignore`
   - **Automatické updatovanie používateľovho `.gitignore`** pri prvom teste
   - Extension vytvorí `.gitignore` ak neexistuje
   - Pridá entries bez duplikácie

### **Príkazy:**
- `@autotest init` - Konfigurácia
- `@autotest model` - Výber AI modelu
- `@autotest debug` - Headed/headless prepínanie
- `@autotest over bug 123` - Test z TFS
- `@autotest test` - Manuálny test
- `@autotest regenerate bug_123` - Regenerácia zo scenára
- `@autotest history` - História testov

---

## 📁 File Structure

```
autotest/                       ← V .gitignore
├── bug_622116/
│   ├── test_scenario.md        ← AI-generated, editovateľný
│   ├── test.spec.js            ← Playwright script
│   ├── success_screenshot.png  ← Pri úspechu
│   └── error_screenshot.png    ← Pri zlyhaniach
```

---

## 🚧 Čo je plánované (Tester Workflow - TBD):

- [ ] Test case management
- [ ] Bug reporting do TFS (create, update status)
- [ ] Test suite organization
- [ ] Cross-browser testing
- [ ] Regression testing automation
- [ ] Test run reports (PDF export)

## 🖥️ Desktop testovanie (dlhodobý plán):

- [ ] Podpora natívnych Windows aplikácií (WPF, WinForms, .NET MAUI)
- [ ] Integrácia Appium + WinAppDriver (WebDriver protokol)
- [ ] Auto-inštalácia Appium cez npm, manuálny krok pre WinAppDriver .msi
- [ ] Generovanie Appium testov miesto Playwright pre appType = 'desktop'
- [ ] Poznámka: Playwright funguje len pre web/Electron, nie pre čisto natívne desktop appky

---

## 🔧 Tech Stack

- **Language:** TypeScript
- **Platform:** VS Code Extension API v1.120.0+
- **AI:** GitHub Copilot Language Model API (`vscode.lm`)
- **Vision:** LanguageModelDataPart.image() (GPT-4o, vision models)
- **Testing:** Playwright (auto-installed)
- **Storage:** 
  - GlobalState (user preferences)
  - WorkspaceState (project config)
  - SecretStorage (PAT tokens, passwords)
- **TFS:** azure-devops-node-api v12.5.0

---

## 📋 Configuration Schema

```typescript
interface AutotestConfig {
  userRole: 'developer' | 'tester' | 'unknown';
  appUrl: string;
  appType: 'web' | 'desktop' | 'mobile';
  environment: 'local' | 'remote';
  tfsEnabled: boolean;
  tfsOrganization?: string;
  tfsProject?: string;
  loginRequired?: boolean;
  username?: string;
  headlessMode?: boolean;
  slowMo?: number;
  preferredModelId?: string;
}
```

Passwords a PAT tokeny v SecretStorage (šifrované).

---

## 🎓 Developer Workflow

```
1. Bug z TFS #622116
   ↓
2. Oprav kód
   ↓
3. @autotest over bug 622116
   ↓
4. AI: test scenár + script + execution + vision analysis
   ↓
5a. ✅ Prejde → commit
5b. ❌ Zlyhá → AI analýza → uprav test_scenario.md → regeneruj
```

---

## 🔍 Key Implementation Details

### **Playwright Test Generation Prompt:**
- Obsahuje login credentials (ak sú nastavené)
- Fallback selektory pre login button (regex pattern)
- Try-catch obal s error screenshot
- Headless/slowMo konfigurácia

### **Error Handling:**
- Každý test má try-catch
- Pri chybe: `error_screenshot.png` + console.error
- AI analyzuje error screenshot a povie čo zmeniť

### **Vision Analysis:**
- Success: AI porovná screenshot s popisom bugu
- Error: AI analyzuje kde test zlyhala + návrh riešenia

---

## 🛠️ Prípadné úpravy/rozšírenia

Pre budúce zmeny:
- Všetky AI calls cez `vscode.lm` API (nie external OpenAI)
- Credentials v SecretStorage (bezpečnosť)
- File structure v `autotest/` (v .gitignore)
- Error handling všade (try-catch)

---

## 📚 Dokumentácia

- [README.md](./README.md) - Všeobecný prehľad
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) - Developer workflow guide
- [TESTER_GUIDE.md](./TESTER_GUIDE.md) - Plánované tester features

---

**Status:** ✅ Developer Workflow COMPLETE  
**Next:** 🧪 Tester Workflow (TBD)

