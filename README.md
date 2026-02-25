# 🎮 PartyGames - Setup Tutorial

A multiplayer party games platform with Cards Against Humanity, Poker, and Monopoly.
Join by room code, chat with friends, and destroy relationships — all in one place.

---

## 🗂️ Project Structure

```
partygames/
├── server/
│   └── index.js       ← Node.js backend (WebSocket + HTTP server)
├── public/
│   ├── index.html     ← Main HTML
│   ├── css/
│   │   └── main.css   ← All styles
│   └── js/
│       ├── app.js     ← Core app logic (rooms, chat, tabs)
│       ├── cah.js     ← Cards Against Humanity
│       ├── poker.js   ← Poker
│       └── monopoly.js← Monopoly
├── package.json
└── README.md
```

---

## ⚡ Step 1 — Install Node.js

1. Go to **https://nodejs.org**
2. Download the **LTS** version (the green button)
3. Install it (just click through the installer)
4. Open a terminal (on Windows: press `Win+R`, type `cmd`, press Enter)
5. Type `node --version` — if you see a number like `v20.x.x`, you're good!

---

## 📁 Step 2 — Set Up the Project

1. Create a folder on your computer called `partygames`
2. Put all the files from this project into that folder (keeping the structure above)
3. Open a terminal **in that folder**:
   - On Windows: hold `Shift`, right-click the folder, click "Open PowerShell window here"
   - On Mac: right-click the folder → "New Terminal at Folder"

4. Type this command and press Enter:
   ```
   npm install
   ```
   This downloads the required packages. It might take a minute.

5. Start the server:
   ```
   npm start
   ```

6. Open your browser and go to: **http://localhost:3000**

🎉 It's running! For now it only works on YOUR computer. To share with friends, continue below.

---

## 🐙 Step 3 — Put it on GitHub

GitHub is where you store your code online (for free).

1. Go to **https://github.com** and create a free account
2. Click the **+** button (top right) → **New repository**
3. Name it `partygames`
4. Leave it **Public** (required for free Vercel)
5. Click **Create repository**

Now install **GitHub Desktop** (easier than command line):
1. Go to **https://desktop.github.com** and install it
2. Sign in with your GitHub account
3. Click **File → Add Local Repository**
4. Select your `partygames` folder
5. It'll ask to initialize — click **Initialize Repository**
6. Click **Publish repository** → uncheck "Keep private" → **Publish**

Your code is now on GitHub! ✅

---

## 🚀 Step 4 — Deploy to Vercel (Make It Live!)

Vercel hosts your app for **free** so anyone on the internet can play.

1. Go to **https://vercel.com** and sign up (use "Continue with GitHub")
2. Click **Add New Project**
3. Find your `partygames` repository and click **Import**
4. **IMPORTANT SETTINGS:**
   - Framework Preset: **Other**
   - Build Command: *(leave empty)*
   - Output Directory: *(leave empty)*
   - Install Command: `npm install`
5. Click **Deploy**

Wait about 1 minute. Vercel gives you a URL like `partygames-abc123.vercel.app`.

> ⚠️ **One issue with Vercel:** Vercel is great for websites, but WebSockets (used for real-time multiplayer) have limitations on the free plan. If you run into connection issues, see the "Vercel WebSocket Fix" section below.

---

## 🔧 Vercel WebSocket Fix

If multiplayer doesn't work on Vercel, the easiest free alternative is **Railway**:

1. Go to **https://railway.app** and sign up with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `partygames` repo
4. Railway auto-detects Node.js and deploys it
5. In your project settings, set the **Start Command** to: `node server/index.js`
6. Railway gives you a URL — share that with friends!

Railway's free tier gives you 500 hours/month (plenty for playing with friends).

---

## 🎮 How to Play

### Creating a Room
1. Open the site
2. Click **Create Room**
3. Type your name
4. Pick a game
5. Click **Let's GO!**
6. Share the **6-letter room code** with friends

### Joining a Room
1. Open the site
2. Click **Join Room**
3. Type your name
4. Enter the room code
5. Click **Enter!**

---

## 🃏 Cards Against Humanity

- **Host** starts the game via Settings tab
- One player is the **Card Czar** each round (rotates)
- The Czar reads the **black card** (with a blank)
- Everyone else picks their funniest **white card**
- The Czar picks the winner — that person gets a point
- First to reach the **win goal** (default 7, adjustable) wins

**Adding Custom Cards (Host Only):**
1. Go to the ⚙️ Settings tab
2. Scroll to "Custom Cards"
3. For black cards: include `___` where the blank goes
4. Click Add

---

## ♠️ Poker

- Texas Hold'em
- Everyone starts with $1,000
- Small blind: $10, Big blind: $20
- Standard betting rounds: Pre-flop → Flop → Turn → River → Showdown
- Use the buttons to Fold / Check / Call / Raise

---

## 🏦 Monopoly

- Classic rules simplified
- Everyone starts with $1,500
- Roll dice on your turn
- Land on unowned property → option to Buy
- Land on owned property → pay Rent
- Pass GO → collect $200
- Land on Go To Jail → go to jail (need doubles to escape)

---

## ⚙️ Customizing

### Change win points for CAH:
Settings tab → "Win at X points" → change the number

### Switch games mid-session:
Settings tab → "Switch Game" → pick a new game
(Host only — all players are moved to the new game)

### Add more default cards to CAH:
Open `server/index.js` and find the `DEFAULT_BLACK_CARDS` and `DEFAULT_WHITE_CARDS` arrays near the top. Add your own strings to these arrays and restart the server.

---

## 🔄 Updating After Changes

1. Make changes to your files
2. Open GitHub Desktop
3. You'll see your changes listed
4. Type a message in the "Summary" box (e.g. "Added new cards")
5. Click **Commit to main**
6. Click **Push origin**
7. Vercel/Railway will automatically redeploy! ✅

---

## ❓ Common Issues

**"npm is not recognized"** → Node.js isn't installed or terminal needs to be restarted

**Can't connect after deploying** → Check the WebSocket section above, try Railway

**Players can't see each other** → Make sure everyone is on the same URL (not localhost)

**Game doesn't start** → You need to be the host. Check the ⚙️ Settings tab.

---

## 🎨 Changing Colors/Look

Open `public/css/main.css` and find the `:root` section at the top:
```css
:root {
  --bg: #0d0d1a;        /* main background */
  --accent: #ff6b6b;    /* red accent */
  --accent2: #ffd93d;   /* yellow accent */
  --accent3: #6bcb77;   /* green accent */
  --accent4: #4d96ff;   /* blue accent */
}
```
Change these colors to whatever you like!

---

Made with ❤️ and questionable humor. Have fun!
