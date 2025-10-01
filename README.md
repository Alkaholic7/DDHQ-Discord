# DDHQ Discord

## Environment
Create a `.env` with:
```
DISCORD_TOKEN=your_token
CLIENT_ID=your_application_id
GUILD_ID=your_guild_id
QUIZ_CHANNEL_ID=quiz_channel_id
ALERT_CHANNEL_ID=monitor_channel_id
NODE_ENV=production
```

## Local (Windows) with PM2
```
npm i -g pm2 pm2-windows-startup
pm2 start src/bot.js --name DaSurvey --time --update-env --cwd "%cd%"
pm2 save
pm2-startup install
```

## Render Deployment (recommended)
- This repo includes `Dockerfile`, `.dockerignore`, and `render.yaml`.
- Connect the repo in Render → Blueprint Deploy.
- Set environment variables: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `QUIZ_CHANNEL_ID`, `ALERT_CHANNEL_ID`.
- Render will build and run the bot as a worker with a persistent `/usr/src/app/data` disk.

## Slash Commands
- Register guild commands: `node scripts/register-commands.js`
- Available: `/post-quiz`, `/start-quiz`, `/check-perms`, `/ping`, `/health`.

