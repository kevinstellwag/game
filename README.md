# 🎮 PartyGames — Complete Setup Gids

> Cards Against Humanity • Poker • Monopoly  
> Multiplayer via kamer-code, live chat, werkt op telefoon & computer

---

## Wat heb je nodig?

- Een **GitHub account** (gratis) → github.com
- Een **Render account** (gratis) → render.com
- **GitHub Desktop** (makkelijkste manier om code te uploaden) → desktop.github.com
- **Node.js** (alleen nodig als je lokaal wilt testen) → nodejs.org

---

## STAP 1 — Bestanden op je computer zetten

1. Download de **partygames.zip** en pak hem uit
2. Je hebt nu een map genaamd `partygames` met deze structuur:
```
partygames/
├── server/
│   └── index.js
├── public/
│   ├── index.html
│   ├── css/main.css
│   └── js/
│       ├── app.js
│       ├── cah.js
│       ├── poker.js
│       └── monopoly.js
├── package.json
├── render.yaml
└── .gitignore
```
3. Zet deze map ergens makkelijk terug te vinden, bijv. `Documenten/partygames`

---

## STAP 2 — GitHub instellen

GitHub is de plek waar je code online wordt opgeslagen. Render haalt de code daar vandaan.

### 2a. Account aanmaken
1. Ga naar **https://github.com**
2. Klik op **Sign up**
3. Maak een gratis account (kies de gratis Free tier)

### 2b. GitHub Desktop installeren
1. Ga naar **https://desktop.github.com**
2. Download en installeer het programma
3. Open GitHub Desktop en log in met je GitHub account

### 2c. Repository aanmaken op GitHub.com
1. Ga naar **https://github.com** en log in
2. Klik op de **+** knop rechtsboven → **New repository**
3. Vul in:
   - **Repository name:** `partygames`
   - **Description:** Party games platform (optioneel)
   - Zet op **Public** ← belangrijk!
   - Vink NIETS aan bij "Initialize this repository"
4. Klik op **Create repository**
5. Laat deze pagina open, je hebt hem zo nodig

### 2d. Je bestanden uploaden via GitHub Desktop
1. Open **GitHub Desktop**
2. Klik op **File** → **Add Local Repository**
3. Klik op **Choose...** en selecteer je `partygames` map
4. Als hij zegt "This directory does not appear to be a Git repository" → klik op **create a repository here**
5. Klik dan **Initialize Repository**
6. Je ziet nu al je bestanden in de linkerkolom
7. Vul bij **Summary** in: `eerste versie`
8. Klik op **Commit to main**
9. Klik bovenaan op **Publish repository**
10. Zorg dat **"Keep this code private"** UITGEVINKT is
11. Klik op **Publish Repository**

✅ Je code staat nu op GitHub!

---

## STAP 3 — Render instellen

Render host je app gratis op het internet. WebSockets werken hier goed.

### 3a. Account aanmaken
1. Ga naar **https://render.com**
2. Klik op **Get Started for Free**
3. Klik op **Continue with GitHub** — log in met je GitHub account
4. Geef Render toegang tot je GitHub (klik op **Authorize Render**)

### 3b. Nieuwe Web Service aanmaken
1. Je bent nu in het Render dashboard
2. Klik op **New +** (grote knop rechtsboven of midden op de pagina)
3. Klik op **Web Service**
4. Bij "Connect a repository" zie je je GitHub repos
5. Klik op **Connect** naast `partygames`

### 3c. Instellingen invullen
Je ziet nu een formulier. Vul dit in:

| Veld | Waarde |
|------|--------|
| **Name** | `partygames` (of wat je wilt) |
| **Region** | Frankfurt (EU) — dichtstbij NL |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server/index.js` |
| **Instance Type** | `Free` |

6. Scroll naar beneden en klik op **Create Web Service**

### 3d. Wachten op deploy
- Render gaat nu je app bouwen. Dit duurt **2-5 minuten**
- Je ziet een log met regels zoals `npm install`, `node server/index.js`
- Als je onderin ziet: `🎮 PartyGames running on port ...` → het werkt!
- Render geeft je een URL zoals: `https://partygames-xxxx.onrender.com`

**⚠️ Gratis tier waarschuwing:** Bij Render Free "slaapt" de app na 15 minuten zonder gebruik. De eerste bezoeker wacht dan ~30 seconden tot de app wakker is. Daarna werkt alles normaal snel.

---

## STAP 4 — Testen

