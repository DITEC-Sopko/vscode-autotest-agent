# 🧪 Tester Workflow (Coming Soon)

> **Note:** Aktuálne je agent optimalizovaný pre **Developer workflow**.  
> Tester funkcionalita je v pláne pre budúce verzie.

---

## 🎯 Plánované funkcie pre Testerov

### **1. Test Case Management**
- Vytváranie test case templates
- Organizácia do test suite
- Prioritizácia test cases
- Tagy a kategórie

### **2. Bug Reporting**
- Automatické vytváranie bugov v TFS
- Attach screenshotov
- Reproduction steps generovanie
- Severity/Priority nastavenie

### **3. Test Execution Tracking**
- Pass/Fail rate statistiky
- Test run history
- Regression detection
- Flaky test identification

### **4. Advanced Testing**
- Cross-browser testing (Chrome, Firefox, Safari)
- Mobile testing support
- API testing integrácia
- Performance testing

### **5. Reporting**
- PDF test report export
- Stakeholder-friendly dashboards
- Test coverage metrics
- Bug trend analysis

---

## 🔄 Rozdiel: Developer vs Tester Workflow

| Feature | Developer | Tester |
|---------|-----------|--------|
| **Cieľ** | Overiť že bug je fixed | Vytvoriť & spustiť test cases |
| **Input** | Bug ID z TFS | Test scenario / requirements |
| **Output** | Pass/Fail + screenshot | Detailed test report |
| **TFS** | Čítanie bug detailov | Čítanie + zápis bugov |
| **Focus** | Rýchle overenie | Kompletné pokrytie |
| **Test Cases** | Ad-hoc, jednorazové | Organizované, opakovateľné |

---

## 💼 Use Cases pre Testerov

### **Regression Testing:**
```
@autotest run-suite smoke-tests
```
→ Spustí všetky smoke testy
→ Report s výsledkami
→ Screenshot každého testu

### **Exploratory Testing:**
```
@autotest explore feature-X
```
→ AI navrhne test scenáre
→ Manuálne overíš
→ Automaticky vytvorí test cases

### **Bug Reporting:**
```
@autotest report-bug
```
→ Screenshot
→ Reproduction steps
→ System info
→ Automaticky vytvorí bug v TFS

---

## 📅 Roadmap Timeline

- **Q2 2026:** Developer workflow (✅ hotové!)
- **Q3 2026:** Test case management
- **Q4 2026:** Bug reporting
- **Q1 2027:** Test suite organization
- **Q2 2027:** Advanced testing features

---

## 🎬 Chceš prispieť?

Máš nápady na tester workflow? Feedback je vítaný!

---

*Pre developer workflow, pozri [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)*
