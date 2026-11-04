# PersonalBot PWA

Mobile-first Armenian PWA prototype.

## Current scope
- Responsive dashboard and navigation
- Quick task creation, completion and deletion
- Task data saved locally in the current browser using localStorage
- Installable PWA shell and service worker cache

## Important limitations
This prototype is not yet connected to the PersonalBot Python backend or Supabase. Tasks created here stay in this browser/device and do not sync with Telegram. Projects, goals, habits, family and reports are interface placeholders. Do not enter sensitive information.

## Run locally
Serve this directory over HTTP (for example, python -m http.server 8000) and open http://localhost:8000.

## Deploy
Enable GitHub Pages for the main branch, root folder. HTTPS is required for service workers and PWA installation.


## Deployment
Hosted with GitHub Pages using the GitHub Actions workflow.
