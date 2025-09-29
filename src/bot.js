import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, Events, SlashCommandBuilder, Routes, REST, PermissionFlagsBits } from 'discord.js';
import { getDb, upsertUserProgress, saveAnswer, getAnswers } from './db/index.js';
import { loadQuiz, loadCharacters, scoreAnswers } from './utils/scoring.js';
import fs from 'fs';
import path from 'path';

const QUIZ = (() => { try { return loadQuiz(); } catch { return { questions: [] }; } })();
const CHARACTERS = (() => { try { return loadCharacters(); } catch { return { characters: [] }; } })();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const db = getDb();

client.once(Events.ClientReady, c => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.on(Events.GuildMemberAdd, async member => {
  if (process.env.AUTO_WELCOME !== 'true') return;
  const channelId = process.env.QUIZ_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = member.guild.channels.cache.get(channelId) || await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const welcome = process.env.WELCOME_MESSAGE || 'Welcome! Take the quiz to get your role.';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('quiz:start').setLabel('Start Character Quiz').setStyle(ButtonStyle.Primary)
    );
    await channel.send({ content: `${member}`, embeds: [new EmbedBuilder().setTitle('Da Dawg HQ Quiz').setDescription(welcome)], components: [row] }).catch(() => {});
  } catch {
    // Missing access or other error; ignore to avoid crashing the bot
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'start-quiz') {
        await startQuiz(interaction);
      } else if (interaction.commandName === 'post-quiz') {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({ ephemeral: true, content: 'You need Manage Guild or Manage Channels permission to use this.' });
          return;
        }
        const welcome = process.env.WELCOME_MESSAGE || 'Welcome! Take the quiz to get your role.';
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('quiz:start').setLabel('Start Character Quiz').setStyle(ButtonStyle.Primary)
        );

        // Try to send in current channel if bot has permission; else fallback to QUIZ_CHANNEL_ID
        const me = await interaction.guild.members.fetch(client.user.id);
        const canSendHere = interaction.channel?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
        if (canSendHere) {
          // Avoid duplicate start buttons: if one already exists from the bot in the last 50 messages, reuse it
          const recent = await interaction.channel.messages.fetch({ limit: 50 }).catch(() => null);
          const existing = recent?.find(m => m.author.id === client.user.id && m.components?.some(r => r.components?.some(c => c.customId === 'quiz:start')));
          if (existing) {
            await interaction.reply({ ephemeral: true, content: 'Start button is already posted here.' });
          } else {
            await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle('Da Dawg HQ Quiz').setDescription(welcome)], components: [row] });
            await interaction.reply({ ephemeral: true, content: 'Posted the Start Quiz button here.' });
          }
        } else {
          const fallbackId = process.env.QUIZ_CHANNEL_ID;
          if (!fallbackId) {
            await interaction.reply({ ephemeral: true, content: 'I lack Send Messages in this channel. Grant permission or set QUIZ_CHANNEL_ID in .env for fallback.' });
            return;
          }
          const fallback = interaction.guild.channels.cache.get(fallbackId) || await interaction.guild.channels.fetch(fallbackId).catch(() => null);
          const canSendFallback = fallback?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
          if (fallback && canSendFallback) {
            await fallback.send({ embeds: [new EmbedBuilder().setTitle('Da Dawg HQ Quiz').setDescription(welcome)], components: [row] });
            await interaction.reply({ ephemeral: true, content: 'I posted the Start Quiz button in the configured quiz channel instead (missing Send Messages here).' });
          } else {
            await interaction.reply({ ephemeral: true, content: 'I cannot send messages here or in QUIZ_CHANNEL_ID. Please grant Send Messages to my role.' });
          }
        }
      } else if (interaction.commandName === 'check-perms') {
        const target = interaction.options.getChannel('channel') ?? interaction.channel;
        const me = await interaction.guild.members.fetch(client.user.id);
        const perms = target.permissionsFor(me);
        const checks = [
          'ViewChannel',
          'SendMessages',
          'EmbedLinks',
          'ReadMessageHistory',
          'UseExternalEmojis',
          'AddReactions',
          'ManageMessages',
          'ManageRoles'
        ].map(name => ({ name, allowed: perms?.has(PermissionFlagsBits[name]) || false }));
        const lines = checks.map(c => `${c.allowed ? '✅' : '❌'} ${c.name}`).join('\n');
        await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('Permission Check').setDescription(`Channel: ${target}
${lines}`)] });
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'quiz:start') {
        // Start quiz with a single ephemeral message
        try { if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }); } catch {}
        await renderQuestion(interaction, 0, true);
      } else if (interaction.customId.startsWith('quiz:next:')) {
        const index = Number(interaction.customId.split(':')[2]);
        await renderQuestion(interaction, index, false);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('quiz:q:')) {
        const index = Number(interaction.customId.split(':')[2]);
        const opt = interaction.values[0];
        saveAnswer(db, interaction.user.id, index, opt);
        if (index + 1 < QUIZ.questions.length) {
          await renderQuestion(interaction, index + 1, false);
        } else {
          await finalizeQuiz(interaction);
        }
      }
    }
  } catch (err) {
    // Log for diagnostics
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ ephemeral: true, content: 'Something went wrong. Please try again.' }).catch(() => {});
    }
  }
});

