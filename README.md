# 🃏 CAH Friends — Vercel + Pusher Deployment Guide

## Benodigdheden 
- GitHub account (gratis)
- Vercel account (gratis) — vercel.com
- Supabase database (jij hebt dit al)
- Pusher account (gratis) — pusher.com

---

## Stap 1 — Pusher account aanmaken

1. Ga naar **https://pusher.com** → Sign up (gratis)
2. Klik op **"Channels"** → **"Create app"**
3. Geef het een naam, bijv. `cah-friends`
4. Kies cluster: **eu** (of dichtstbijzijnde)
5. Klik **"Create app"**
6. Ga naar **"App Keys"** en noteer:
   - `app_id`
   - `key`
   - `secret`
   - `cluster`

> Gratis tier: 200 gelijktijdige verbindingen, 200.000 berichten/dag.
> Voor een groep vrienden is dit ruim voldoende.

---

## Stap 2 — Code op GitHub zetten

1. Ga naar **https://github.com** → **New repository**
2. Naam: `cah-friends`, visibility: Private
3. Klik **"Create repository"**

Upload de bestanden. De makkelijkste manier:

```bash
cd cah-vercel          # de map die je net hebt gedownload
git init
git add .
git commit -m "cah friends v1"
git branch -M main
git remote add origin https://github.com/JOUWNAAM/cah-friends.git
git push -u origin main
```

Of upload via de GitHub website: klik **"uploading an existing file"** en sleep alle bestanden erin.

**Zorg dat de structuur er zo uitziet:**
```
cah-vercel/
├── api/
│   ├── _lib.js
│   ├── register.js
│   ├── login.js
│   ├── me.js
│   ├── friends.js
│   ├── friends-action.js
│   ├── leaderboard.js
│   ├── pusher-auth.js
│   ├── session.js
│   ├── chat.js
│   ├── session/
│   │   └── [id].js
│   └── game/
│       └── [id].js
├── public/
│   ├── index.html
│   ├── css/
│   │   └── main.css
│   └── js/
│       └── app.js
├── package.json
└── vercel.json
```

---

## Stap 3 — Vercel project aanmaken

1. Ga naar **https://vercel.com** → Log in met GitHub
2. Klik **"Add New Project"**
3. Selecteer je `cah-friends` repository
4. **Framework Preset:** kies **"Other"**
5. **Root Directory:** laat leeg (of `cah-vercel` als dat de mapnaam is)
6. **Build Command:** leeg laten
7. **Output Directory:** leeg laten

---

## Stap 4 — Environment Variables instellen

In het Vercel project dashboard → **Settings → Environment Variables**

Voeg deze toe (alle drie environments: Production, Preview, Development):

| Naam | Waarde | Waar vind je dit |
|------|--------|-----------------|
| `DATABASE_URL` | `postgresql://postgres:...@db.xxx.supabase.co:5432/postgres` | Supabase → Project Settings → Database → URI |
| `JWT_SECRET` | Een zelfverzonnen lange string, bijv. `MijnCAHGeheim2025XYZ!` | Verzin zelf |
| `PUSHER_APP_ID` | bijv. `1234567` | Pusher → App Keys → app_id |
| `PUSHER_KEY` | bijv. `abc123def456` | Pusher → App Keys → key |
| `PUSHER_SECRET` | bijv. `xyz789...` | Pusher → App Keys → secret |
| `PUSHER_CLUSTER` | bijv. `eu` | Pusher → App Keys → cluster |

---

## Stap 5 — Pusher Key aan de frontend toevoegen

De frontend heeft de Pusher **public key** nodig. Dit is de enige key die veilig in de HTML mag staan (het is een publieke key).

Open `public/index.html` en voeg dit toe **net voor** `</head>`:

```html
<script>
  window.PUSHER_KEY = 'jouw_pusher_key_hier';
  window.PUSHER_CLUSTER = 'eu';
</script>
```

Commit en push deze wijziging naar GitHub → Vercel deployt automatisch.

---

## Stap 6 — Deploy!

1. Klik **"Deploy"** in Vercel
2. Wacht ~1 minuut
3. Vercel geeft je een URL zoals `https://cah-friends.vercel.app`

Deel deze URL met je vrienden!

---

## Spelen met vrienden

1. Iedereen gaat naar jouw Vercel URL
2. Iedereen maakt een eigen account aan
3. Voeg elkaar toe als vriend via het dashboard (gebruikersnaam opzoeken)
4. Iemand maakt een spel aan → ziet zijn vrienden in de lobby
5. Klik **"Uitnodigen"** naast je vrienden → zij krijgen direct een melding
6. Als iedereen in de lobby is → host klikt **"Start het spel!"**

---

## Problemen oplossen

**"Database niet beschikbaar"**
→ Controleer `DATABASE_URL` in Vercel environment variables
→ Zorg dat je **?sslmode=require** niet mist (Supabase heeft dit soms nodig)

**Pusher verbindt niet**
→ Controleer of `window.PUSHER_KEY` en `window.PUSHER_CLUSTER` correct zijn ingesteld in `index.html`
→ Controleer de Pusher App Keys in Pusher dashboard

**"Sessie niet gevonden" bij uitnodiging**
→ Zorg dat de uitnodigende persoon al een sessie heeft aangemaakt voor hij uitnodigt

**Spel start niet**
→ Minimaal 2 spelers nodig, 3+ voor het meeste lol

---

## Gratis limieten samenvatting

| Service | Gratis limiet | Genoeg voor? |
|---------|--------------|--------------|
| Vercel | Onbeperkt requests | ✅ Ja |
| Supabase | 500MB database, 2GB storage | ✅ Ja |
| Pusher | 200 gelijktijdige verbindingen, 200k berichten/dag | ✅ Ja |

Geen creditcard nodig, geen slaaptimer — alles blijft altijd aan.
