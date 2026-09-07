# Sharing the Dashboard

## Live URL (share this with colleagues)

```
https://karthiviper000.github.io/pmsg-india-solar/
```

This URL is public, requires no login, and updates automatically every hour.

## What colleagues see

- **All India tab** — combined TN + Kerala, 53 districts, 1,500+ vendors
- **Tamil Nadu / Kerala tabs** — per-state view
- **District meters** — installations ranked, click any for vendor list
- **Top 3 per district** — with KONDAAS AUTOMATION highlighted in gold
- **Live solar irradiance** — from Open Meteo, refreshes on every page load
- **Comparison tray** — pin up to 4 districts to compare side-by-side

## Run it locally (for a colleague who wants their own copy)

Requirements: **Node.js 22+** (check with `node -v`)

```bash
# 1. Download and extract
unzip pmsg-india-solar.zip
cd pmsg-india-solar

# 2. Place the harvest files in the same folder (get from the original person)
#    pmsg-tn-38districts.json
#    pmsg-kl-14districts.json

# 3. Run
node start.js
# Opens at http://localhost:8787
```

## Email template to share

---
Subject: PM Surya Ghar Solar Vendor Dashboard — Live Link

Hi [Name],

Here's the live rooftop solar vendor dashboard I built from the PM Surya Ghar portal:

👉 https://karthiviper000.github.io/pmsg-india-solar/

**What it shows:**
- Registered vendor data for Tamil Nadu (38 districts) and Kerala (14 districts)
- 1,500+ unique vendors with installation counts, capacity (kW) and ratings
- District-by-district comparison — click any district for the full vendor list
- Top 3 installers per district with KONDAAS AUTOMATION highlighted
- Live solar irradiance data (Open Meteo) showing opportunity vs adoption per district
- Hourly auto-refresh — data updates automatically from the portal

**To view:** just open the link in any browser. No login needed.

Let me know if you'd like a specific state added.

---

## Fix if updates stopped

GitHub disables scheduled workflows after 60 days of repo inactivity.
The updated workflow now prevents this automatically (monthly keepalive commit).

To manually re-enable if it stops:
1. Go to github.com/karthiviper000/pmsg-india-solar/actions
2. Click "Hourly harvest" → "Enable workflow" if it shows as disabled
3. Click "Run workflow" to trigger immediately

