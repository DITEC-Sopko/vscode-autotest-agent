# 🎯 Ako Extension Updatuje Váš .gitignore

## Prvé spustenie v projekte

### **Scenár: Máte projekt bez .gitignore**

**Pred:**
```
your-project/
├── src/
│   └── app.ts
└── package.json
```

**Spustíte:**
```
@autotest over bug 622116
```

**Po:**
```
your-project/
├── .gitignore          ← ✨ NOVÝ! Extension ho vytvoril
├── src/
│   └── app.ts
├── package.json
└── autotest/           ← Vygenerované testy
    └── bug_622116/
```

**Obsah `.gitignore`:**
```gitignore
# Autotest Agent - generované testy
autotest/
*.spec.js
error_screenshot.png
success_screenshot.png
```

---

### **Scenár: Už máte .gitignore**

**Pred:**
```gitignore
# Váš existujúci .gitignore
node_modules/
dist/
.env
```

**Spustíte:**
```
@autotest over bug 622116
```

**Po:**
```gitignore
# Váš existujúci .gitignore
node_modules/
dist/
.env

# Autotest Agent - generované testy
autotest/
*.spec.js
error_screenshot.png
success_screenshot.png
```

Extension **pridá na koniec** bez mazania existujúceho obsahu!

---

## Bezpečnosť a Inteligencia

### **Duplikácia:**
✅ Extension **skontroluje** či `autotest/` už je v `.gitignore`  
✅ Ak áno, **nepridá znova**  
✅ Žiadne duplikáty!

### **Kde to beží:**
- ✅ Funkcia `ensureGitignore()` sa volá **len pri prvom vytvorení** `autotest/` priečinka
- ✅ Nespomaľuje každý test
- ✅ Jeden workspace = jedna aktualizácia

### **Chyby:**
- Ak zápis do `.gitignore` zlyhá (permissions, read-only...), extension pokračuje ďalej
- Nefatálna chyba - test bude fungovať aj tak
- Console log vypíše chybu pre debugging

---

## Git Status Po Prvom Teste

```bash
$ git status
On branch feature/bug-622116
Changes not staged for commit:
  modified:   .gitignore

Untracked files:
  (none - autotest/ je ignorovaný!)
```

**Commit len .gitignore:**
```bash
git add .gitignore
git commit -m "Add autotest/ to gitignore"
git push
```

Všetci v tíme budú mať správny `.gitignore` a nikto negituje svoje lokálne testy! 🎉

---

## Prečo to takto?

### **Automatizácia:**
- Nemusíš pamätať pridať do `.gitignore`
- Setup je "zero-config"
- Funguje out-of-the-box

### **Team-friendly:**
- Jeden človek spustí extension → .gitignore sa commitne
- Ostatní majú automaticky správnu konfiguráciu
- Konzistencia naprieč tímom

### **Bezpečnosť:**
- Login credentials (v test scenároch) sa negitujú
- Internal URLs nie sú v public repo
- PAT tokens chránené

---

## FAQ

### **Čo ak chcem gitovať nejaký konkrétny test?**
Vytvor si priečinok mimo `autotest/`, napríklad `tests/integration/`.

### **Môžem upraviť .gitignore entries?**
Áno! Extension len pridá základné. Môžeš upraviť ako chceš.

### **Čo ak zmažem .gitignore?**
Extension ho vytvorí znova pri ďalšom teste.

### **Funguje to v mono-repo?**
Áno! `.gitignore` sa updatuje v workspace roote.

---

Happy testing! 🚀
