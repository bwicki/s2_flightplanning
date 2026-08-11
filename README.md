# Weather Sonde Flight Planning

Statische Web-App zur Flugplanung von Wetterballon-Sonden (Pilotballon / Radiosonde): Sie berechnet Gasfüllung, Bersthöhe und die vollständige Flugtrajektorie (Aufstieg – Burst/Release – Abstieg am Fallschirm) auf Basis realer Wind- und Wetterdaten von Open-Meteo und stellt alles auf einer interaktiven Karte dar.

**Live:** https://bwicki.github.io/s2_flightplanning/
**Stack:** Reines HTML/CSS/JavaScript, kein Build-Schritt, kein Backend. Leaflet für die Karte, html2canvas für den Bildexport. Design-System übernommen aus der Gasballoon-Cockpit-App (Wicki Partners Ballonteam).

---

## Funktionsumfang

### Zwei Planungsmodi (Umschalter in der Kopfzeile)
- **⬈ Forward — set launch:** Klick auf die Karte setzt den Startort; die App berechnet sofort automatisch die Trajektorie und den voraussichtlichen Landepunkt.
- **⬊ Backward — set landing:** Klick setzt den gewünschten Landepunkt (violettes Fadenkreuz); die App löst iterativ rückwärts nach einem passenden Startort auf und zeigt die Restabweichung in km.

### Berechnungsmodell
- **Atmosphäre:** ICAO-Standardatmosphäre, am lokalen Bodendruck und der lokalen Temperatur (aus dem Wettermodell) verankert.
- **Ballonfüllung:** Kräftebilanz Auftrieb – Gewicht – aerodynamischer Widerstand (cw ≈ 0,25); das nötige Gasvolumen wird per Bisektion auf die gewählte Ziel-Steigrate gelöst. Ausgabe: Brutto-/Netto-Lift (g), Füllvolumen (m³), Startdurchmesser (m).
- **Bersthöhe:** Ideale Gasexpansion mit der Höhe vs. Berstdurchmesser. Der Berstdurchmesser wird aus dem Ballongewicht geschätzt (Potenzfit D = 0,208 · w^0,456 aus Herstellertabellen 100–3000 g) und kann manuell übersteuert werden.
- **Trajektorie:** Integration in 200-m-Höhenschritten; u/v-Wind aus den Druckflächen des Wettermodells (1000–30 hPa plus 10-m-Wind) höheninterpoliert. Abstieg am Fallschirm mit dichteskalierter Sinkrate (v ∝ 1/√ρ, Referenz = eingegebene Rate auf Meereshöhe).
- **Tropopause:** Bestimmung nach WMO-Kriterium (Temperaturgradient ≤ 2 K/km über 4,5 km) aus den Modelltemperaturen, Anzeige im Ergebnis.
- **Aufstiegsziel:** wahlweise feste Release-Höhe (m AMSL) oder Aufstieg bis zum Bersten.

### Wetterdaten
- **Quelle:** Open-Meteo Forecast API (±5 Tage Vergangenheit bis +15 Tage); ältere Zeitpunkte automatisch über die Archive API (historische Reanalyse).
- **Modellwahl** über den Chip in der Kopfzeile (Popover, gruppiert):
  - *Automatic:* Best match (Auto-Blend)
  - *Global:* ECMWF IFS 0.25° / AIFS (AI), GFS Seamless / Global / GraphCast (AI), ICON Seamless / Global, GEM, Météo-France / ARPEGE World, UKMO, JMA, KMA, CMA, BOM
  - *Europa regional:* ICON-D2 2 km, ICON-EU 7 km, ARPEGE Europe, AROME France 1.3 km / HD, UKMO UKV 2 km, KNMI & DMI HARMONIE, MET Norway Nordic 1 km, ICON-2I Italien
  - *Regional übrige:* HRRR 3 km, NBM CONUS, GEM Regional / HRDPS, JMA MSM
- **Robustheit:** Deckt ein Regionalmodell Ort/Zeitraum nicht ab oder schlägt die Abfrage fehl, fällt die App automatisch auf *Best match* zurück (Hinweis im Ergebnis). Fehlende Druckflächen einzelner Modelle werden übersprungen und interpoliert.

### Karte
- Leaflet-Vollbildkarte; Start zentriert auf die Geräteposition (Geolokation, Zoom 12 ≈ 20 km), Fallback Zürich.
- **Basiskarten** (Radio-Control oben rechts): Streets (OSM), Terrain (OpenTopoMap), Satellite (Esri), Light (Carto).
- **Signaturen:** Ballon (Start, grün), Explosionsstern (Burst, amber/rot), Fallschirm mit Sonde (Landung, rot), Fadenkreuz (Wunschlandepunkt, violett), Positionspunkt (Gerät, teal). Trajektorie als Teal-Linie mit dunkler Unterlage (auf jeder Basiskarte lesbar).
- Klick auf Start-/Burst-/Landesymbol zoomt maximal auf den Punkt (flyTo, Zoom ≥ 15).
- Nach jeder Berechnung wird der Ausschnitt automatisch so gewählt, dass der ganze Flugpfad sichtbar ist — unter Berücksichtigung der geöffneten Seitenspalten.
- Zoombuttons und Cockpit-Maßstabsleiste (Segmente, Distanz, ≈ 1:x) unten rechts; sie weichen animiert nach links aus, wenn die Ergebnisspalte offen ist. Versionsbadge unten links.