async function startQuiz(interaction) {
  upsertUserProgress(db, interaction.user.id, { started_at: Date.now() });
  if (QUIZ.questions.length === 0) {
    await interaction.reply({ ephemeral: true, content: 'Quiz not configured yet. Add src/config/quiz.json.' });
    return;
  }
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
  } catch {}
  await renderQuestion(interaction, 0, true);
}

function buildQuestionEmbedAndMenu(index) {
  const q = QUIZ.questions[index];
  if (!q) return;
  // Load GIF for this question
  let imageUrl = undefined;
  try {
    const mediaPath = path.join(process.cwd(), 'src', 'config', 'quiz_media.json');
    if (fs.existsSync(mediaPath)) {
      const media = JSON.parse(fs.readFileSync(mediaPath, 'utf-8'));
      imageUrl = media.questionGifs?.[index];
    }
  } catch {}
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`quiz:q:${index}`)
    .setPlaceholder('Choose your answer')
    .addOptions(
      q.options.slice(0, 25).map(o => ({ label: `${o.key}) ${String(o.label).replace(/[•●]/g,'').slice(0, 100)}`, value: o.key, description: String(o.label).replace(/[•●]/g,'').slice(0, 100) }))
    );
  const row = new ActionRowBuilder().addComponents(menu);
  // Build embed with bold prompt only; answers are in the dropdown menu
  const embed = new EmbedBuilder()
    .setTitle(`Da Dawg HQ Quiz — Question ${index + 1}`)
    .setDescription(`**${String(q.prompt).replace(/[•●]/g,'').slice(0, 2000)}**`);
  if (imageUrl) embed.setImage(imageUrl);
  return { embeds: [embed], components: [row] };
}

async function renderQuestion(interaction, index, first) {
  const payload = buildQuestionEmbedAndMenu(index);
  if (!payload) return;
  if (interaction.isAnySelectMenu() || interaction.isButton()) {
    // Update the same ephemeral message for components
    await interaction.update(payload).catch(async () => {
      try { await interaction.editReply?.(payload); } catch {}
    });
  } else {
    // Slash command path: edit the deferred reply
    if (first) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.editReply(payload).catch(() => {});
    }
  }
}

async function finalizeQuiz(interaction) {
  const answers = getAnswers(db, interaction.user.id);
  const { topCharacterId, tally } = scoreAnswers(answers);
  const roleMap = new Map(CHARACTERS.map(c => [c.id, c.roleId]));
  const nameMap = new Map(CHARACTERS.map(c => [c.id, c.name]));

  let assignedRoleId = roleMap.get(topCharacterId);
  const guild = interaction.guild ?? (await client.guilds.fetch(interaction.guildId));
  const member = await guild.members.fetch(interaction.user.id);

  // Only remove other character roles if explicitly enabled
  if (process.env.ROLE_REMOVAL_BEFORE_ASSIGN === 'true') {
    for (const id of roleMap.values()) {
      if (member.roles.cache.has(id) && id !== assignedRoleId) {
        await member.roles.remove(id).catch(() => {});
      }
    }
  }
  if (assignedRoleId) {
    await member.roles.add(assignedRoleId).catch(() => {});
  }

  upsertUserProgress(db, interaction.user.id, {
    completed_at: Date.now(),
    top_character_id: topCharacterId,
    details_json: JSON.stringify({ tally })
  });

  const embed = new EmbedBuilder()
    .setTitle('Quiz Complete')
    .setDescription(`You matched: ${nameMap.get(topCharacterId) ?? 'Unknown'}`)
    .addFields({ name: 'Tally', value: Object.entries(tally).map(([k,v]) => `${nameMap.get(k) ?? k}: ${v}`).join('\n') || 'No data' });

  if (interaction.isAnySelectMenu() || interaction.isButton()) {
    await interaction.update({ embeds: [embed], components: [] }).catch(async () => {
      await interaction.followUp({ ephemeral: true, embeds: [embed] }).catch(() => {});
    });
  } else if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
  } else {
    await interaction.reply({ ephemeral: true, embeds: [embed] }).catch(() => {});
  }

  // Hide quiz channel after 60s for this member (if possible)
  try {
    const gateId = process.env.QUIZ_CHANNEL_ID;
    if (gateId && interaction.guild) {
      const channel = interaction.guild.channels.cache.get(gateId) || await interaction.guild.channels.fetch(gateId).catch(() => null);
      if (channel && channel.permissionOverwrites) {
        setTimeout(async () => {
          await channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: false }).catch(() => {});
        }, 60_000);
      }
    }
  } catch {}
}

// Optional: local register in dev if desired
async function registerCommandsDev() {
  if (!process.env.CLIENT_ID || !process.env.GUILD_ID) return;
  const commands = [
    new SlashCommandBuilder().setName('start-quiz').setDescription('Start the Da Daqg HQ character quiz')
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('Registered dev commands');
}

if (process.env.NODE_ENV === 'development') {
  registerCommandsDev().catch(console.error);
}

client.login(process.env.DISCORD_TOKEN);


