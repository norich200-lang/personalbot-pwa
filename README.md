# PersonalBot PWA

Mobile-first Armenian PWA for tasks shared with `@GrishaLifeManagerBot` through the existing `personal_bot.tasks` table in the `personal-management-bot-test` Supabase project.

## Task integration

- Email/password sign-in uses Supabase Auth.
- A signed-in user requests a short-lived, one-use linking code and sends `/link CODE` to the Telegram bot.
- The Edge Function validates Telegram webhook requests and handles `/tasks`, `/add`, `/done`, and `/delete`.
- The PWA reads and writes tasks through the `personalbot_api` Edge Function. It never receives a service-role or secret key.
- Telegram and PWA changes use the same task rows. The PWA refreshes every 12 seconds while open.
- Deleting a task archives it; it does not remove the database row.
- Existing browser tasks stay in local storage until the user chooses to import them. The import is idempotent and keeps a local backup.

## Deployment setup

1. Apply `supabase/migrations/20261105000000_personalbot_web_integration.sql` to `personal-management-bot-test`.
2. Deploy `supabase/functions/personalbot-api/index.ts` and include its `deno.json`. Keep platform JWT verification disabled for the function: the PWA's user token and Telegram's webhook secret are checked inside the handler.
3. In Supabase Auth URL settings, set the Site URL to `https://norich200-lang.github.io/personalbot-pwa/` and allow that URL as a redirect.
4. In Supabase Edge Function Secrets, set `BOT_TOKEN` to the token for `@GrishaLifeManagerBot`, and `TELEGRAM_WEBHOOK_SECRET` to a random 32-character value containing letters, numbers, `_` or `-`. Do not add either value to this repository.
5. Set the Telegram webhook URL to `https://evxfkpcxpsxuuglkmphy.supabase.co/functions/v1/personalbot-api/telegram-webhook` and use the same `TELEGRAM_WEBHOOK_SECRET` as Telegram's webhook secret token. This switches the bot from its prior polling/webhook handler to this task-focused integration.
6. Publish the PWA with GitHub Pages using the existing Actions workflow.

## Local preview

Serve the repository over HTTP (for example, `python -m http.server 8000`) and open `http://localhost:8000`. For local Auth redirect testing, allow the local URL in Supabase Auth settings.

## Data safety

The migration adds only private account-link, one-time-code, and webhook-deduplication tables plus a restricted RPC function. It does not delete or rewrite existing tasks. `personal_bot` tables remain private; browser requests are authenticated through Supabase Auth and all task access is scoped to the linked owner.

