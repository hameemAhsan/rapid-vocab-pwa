# Rapid Vocab PWA

A static, offline-first vocabulary review PWA.

## What it does

- Upload CSV words locally
- Stores words in IndexedDB on the device
- Shows one word at a time
- Reveals English meaning, Bangla meaning, and sentence
- Uses Again / Hard / Good / Easy rating buttons
- Repeats cards based on rating
- Has a searchable wordlist
- Exports/imports JSON backups
- Installs as a PWA when served over HTTPS or localhost

## CSV format

```csv
word,englishMeaning,banglaMeaning,sentence
relapse,to fall back into a bad condition,পুনরায় খারাপ অবস্থায় ফিরে যাওয়া,After improving for weeks he had a relapse.
```

## Running locally

Because service workers need a server, do not open index.html directly. Use any static server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Deploying

Upload all files to GitHub Pages, Netlify, Vercel, or any static hosting provider. Keep the files in the same structure.

## Important local-storage note

Words are stored on the current browser/device. Use Export Backup regularly if you do not want to lose progress after clearing browser data.
