# Desktop Automation - Možnosti a Bezpečnosť

## 🔒 Windows Developer Mode - Bezpečnosť

### Čo Developer Mode robí:
- Umožňuje **sideloading aplikácií** (inštalácia .appx bez Microsoft Store)
- Umožňuje **spúšťanie neverifikovaných aplikácií** (bez digitálneho podpisu)
- Aktivuje **UI Automation API** pre testovanie (potrebné pre WinAppDriver)
- Povolí **SSH server** (voliteľné)

### ⚠️ Bezpečnostné riziká:
1. **Nižšia ochrana** - Windows nebude blokovať aplikácie bez podpisu
2. **Malware riziko** - ak náhodou spustíš neznámy .exe, nebude warning
3. **Nie pre produkčné prostredie** - Developer Mode je určený len pre vývojárske stanice

### ✅ Odporúčanie:
- **Zapni len na dedikovanom vývojárskom PC** (nie na produkcii)
- **Vypni po testovaní** ak nechceš mať trvalo aktívny
- **Skontroluj firewall** - Developer Mode môže otvoriť porty

---

## 🛠️ Alternatívne možnosti pre Desktop Automation

### 1. **WinAppDriver + Selenium WebDriver** ⭐ (aktuálne riešenie)
**Výhody:**
- Open-source od Microsoftu
- WebDriver protokol (štandardizovaný)
- JavaScript/Node.js podpora cez `selenium-webdriver`
- Aktívne udržiavaný (GitHub: 3k+ stars)

**Nevýhody:**
- Vyžaduje Developer Mode
- Manuálna inštalácia (.msi installer)
- Musí bežať ako samostatný proces

**Inštalácia:**
```powershell
# Stiahnuť z: https://github.com/Microsoft/WinAppDriver/releases
# Spustiť WinAppDriver.msi
# Povoliť Developer Mode v Settings
```

---

### 2. **UI Automation cez PowerShell** (natívne Windows)
**Výhody:**
- Žiadna inštalácia, natívne Windows API
- Netreba Developer Mode
- Priamy prístup k UI Automation COM objektom

**Nevýhody:**
- PowerShell kód (nie JavaScript)
- Extension by musel generovať .ps1 scripty namiesto .js
- Zložitejšia syntax pre komplexné akcie

**Príklad:**
```powershell
Add-Type -AssemblyName UIAutomationClient
$automation = [System.Windows.Automation.AutomationElement]::RootElement
$button = $automation.FindFirst(...)
$button.Invoke()
```

**Možnosť pre extension:**
- Generovať PowerShell test namiesto JavaScript
- Spúšťať cez `powershell.exe -File test.ps1`

---

### 3. **FlaUI** (.NET wrapper pre UI Automation)
**Výhody:**
- Moderný .NET framework
- Netreba Developer Mode
- Lepšia API ako raw UI Automation
- Aktívne udržiavaný

**Nevýhody:**
- Vyžaduje .NET runtime
- Extension by musel generovať C# kód
- Komplikovanejšie spúšťanie (csc.exe kompliácia alebo dotnet)

**Príklad:**
```csharp
using FlaUI.Core;
var app = Application.Launch("calc.exe");
var window = app.GetMainWindow(automation);
var button = window.FindFirstDescendant(cf => cf.ByText("1"));
button.Click();
```

---

### 4. **Pywinauto** (Python-based)
**Výhody:**
- Populárny, aktívne udržiavaný
- Netreba Developer Mode
- Veľká komunita

**Nevýhody:**
- Vyžaduje Python runtime
- Extension by generoval Python scripty
- Užívateľ by musel mať Python nainštalovaný

---

### 5. **AutoIt / AutoHotkey**
**Výhody:**
- Špecializované na Windows automation
- Netreba Developer Mode
- Jednoduchá syntax

**Nevýhody:**
- Proprietárny scripting jazyk
- Menej flexibilné ako programovacie jazyky
- Komunita menšia ako Python/JS

---

## 📊 Porovnanie

| Možnosť | Developer Mode? | Runtime | JavaScript? | Open Source | Aktívne? |
|---------|----------------|---------|-------------|-------------|----------|
| **WinAppDriver** | ✅ Áno | Node.js | ✅ Áno | ✅ MS OSS | ✅ Áno |
| **PowerShell UI Automation** | ❌ Nie | Natívne | ❌ Nie | ✅ Natívne | ✅ Áno |
| **FlaUI** | ❌ Nie | .NET | ❌ Nie | ✅ Áno | ✅ Áno |
| **Pywinauto** | ❌ Nie | Python | ❌ Nie | ✅ Áno | ✅ Áno |
| **AutoIt** | ❌ Nie | AutoIt | ❌ Nie | ✅ Áno | ⚠️ Menej |

---

## 🎯 Odporúčanie pre Extension

### **Aktuálne: PowerShell UI Automation** ⭐ (default)
- Žiadna inštalácia, natívne Windows API
- Netreba Developer Mode
- **Desktop App Probe** - automatická detekcia okna pri init
- AI generuje `.ps1` scripty s presnými údajmi o aplikácii

### **Alternatíva: WinAppDriver** (JavaScript/Node.js ekosystém)
- Vyžaduje Developer Mode a inštaláciu
- Najlepšia integrácia s Node.js ekosystémom
- WebDriver API je štandardizovaný

### **Alternatíva 1: PowerShell UI Automation** (bez Developer Mode)
- Extension by generoval `.ps1` scripty namiesto `.js`
- Spúšťal by `powershell.exe -File test.ps1`
- Bezpečnejšie (netreba Developer Mode)
- **Trade-off:** AI musí generovať PowerShell syntax

### **Alternatíva 2: Hybridný prístup**
- Defaultne WinAppDriver (ak má Developer Mode)
- Fallback na PowerShell UI Automation (ak nemá Developer Mode)
- Extension detekuje dostupnosť a ponúkne možnosti

---

## 🔐 Bezpečnostné odporúčanie

### Pre firemné prostredie:
1. **Použiť PowerShell UI Automation** (bez Developer Mode)
2. Alebo **dedikovaná VM/počítač** s Developer Mode len na testovanie
3. **Blokovať Developer Mode** cez Group Policy na produkcii

### Pre jednotlivcov/malé tímy:
1. **WinAppDriver je OK** ak máš vývojársky PC
2. **Vypni Developer Mode** keď nie testuješ
3. **Scan všetky .exe** pred spustením

---

## 🚀 Implementácia alternatív

### Možnosť A: Pridať PowerShell backend do extension
```typescript
// extension.ts
const isPowerShellMode = !isDeveloperModeEnabled || userPreference === 'powershell';

if (isPowerShellMode) {
    // Generate PowerShell script
    const psScript = generatePowerShellTest(scenario);
    // Run: powershell.exe -File test.ps1
} else {
    // Current: Generate Selenium/WinAppDriver script
    const jsScript = generateSeleniumTest(scenario);
    // Run: node test.spec.js
}
```

### Možnosť B: Ponúknuť voľbu v `@autotest init`
```
Desktop automation backend:
1. WinAppDriver (JavaScript) - vyžaduje Developer Mode
2. PowerShell UI Automation (natívne) - bezpečnejšie
```

---

## 💡 Záver

**Pre tvoj use case:**
- Ak máš **dedikovaný vývojársky PC** → **WinAppDriver je OK**
- Ak testujú **viacerí užívatelia** → **zvážiť PowerShell alternativu**
- Ak firma má **prísne security policy** → **PowerShell UI Automation** (bez Developer Mode)

Môžeme pridať voľbu do extension, aby používateľ mohol vybrať backend pri `@autotest init`.
