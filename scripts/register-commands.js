import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;
  if (!token || !clientId || !guildId) {
    console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
    process.exit(1);
  }

  const commands = [
    new SlashCommandBuilder().setName('start-quiz').setDescription('Start the Da Daqg HQ character quiz'),
    new SlashCommandBuilder().setName('post-quiz').setDescription('Post the Start Quiz button here (or in fallback channel)'),
    new SlashCommandBuilder()
      .setName('check-perms')
      .setDescription('Check my permissions in a channel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to check').setRequired(false))
    ,
    new SlashCommandBuilder().setName('ping').setDescription('Health check'),
    new SlashCommandBuilder().setName('health').setDescription('Bot health and uptime')
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('Registered guild slash commands for', guildId);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});