### Oberfläche
- **Kopfzeile:** ☰-Menü, Titel, Forward/Backward-Umschalter, Wettermodell-Chip, Legende, zweizeiliger Status-Chip, 📊 Ergebnisse, ◐ Tag/Nacht-Theme, Wicki-Partners-Logo.
- **Spalte 1 · Parameters (links, grüner Handle):** max. 27 % der Fensterbreite; Cards 01 Payload (SparvEmbedded S2 9 g), 02 Balloon (Presets in localStorage mit Inline-Editor), 03 Fill gas (Ballongas Linde 0,90 kg/m³, Helium, H₂, Custom), 04 Site & time (Ortssuche via Open-Meteo-Geocoding, Lat/Lon, UTC-Zeit), 05 Flight profile (Zielhöhe, Steigrate 1–4 m/s, Sinkrate), Calculate.
- **Spalte 2 · Resulting flight data (rechts, amber Handle):** Exporte (JSON, Print, Share-Link mit allen Parametern in der URL, PNG-Bild), Datengrid — jede Größe mit expliziter Einheit (hPa, g, m³, m, m AMSL, km, h min) — und das Profil-Diagramm.
- **Profil-Diagramm (2 Panels, gemeinsame Zeitachse):** oben das Höhenprofil, segmentweise nach Horizontalgeschwindigkeit eingefärbt (blau < 15, grün 15–30, amber 30–45, rot > 45 km/h); darunter die Groundspeed-Kurve in km/h mit markiertem Maximum; gestrichelte Burst-Linie durch beide Panels; Farblegende.
- Beide Spalten sind über die beschrifteten seitlichen Handles (1 Parameters / 2 Resulting flight data) jederzeit ein- und ausklappbar; Cards einzeln kollabierbar.

### Desktop & iPad (PWA)
- Vollbild-Layout (100 dvh, Safe-Area-Insets), Touch-Ziele in Cockpit-Größe, Apple-Web-App-Metatags: über Safari → Teilen → „Zum Home-Bildschirm" läuft die App randlos wie eine native App; `apple-touch-icon.png` liefert die Kachel (Icon „4b": Teal, Flugbogen mit Burst und Fallschirm).
- Keine `prompt()/alert()/confirm()`-Dialoge (in iOS-Standalone-Apps deaktiviert) — alles über Inline-UI.
- **Fehlerdiagnose ohne Konsole:** Laufzeit- und Ressourcen-Ladefehler erscheinen als roter Banner (Reporter sitzt im `<head>`, greift also auch, wenn app.js selbst nicht lädt). Mit `?debug` an der URL öffnet sich eine On-Screen-Konsole (Eruda).

---

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Markup, PWA-Metatags, Favicon (SVG-Data-URI), Fehler-Reporter, CDN-Einbindung (Leaflet, html2canvas via jsdelivr) |
| `style.css` | Komplettes Styling; Designsystem/Farbvariablen aus der Gasballoon-Cockpit-App, Tagmodus über `body.day` |
| `app.js` | Physikmodell, Open-Meteo-Anbindung, Karte, Trajektorien-Rendering, UI-Logik; `APP_VERSION` ganz oben |
| `apple-touch-icon.png` | 180×180-Kachel für den iOS-Home-Bildschirm |
| `icon-4b.svg` | Quell-SVG des App-Icons |

## Deployment (GitHub Pages)

1. Die vier App-Dateien per Drag & Drop auf `github.com/bwicki/s2_flightplanning` → *Add file → Upload files* auf `main` committen.
2. GitHub Pages ist auf *main / root* eingestellt; die Seite ist nach ~1 Minute unter https://bwicki.github.io/s2_flightplanning/ aktuell.
3. Browser mit Hard-Reload laden (Ctrl/Cmd+Shift+R). Die Query-Parameter `?v=N` an CSS/JS in `index.html` dienen als Cache-Buster und werden bei jedem Release hochgezählt; `APP_VERSION` in `app.js` (Badge unten links auf der Karte) muss dazu passen.

## Grenzen des Modells

Alle Ergebnisse sind Planungsnäherungen: Berstdurchmesser aus einem Pauschalfit (Herstellerstreuung erheblich), konstante Ziel-Steigrate statt thermischer Effekte, Windfeld zeitlich auf die nächstliegende Modellstunde gerastert, keine Berücksichtigung von Vereisung, Superpressure oder Ballonpendeln. Vor jedem realen Start Herstellerdatenblatt, NOTAM und Luftraumstruktur prüfen.
