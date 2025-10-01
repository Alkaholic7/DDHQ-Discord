# Use Node 20 LTS
FROM node:20-alpine

# Create app dir
WORKDIR /usr/src/app

# Install deps
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY README.md ./README.md

# Environment
ENV NODE_ENV=production

# Start the bot
CMD ["node", "src/bot.js"]


