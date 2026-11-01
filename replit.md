# Telegram OTP Bot

Telegram bot with the original user/admin chat flows, number and OTP handling, referrals, wallet/key controls, and Firebase-backed device feeds. No web dashboard is part of this runtime.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — start the bot and its required device/SMS receiver.
- `pnpm --filter @workspace/api-server run typecheck` — check the bot service.
- `pnpm --filter @workspace/db run push` — apply the bot's development database schema.

## Configuration

- `TELEGRAM_BOT_TOKEN` — add through Replit Secrets.
- `DATABASE_URL` — provided by the project's PostgreSQL database.

The small `/api/device/*` and `/api/sms/new` endpoints are retained because the original Android/device and OTP flows depend on them. `/api/healthz` is used for service health checks. No browser dashboard or admin REST panel is started.

## Key files

- `artifacts/api-server/src/bot/index.ts` — bot commands, inline menus, and callbacks.
- `artifacts/api-server/src/firebase/` — Firebase and ZXKAI device/message listeners.
- `lib/db/src/schema/` — persistence for bot users, access, numbers, plans, messages, and settings.