1. Ga naar je Render URL (bijv. `https://partygames-xxxx.onrender.com`)
2. Klik op **Kamer Aanmaken**
3. Vul je naam in, kies een spel, klik **Aanmaken!**
4. Je ziet nu een 6-letter code (bijv. `XK7P2Q`)
5. Open een tweede tabblad (of stuur de link naar een vriend)
6. Klik op **Kamer Joinen**, vul naam + code in
7. Als host: ga naar de Lobby en klik **🚀 Start Spel!**

---

## STAP 5 — Updates doorvoeren

Als je iets wilt aanpassen (nieuwe kaarten toevoegen, kleuren veranderen, etc.):

1. Pas de bestanden aan op je computer
2. Open **GitHub Desktop**
3. Je ziet je wijzigingen in de linkerlijst
4. Vul een korte beschrijving in bij **Summary** (bijv. "nieuwe kaarten toegevoegd")
5. Klik **Commit to main**
6. Klik **Push origin**
7. Render ziet de update automatisch en herdeployt binnen 2-3 minuten

---

## Eigen kaarten toevoegen (Cards Against Humanity)

### Via het spel zelf (makkelijkst):
1. Maak een kamer aan als host
2. Ga naar de **Lobby**
3. Bij "Eigen Zwarte Kaart" — typ een vraag met `___` voor het blanco
   - Voorbeeld: `Mijn oma heeft mij ___ nagelaten.`
4. Bij "Eigen Witte Kaart" — typ een antwoord
   - Voorbeeld: `Een verwarrende taxaangifte`
5. Klik op de + knop om toe te voegen
6. Deze kaarten gelden alleen voor deze sessie

### Permanent toevoegen (in de code):
Open `server/index.js` en zoek naar:
```javascript
const BLACK = [
  "What's the next Happy Meal toy?",
  ...
```
Voeg hier je eigen zwarte kaarten toe. En bij `const WHITE = [` voeg je witte kaarten toe.

Daarna: commit & push via GitHub Desktop → Render herdeployt automatisch.

---

## Spellen uitleggen

### 🃏 Cards Against Humanity
- Één speler is de **Kaart Tsaar** per ronde (roteert automatisch)
- De Tsaar leest de zwarte kaart voor (met een blanco erin)
- Iedereen anders kiest hun grappigste witte kaart
- De Tsaar kiest de winnaar van die ronde
- Eerste naar **7 punten** wint (host kan dit aanpassen in de lobby)

### ♠️ Poker (Texas Hold'em)
- Iedereen start met **$1.000**
- Small blind: $10, Big blind: $20
- Acties: Passen / Check / Callen / Raisen
- Community kaarten: Flop (3) → Turn (1) → River (1) → Showdown
- Winnaar krijgt de pot

### 🏦 Monopoly
- Iedereen start met **€1.500**
- Gooi dobbelstenen, beweeg over het bord
- Land op onbezette straat → optie om te kopen
- Land op andermans straat → betaal huur
- Passeer GO → ontvang €200
- Naar de gevangenis → moet dubbel gooien om vrij te komen
- Failliet (€0) → uit het spel

---

## Veelgestelde vragen

**De app laadt heel langzaam de eerste keer?**  
Dat is normaal bij de gratis Render tier. De app "slaapt" na 15 min inactiviteit. Eerste bezoeker wacht ~30 sec. Daarna snel.

**Kan ik de app altijd online houden?**  
Ja, upgrade naar Render's Starter plan ($7/maand). Of gebruik een gratis uptime-service zoals UptimeRobot om de app elke 14 minuten te pingen.

**Ik zie "Disconnected" na een tijdje?**  
Ververs de pagina. De keepalive pings zorgen dat dit tijdens het spelen niet gebeurt, maar als je lang op de lobby-pagina wacht zonder actie kan de browser de verbinding sluiten.

**Kan ik de kleuren/look aanpassen?**  
Ja! Open `public/css/main.css` en zoek bovenaan naar `:root {`. Daar staan alle kleurvariabelen die je kunt aanpassen.

**Hoeveel spelers kunnen er meedoen?**  
Technisch gezien onbeperkt, maar voor de spelletjes is het optimaal:
- CAH: 3-10 spelers
- Poker: 2-8 spelers  
- Monopoly: 2-6 spelers

---

## Hulp nodig?

Als er iets niet werkt:
1. Kijk in Render → je service → **Logs** tab voor foutmeldingen
2. In de browser: druk F12 → **Console** tab voor JavaScript fouten
3. Ververs de pagina en probeer opnieuw
