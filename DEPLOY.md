# Zen Journal — Deployment Guide

## Files in this package

```
index.html       ← Main app (single file)
sw.js            ← Service worker (offline + PWA)
manifest.json    ← PWA manifest (install to home screen)
schema.sql       ← Supabase database schema (run once in SQL Editor)
icons/           ← App icons (you must create these — see below)
```

---

## Step 1 — Create icons folder

You need an `icons/` folder with these files:

| File                  | Size     | Purpose                        |
|-----------------------|----------|--------------------------------|
| `favicon.ico`         | 32×32    | Browser tab                    |
| `icon-16.png`         | 16×16    | Browser tab (PNG)              |
| `icon-32.png`         | 32×32    | Browser tab (PNG)              |
| `icon-144.png`        | 144×144  | Windows tile                   |
| `icon-192.png`        | 192×192  | Android home screen / PWA      |
| `icon-512.png`        | 512×512  | PWA splash + install prompt    |
| `apple-touch-icon.png`| 180×180  | iOS home screen                |

**Quick way:** Use [favicon.io](https://favicon.io) or [realfavicongenerator.net](https://realfavicongenerator.net) to generate all sizes from one image. Use the letter **Z** or your logo.

---

## Step 2 — Set up Supabase

1. Go to [supabase.com](https://supabase.com) → New project
2. Copy your **Project URL** and **anon public key** from:
   - Dashboard → Settings → API
3. In `index.html`, find these two lines near the top of the `<script>` block and replace the values:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

4. In Supabase Dashboard → **SQL Editor** → New Query:
   - Paste the entire contents of `schema.sql`
   - Click **Run**
   - You should see: `zen_entries | t` (RLS enabled)

5. In Supabase Dashboard → **Authentication** → Settings:
   - Enable **Email** provider
   - Set **Site URL** to your deployed domain (e.g. `https://yourapp.com`)
   - Optionally: disable email confirmation for faster dev (`Auth → Settings → Email Confirmations → OFF`)

---

## Step 3 — Deploy

### Option A: Static host (recommended)

Any static host works. Simplest options:

**Netlify (drag & drop)**
1. Go to [netlify.com](https://netlify.com)
2. Drag your entire folder (with `index.html`, `sw.js`, `manifest.json`, `icons/`) into the deploy area
3. Done — you get a live HTTPS URL instantly

**Vercel**
```bash
npm i -g vercel
vercel --prod
```

**GitHub Pages**
1. Push files to a GitHub repo
2. Settings → Pages → Source: main branch / root
3. Your app is live at `https://USERNAME.github.io/REPO`

### Option B: Self-hosted (nginx)

```nginx
server {
  listen 443 ssl;
  server_name yourapp.com;

  root /var/www/zen-journal;
  index index.html;

  # Required for PWA service worker scope
  location /sw.js {
    add_header Cache-Control "no-cache";
    add_header Service-Worker-Allowed "/";
  }

  # Long cache for icons
  location /icons/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

---

## Step 4 — Verify PWA install

After deploying with HTTPS:
1. Open in Chrome on Android or Safari on iOS
2. You should see the **"Add to Home Screen"** banner after ~3 seconds
3. On desktop Chrome: look for the install icon in the address bar

**Checklist for PWA install to work:**
- ✅ Served over HTTPS
- ✅ `manifest.json` linked in `<head>`
- ✅ `sw.js` registered and active
- ✅ `icon-192.png` and `icon-512.png` exist
- ✅ `start_url` in manifest resolves correctly

---

## Local development

```bash
# Python (no install needed)
python3 -m http.server 8080

# Node
npx serve .

# Then open: http://localhost:8080
```

> **Note:** Service workers require HTTPS in production. On `localhost` they work fine for testing.

---

## Folder structure

```
zen-journal/
├── index.html
├── sw.js
├── manifest.json
├── schema.sql       ← not deployed, Supabase only
└── icons/
    ├── favicon.ico
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-144.png
    ├── icon-192.png
    ├── icon-512.png
    └── apple-touch-icon.png
```

---

## What was fixed in this version

| # | Issue | Fix |
|---|-------|-----|
| 1 | Templates panel never opened | Changed from `opacity:0` → `display:none` (reliable show/hide) |
| 2 | Two `<script>` blocks | Merged into one — prevents silent load failures |
| 3 | `tabOpenTemplates()` defined after panel HTML | Moved into first script block |
| 4 | Templates z-index (260) below tab bar (400) | Raised to 450 |
| 5 | Completion overlay invisible | Fixed `opacity:0` → `display:none` |
| 6 | Abandon confirm invisible | Fixed `opacity:0` → `display:none` |
| 7 | `.hidden` class used opacity | Changed to `display:none !important` |
| 8 | Wrong CSS class in mobile media query | `tpl-list-item-label` → `tpl-list-label` |
| 9 | PWA status bar style | Changed to `black-translucent` for edge-to-edge |
| 10 | Missing `icon-512` link in `<head>` | Added for PWA install eligibility |
| 11 | App blocked if Supabase not configured | Added local-only mode bypass |
| 12 | No SW / manifest files | Created `sw.js` and `manifest.json` |
| 13 | No database schema | Created `schema.sql` with RLS, indexes, triggers |
