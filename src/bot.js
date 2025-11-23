import 'dotenv/config';
import dns from 'dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, Events, SlashCommandBuilder, Routes, REST, PermissionFlagsBits, AttachmentBuilder, ActivityType } from 'discord.js';
import { getDb, upsertUserProgress, saveAnswer, getAnswers, getUserProgress, getActiveStartMessageForChannel, setActiveStartMessageForChannel, clearUserData } from './db/index.js';
import { loadQuiz, loadCharacters, scoreAnswers, loadResults } from './utils/scoring.js';
import fs from 'fs';
import path from 'path';

const QUIZ = (() => { try { return loadQuiz(); } catch { return { questions: [] }; } })();
const CHARACTERS = (() => { try { return loadCharacters(); } catch { return { characters: [] }; } })();
const RESULTS = (() => { try { return loadResults(); } catch { return null; } })();

// Per-character teaser links to show in the outro
const X_TEASERS = {
  bobcat_da_hellcat: 'https://x.com/DaDawgHQ/status/1971968396473381117',
  luna_da_hellcat: 'https://x.com/DaDawgHQ/status/1971605709671264734',
  raven_da_hellcat: 'https://x.com/DaDawgHQ/status/1971245282219208846',
  bullet_da_bulldawg: 'https://x.com/DaDawgHQ/status/1970881006938001611',
  ellie_da_dawggette: 'https://x.com/DaDawgHQ/status/1970473407415247168',
  eric_da_dawg: 'https://x.com/DaDawgHQ/status/1970156500678299738'
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const db = getDb();
async function sendAlert(message) {
  try {
    const channelId = process.env.ALERT_CHANNEL_ID;
    const userId = process.env.ALERT_USER_ID;
    let sent = false;
    if (channelId) {
      try {
        const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (ch && ch.send) { await ch.send(message).catch(() => {}); sent = true; }
      } catch {}
    }
    if (!sent && userId) {
      try {
        const u = await client.users.fetch(userId).catch(() => null);
        if (u) { await u.send(message).catch(() => {}); }
      } catch {}
    }
  } catch {}
}

// In-memory debounce: ignore repeated interactions from the same user within a short window
const recentInteractions = new Map(); // key: userId, value: timestamp
function isDebounced(userId, windowMs = 800) {
  const now = Date.now();
  const last = recentInteractions.get(userId) || 0;
  if (now - last < windowMs) return true;
  recentInteractions.set(userId, now);
  return false;
}

// Precompute character role lookups
const CHARACTER_ROLE_ID_TO_CHAR = new Map(CHARACTERS.map(c => [c.roleId, c]));
const CHARACTER_ROLE_IDS = new Set(CHARACTERS.map(c => c.roleId));

async function getGuildMemberSafe(interaction) {
  try {
    const guild = interaction.guild ?? (interaction.guildId ? await client.guilds.fetch(interaction.guildId).catch(() => null) : null);
    if (!guild) return null;
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    return member ?? null;
  } catch {
    return null;
  }
}

function getAssignedCharacterForMember(member) {
  if (!member) return null;
  for (const roleId of CHARACTER_ROLE_IDS) {
    if (member.roles.cache.has(roleId)) return CHARACTER_ROLE_ID_TO_CHAR.get(roleId) || null;
  }
  return null;
}

async function enforceNoRetake(interaction) {
  // If the user already has any character role, block quiz start/continuation
  const member = await getGuildMemberSafe(interaction);
  const char = getAssignedCharacterForMember(member);
  if (!char) {
    // Allow retake if the member currently has no character role (e.g., rejoined)
    return false;
  }
  const payload = {
    content: `You already have a character role: ${char.name}. Retakes are disabled. If this seems wrong, contact staff.`,
    embeds: [],
    components: []
  };
  try {
    if (interaction.isStringSelectMenu?.() || interaction.isButton?.()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.update(payload);
      }
    } else {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ephemeral: true, ...payload });
      }
    }
  } catch {}
  return true;
}

async function resolveAndSetActiveStartMessage(channel) {
  try {
    if (!channel || !channel.messages) return null;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return null;
    const latest = recent
      .filter(m => m.author?.id === client.user?.id && Array.isArray(m.components) && m.components.some(r => r.components?.some(c => c.customId === 'quiz:start')))
      .first();
    if (!latest) return null;
    setActiveStartMessageForChannel(db, channel.id, latest.id);
    return latest.id;
  } catch {
    return null;
  }
}

async function ensureAck(interaction) {
  try {
    if (interaction.replied || interaction.deferred) return true;
    if (interaction.isMessageComponent?.()) {
      await interaction.deferUpdate();
      return true;
    }
  } catch {}
  try {
    if (interaction.replied || interaction.deferred) return true;
    // Prefer ephemeral flag; fallback to deprecated option if necessary
    await interaction.reply({ content: 'Working on it…', flags: 64 });
    return true;
  } catch {}
  try {
    if (interaction.replied || interaction.deferred) return true;
    await interaction.deferReply({ ephemeral: true });
    return true;
  } catch {}
  return interaction.replied || interaction.deferred;
}

client.once(Events.ClientReady, c => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  try { c.user.setPresence({ status: 'online', activities: [{ name: 'who are u?', type: ActivityType.Watching }] }); } catch {}
  try { sendAlert(`✅ Bot online at ${new Date().toISOString()}`); } catch {}
  // Ensure Start button presence and activeness on boot and periodically
  try {
    const channelId = process.env.QUIZ_CHANNEL_ID;
    const maintain = async () => {
      if (!channelId) return;
      const guild = c.guilds.cache.first() || null;
      let channel = null;
      try { channel = guild ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)) : null; } catch {}
      if (!channel || !channel.permissionsFor?.(c.user)?.has(PermissionFlagsBits.SendMessages)) return;
      const welcome = process.env.WELCOME_MESSAGE || 'Welcome! Take the quiz to get your role.';
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('quiz:start').setLabel('Start Character Quiz').setStyle(ButtonStyle.Primary)
      );
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const latest = recent?.find(m => m.author.id === c.user.id && m.components?.some(r => r.components?.some(cmp => cmp.customId === 'quiz:start')));
      if (!latest) {
        const sent = await channel.send({ embeds: [new EmbedBuilder().setTitle('Da Dawg HQ Quiz').setDescription(welcome)], components: [row] }).catch(() => null);
        if (sent) setActiveStartMessageForChannel(db, channel.id, sent.id);
      } else {
        setActiveStartMessageForChannel(db, channel.id, latest.id);
      }
      // Soft disable older
      try {
        const candidates = recent?.filter(m => m.id !== (latest?.id) && m.author.id === c.user.id && m.components?.some(r => r.components?.some(cmp => cmp.customId === 'quiz:start')));
        for (const [, msg] of candidates || []) {
          const disabledRows = msg.components.map(r => new ActionRowBuilder().addComponents(
            ...r.components.map(comp => ButtonBuilder.from(comp).setDisabled(true))
          ));
          await msg.edit({ components: disabledRows }).catch(() => {});
        }
      } catch {}
    };
    maintain().catch(() => {});
    setInterval(() => { maintain().catch(() => {}); }, 5 * 60_000);
  } catch {}

  // Connectivity watchdog: alert if Discord REST connectivity repeatedly fails
  try {
    let connectivityFailures = 0;
    let lastConnectivityAlert = 0;
    const guildId = process.env.GUILD_ID;
    const checkConnectivity = async () => {
      try {
        if (!guildId) return;
        // Lightweight fetch; if it throws, we likely lost REST connectivity
        await c.guilds.fetch(guildId);
        connectivityFailures = 0;
      } catch (e) {
        connectivityFailures += 1;
        const now = Date.now();
        // Alert on 2nd consecutive failure and at most once every 10 minutes
        if (connectivityFailures >= 2 && now - lastConnectivityAlert > 10 * 60_000) {
          lastConnectivityAlert = now;
          try { await sendAlert(`⚠️ Connectivity check failing (${connectivityFailures}x). The bot may not receive interactions. Investigating...`); } catch {}
        }
      }
    };
    setInterval(() => { checkConnectivity().catch(() => {}); }, 120_000);
  } catch {}
});

client.on(Events.Error, (e) => { try { console.error('[Gateway Error]', e?.message); sendAlert(`⚠️ Gateway error: ${String(e?.message || e).slice(0, 300)}`); } catch {} });
client.on(Events.ShardError, (e) => { try { console.error('[Shard Error]', e?.message); sendAlert(`⚠️ Shard error: ${String(e?.message || e).slice(0, 300)}`); } catch {} });
client.on(Events.ShardDisconnect, (event, id) => { try { console.warn('[Shard Disconnect]', id, event?.code); sendAlert(`⚠️ Shard ${id} disconnect (code ${event?.code})`); } catch {} });
client.on(Events.ShardReconnecting, (id) => { try { console.warn('[Shard Reconnecting]', id); sendAlert(`ℹ️ Shard ${id} reconnecting`); } catch {} });
client.on(Events.ShardReady, (id) => { try { console.log('[Shard Ready]', id); sendAlert(`✅ Shard ${id} ready`); } catch {} });

// Prevent hard crashes on unhandled errors
process.on('unhandledRejection', (reason) => { try { console.error('[unhandledRejection]', reason); sendAlert(`⚠️ Unhandled rejection: ${String(reason).slice(0, 500)}`); } catch {} });
process.on('uncaughtException', (err) => { try { console.error('[uncaughtException]', err); sendAlert(`❌ Uncaught exception: ${String(err?.message || err).slice(0, 500)}`); } catch {} });

// Simple watchdog log so we know the loop is alive
setInterval(() => { try { console.log('[watchdog] alive', Date.now()); } catch {} }, 60_000);

client.on(Events.GuildMemberRemove, async member => {
  try {
    // When a member leaves, clear their quiz state so a rejoin can take the quiz again
    clearUserData(db, member.id);
  } catch {}
});

client.on(Events.GuildMemberAdd, async member => {
  try {
    // Allow rejoiners to retake quiz: clear any persisted progress/answers
    clearUserData(db, member.id);
  } catch {}
  if (process.env.AUTO_WELCOME !== 'true') return;
  const channelId = process.env.QUIZ_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = member.guild.channels.cache.get(channelId) || await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    // Ensure channel is visible to the rejoined member (remove stale overwrite if present)
    try { await channel.permissionOverwrites?.delete?.(member.id).catch(() => {}); } catch {}
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
    try { console.log('[QUIZ] Interaction received:', {
      isChatInput: interaction.isChatInputCommand?.(),
      isButton: interaction.isButton?.(),
      isStringSelect: interaction.isStringSelectMenu?.(),
      command: interaction.isChatInputCommand?.() ? interaction.commandName : undefined
    }); } catch {}
    if (interaction.isChatInputCommand()) {
      // Always defer quickly to avoid 3s timeouts
      try { if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }); } catch {}
      if (interaction.commandName === 'start-quiz') {
        // Guard: prevent users with any character role from starting
        if (await enforceNoRetake(interaction)) return;
        try { console.log('[QUIZ] /start-quiz invoked by', interaction.user?.id); } catch {}
        try { await startQuiz(interaction); } catch (e) {
          try {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'Something went wrong starting the quiz. Please try again.' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'Something went wrong starting the quiz. Please try again.' });
            }
          } catch {}
          try { console.error('[QUIZ] start-quiz error:', e?.message); } catch {}
        }
      } else if (interaction.commandName === 'post-quiz') {
        const member = interaction.member;
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.editReply({ content: 'You need Manage Guild or Manage Channels permission to use this.' });
          return;
        }
        const welcome = process.env.WELCOME_MESSAGE || 'Welcome! Take the quiz to get your role.';
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('quiz:start').setLabel('Start Character Quiz').setStyle(ButtonStyle.Primary)
        );

        // Try to send in current channel if bot has permission; else fallback to QUIZ_CHANNEL_ID
        const me = interaction.guild.members.me;
        const canSendHere = interaction.channel?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
        if (canSendHere) {
          // Avoid duplicate start buttons: if one already exists from the bot in the last 50 messages, reuse it
          const recent = await interaction.channel.messages.fetch({ limit: 50 }).catch(() => null);
          const existing = recent?.find(m => m.author.id === client.user.id && m.components?.some(r => r.components?.some(c => c.customId === 'quiz:start')));
          if (existing) {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'Start button is already posted here.' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'Start button is already posted here.' });
            }
          } else {
            const sent = await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle('Da Dawg HQ Quiz').setDescription(welcome)], components: [row] });
            setActiveStartMessageForChannel(db, interaction.channel.id, sent.id);
            // Soft-disable any older Start buttons in the last 50 for clarity
            try {
              const candidates = recent?.filter(m => m.id !== sent.id && m.author.id === client.user.id && m.components?.some(r => r.components?.some(c => c.customId === 'quiz:start')));
              for (const [, msg] of candidates || []) {
                const disabledRows = msg.components.map(r => new ActionRowBuilder().addComponents(
                  ...r.components.map(c => ButtonBuilder.from(c).setDisabled(true))
                ));
                await msg.edit({ components: disabledRows }).catch(() => {});
              }
            } catch {}
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'Posted the Start Quiz button here.' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'Posted the Start Quiz button here.' });
            }
          }
        } else {
          const fallbackId = process.env.QUIZ_CHANNEL_ID;
          if (!fallbackId) {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'I lack Send Messages in this channel. Grant permission or set QUIZ_CHANNEL_ID in .env for fallback.' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'I lack Send Messages in this channel. Grant permission or set QUIZ_CHANNEL_ID in .env for fallback.' });
            }
            return;
          }
          const fallback = interaction.guild.channels.cache.get(fallbackId) || await interaction.guild.channels.fetch(fallbackId).catch(() => null);
          const canSendFallback = fallback?.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
          if (fallback && canSendFallback) {
            const sent = await fallback.send({ embeds: [new EmbedBuilder().setTitle('Da Dawg HQ Quiz').setDescription(welcome)], components: [row] });
            setActiveStartMessageForChannel(db, fallback.id, sent.id);
            // Soft-disable any older Start buttons in the last 50 for clarity
            try {
              const recentFallback = await fallback.messages.fetch({ limit: 50 }).catch(() => null);
              const candidates = recentFallback?.filter(m => m.id !== sent.id && m.author.id === client.user.id && m.components?.some(r => r.components?.some(c => c.customId === 'quiz:start')));
              for (const [, msg] of candidates || []) {
                const disabledRows = msg.components.map(r => new ActionRowBuilder().addComponents(
                  ...r.components.map(c => ButtonBuilder.from(c).setDisabled(true))
                ));
                await msg.edit({ components: disabledRows }).catch(() => {});
              }
            } catch {}
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'I posted the Start Quiz button in the configured quiz channel instead (missing Send Messages here).' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'I posted the Start Quiz button in the configured quiz channel instead (missing Send Messages here).' });
            }
          } else {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({ content: 'I cannot send messages here or in QUIZ_CHANNEL_ID. Please grant Send Messages to my role.' });
            } else {
              await interaction.reply({ ephemeral: true, content: 'I cannot send messages here or in QUIZ_CHANNEL_ID. Please grant Send Messages to my role.' });
            }
          }
        }
      } else if (interaction.commandName === 'check-perms') {
        const target = interaction.options.getChannel('channel') ?? interaction.channel;
        const me = interaction.guild.members.me;
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
        await interaction.editReply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('Permission Check').setDescription(`Channel: ${target}
${lines}`)] });
      } else if (interaction.commandName === 'check-quiz-channel') {
        try {
          const member = interaction.member;
          if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            await interaction.editReply({ content: 'You need Manage Guild or Manage Channels permission to use this.' });
            return;
          }
          // Immediate ack to stop the spinner
          try { await interaction.editReply({ content: 'Checking channel…' }); } catch {}
          const target = interaction.options.getChannel('channel') ?? interaction.channel;
          // Use a safe resolvable for permission checks
          let me = interaction.guild?.members?.me ?? null;
          if (!me) {
            try { me = await interaction.guild.members.fetchMe(); } catch { me = null; }
          }
          const quizChannelId = process.env.QUIZ_CHANNEL_ID;
          const isConfiguredChannel = quizChannelId ? (target?.id === quizChannelId) : false;
          const perms = target?.permissionsFor?.(me || client.user);
          const required = [
            'ViewChannel',
            'SendMessages',
            'EmbedLinks',
            'ReadMessageHistory'
          ];
          const optional = [
            'UseExternalEmojis',
            'AddReactions',
            'ManageMessages',
            'ManageChannels'
          ];
          const lines = [];
          lines.push(`${isConfiguredChannel ? '✅' : '❌'} Matches QUIZ_CHANNEL_ID (${quizChannelId || 'not set'})`);
          for (const name of required) lines.push(`${perms?.has(PermissionFlagsBits[name]) ? '✅' : '❌'} ${name}`);
          for (const name of optional) lines.push(`${perms?.has(PermissionFlagsBits[name]) ? 'ℹ️' : '⚠️'} ${name} (optional)`);
          // Check for presence of Start button in the last 50 messages with timeout and safety
          let startButtonPresent = false;
          try {
            const canFetch = target?.isTextBased?.() && target.messages && typeof target.messages.fetch === 'function';
            if (canFetch) {
              const fetchWithTimeout = Promise.race([
                target.messages.fetch({ limit: 50 }),
                new Promise(res => setTimeout(() => res(null), 1500))
              ]);
              const recent = await fetchWithTimeout;
              startButtonPresent = !!recent?.find?.(m => m.author.id === client.user.id && m.components?.some(r => r.components?.some(c => c.customId === 'quiz:start')));
            }
          } catch {}
          lines.push(`${startButtonPresent ? '✅' : '❌'} Start button present in recent messages`);
          const canEmbed = perms?.has(PermissionFlagsBits.EmbedLinks);
          if (canEmbed) {
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('Quiz Channel Check').setDescription(lines.join('\n'))] });
          } else {
            await interaction.editReply({ content: lines.join('\n') });
          }
        } catch (e) {
          await interaction.editReply({ content: 'Check failed. Try again or ensure I have permission to view this channel.' });
        }
      } else if (interaction.commandName === 'bot-info') {
        const member = interaction.member;
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.editReply({ content: 'You need Manage Guild or Manage Channels permission to use this.' });
          return;
        }
        const cwd = process.cwd();
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')); } catch {}
        const mainPath = path.join(process.cwd(), 'src', 'bot.js');
        const files = [
          { label: 'src/bot.js', p: mainPath },
          { label: 'src/utils/scoring.js', p: path.join(process.cwd(), 'src', 'utils', 'scoring.js') },
          { label: 'src/db/index.js', p: path.join(process.cwd(), 'src', 'db', 'index.js') },
          { label: 'scripts/register-commands.js', p: path.join(process.cwd(), 'scripts', 'register-commands.js') }
        ];
        const ts = [];
        for (const f of files) {
          try {
            const st = fs.statSync(f.p);
            ts.push(`${f.label}: mtime ${new Date(st.mtimeMs).toISOString()}`);
          } catch {
            ts.push(`${f.label}: not found`);
          }
        }
        const lines = [
          `cwd: ${cwd}`,
          `version: ${pkg?.version || 'unknown'}`,
          ...ts
        ];
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('Bot Info').setDescription(lines.join('\n'))], ephemeral: true });
      } else if (interaction.commandName === 'reset-quiz') {
        const member = interaction.member;
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild) && !member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.editReply({ content: 'You need Manage Guild or Manage Channels permission to use this.' });
          return;
        }
        const target = interaction.options.getUser('user');
        if (!target) {
          await interaction.editReply({ content: 'Please specify a user.' });
          return;
        }
        try {
          clearUserData(db, target.id);
          // Remove any stale channel overwrite so they can see the quiz channel again
          const channelId = process.env.QUIZ_CHANNEL_ID;
          if (channelId) {
            const ch = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (ch && ch.permissionOverwrites) {
              try { await ch.permissionOverwrites.delete(target.id).catch(() => {}); } catch {}
            }
          }
          await interaction.editReply({ content: `Reset quiz data for <@${target.id}>.` });
        } catch (e) {
          await interaction.editReply({ content: 'Failed to reset user data. Check logs and permissions.' });
        }
      } else if (interaction.commandName === 'ping') {
        await interaction.editReply({ ephemeral: true, content: 'pong' });
      } else if (interaction.commandName === 'health') {
        const uptimeSec = Math.floor(process.uptime());
        const mem = process.memoryUsage?.()?.rss || 0;
        await interaction.editReply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('Health').setDescription(`Uptime: ${uptimeSec}s\nRSS: ${Math.round(mem/1024/1024)} MB`).setColor(0x00aa88)] });
      }
    } else if (interaction.isButton()) {
      if (isDebounced(interaction.user.id)) {
        try { if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate(); } catch {}
        return;
      }
      if (interaction.customId === 'quiz:start') {
        // Start quiz with a single ephemeral message (avoid updating public message)
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({ content: 'Loading quiz...', flags: 64 });
          }
        } catch {}
        // Only accept clicks on the latest Start button in this channel
        try {
          let activeId = getActiveStartMessageForChannel(db, interaction.channel?.id);
          if (!activeId) {
            // Auto-resolve latest start in case the store was cleared/restarted
            activeId = await resolveAndSetActiveStartMessage(interaction.channel);
          }
          const messageId = interaction.message?.id;
          if (activeId && messageId && activeId !== messageId) {
            try { await interaction.editReply({ content: 'This Start button is no longer active. Please use the most recent one in this channel.' }); } catch { try { if (!interaction.replied) await interaction.reply({ content: 'This Start button is no longer active. Please use the most recent one in this channel.', flags: 64 }); } catch {} }
            return;
          }
        } catch {}
        // Guard: prevent users with any character role from starting
        if (await enforceNoRetake(interaction)) return;
        try {
        await renderQuestion(interaction, 0, true);
        } catch (e) {
          try { await interaction.editReply({ content: 'Something went wrong displaying the first question. Please try again.' }); } catch { try { if (!interaction.replied) await interaction.reply({ content: 'Something went wrong displaying the first question. Please try again.', flags: 64 }); } catch {} }
          return;
        }
      } else if (interaction.customId.startsWith('quiz:next:')) {
        const index = Number(interaction.customId.split(':')[2]);
        // Ack immediately to avoid 3s timeouts
        await ensureAck(interaction);
        // Guard: prevent progression if role was assigned mid-quiz
        if (await enforceNoRetake(interaction)) return;
        await renderQuestion(interaction, index, false);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (isDebounced(interaction.user.id)) {
        try { if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate(); } catch {}
        return;
      }
      if (interaction.customId.startsWith('quiz:q:')) {
        const index = Number(interaction.customId.split(':')[2]);
        // Prevent timeouts on slow updates
        try { if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate(); } catch {}
        // Guard: prevent answers if role was assigned already
        if (await enforceNoRetake(interaction)) return;
        const opt = interaction.values?.[0];
        if (!opt) {
          await interaction.editReply?.({ content: 'Please choose an option.' }).catch(() => {});
          return;
        }
        saveAnswer(db, interaction.user.id, index, opt);
        const nextIndex = Number.isFinite(index) ? index + 1 : 0;
        if (nextIndex < QUIZ.questions.length) {
          try {
            await renderQuestion(interaction, nextIndex, false);
          } catch {
            await finalizeQuiz(interaction);
          }
        } else {
          await finalizeQuiz(interaction);
        }
      }
    }
  } catch (err) {
    // Log for diagnostics
    console.error('Interaction error:', err);
    // Alert staff in monitor channel/DM with context
    try {
      const who = interaction.user ? `${interaction.user.tag} (${interaction.user.id})` : 'unknown user';
      const where = interaction.channelId || 'unknown channel';
      const kind = interaction.isButton?.() ? 'button' : interaction.isStringSelectMenu?.() ? 'select' : interaction.isChatInputCommand?.() ? 'slash' : 'other';
      const errMsg = err?.message || String(err);
      await sendAlert(`⚠️ Interaction error\nUser: ${who}\nChannel: ${where}\nType: ${kind}\nError: ${errMsg.slice(0, 400)}`);
    } catch {}
    // Professional, user-facing fallback (ephemeral where possible)
    try {
      const friendly = 'We’re experiencing a temporary issue handling your request. Our team has been notified and will resolve it shortly. Please try again in a moment.';
      if (interaction.deferred) {
        await interaction.editReply({ content: friendly });
      } else if (!interaction.replied) {
        await interaction.reply({ content: friendly, flags: 64 });
      }
    } catch {}
  }
});

async function startQuiz(interaction) {
  upsertUserProgress(db, interaction.user.id, { started_at: Date.now() });
  if (QUIZ.questions.length === 0) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Quiz not configured yet. Add src/config/quiz.json.' });
      } else {
        await interaction.reply({ ephemeral: true, content: 'Quiz not configured yet. Add src/config/quiz.json.' });
      }
    } catch {}
    return;
  }
  // Build and send first question immediately to avoid timeouts
  const payload = buildQuestionEmbedAndMenu(0);
  if (!payload) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Unable to render the first question.' });
      } else {
        await interaction.reply({ ephemeral: true, content: 'Unable to render the first question.' });
      }
    } catch {}
    return;
  }
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ephemeral: true, ...payload });
    }
  } catch (e) {
    try { console.error('[QUIZ] startQuiz initial send failed:', e?.message); } catch {}
  }
}

function buildQuestionEmbedAndMenu(index) {
  const q = QUIZ.questions[index];
  if (!q || !Array.isArray(q.options) || q.options.length === 0) return;
  // Load GIF for this question
  let imageUrl = undefined;
  try {
    const mediaPath = path.join(process.cwd(), 'src', 'config', 'quiz_media.json');
    if (fs.existsSync(mediaPath)) {
      const media = JSON.parse(fs.readFileSync(mediaPath, 'utf-8'));
      imageUrl = media.questionGifs?.[index];
    }
  } catch {}
  const safeOptions = q.options
    .filter(o => o && o.key && o.label)
    .slice(0, 25)
    .map(o => {
      const key = String(o.key).toUpperCase();
      const answerText = String(o.label)
        .replace(/^[A-Fa-f][\)\.]:?\s*/,'')
        .replace(/[•●]/g,'')
        .replace(/\s+/g,' ')
        .trim();
      return {
        // Keep label minimal so it appears bold (A), B), ...)
        label: `${key})`.slice(0, 100),
        value: key,
        // Put the full answer in description so it renders non-bold, left-aligned
        description: answerText.slice(0, 100)
      };
    });
  try { console.log('[QUIZ] Built options for Q', index + 1, safeOptions.map(o => ({ label: o.label, description: o.description })).slice(0, 2)); } catch {}
  if (safeOptions.length === 0) return;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`quiz:q:${index}`)
    .setPlaceholder('Select your answer')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(safeOptions);
  const row = new ActionRowBuilder().addComponents(menu);
  // Build embed with prompt only; answers are shown only in the dropdown
  const rawPrompt = String(q.prompt ?? '');
  const sanitizedPrompt = rawPrompt
    .replace(/[•●]/g,'')
    .replace(/\r/g,'')
    .split('\n')
    .filter(line => !/^\s*[A-Fa-f][\)\.]\s+/.test(line))
    .join('\n')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0, 2000);
  const embed = new EmbedBuilder()
    .setTitle(`Da Dawg HQ Quiz — Question ${index + 1}`)
    .setDescription(sanitizedPrompt);
  if (imageUrl) embed.setImage(imageUrl);
  return { embeds: [embed], components: [row] };
}

async function renderQuestion(interaction, index, first) {
  // Guard at render time as well
  if (await enforceNoRetake(interaction)) return;
  // If index is out of range, finalize gracefully
  if (!QUIZ.questions[index]) {
    await finalizeQuiz(interaction);
    return;
  }
  const payload = buildQuestionEmbedAndMenu(index);
  if (!payload) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Unable to render this question. Please try again.' });
      } else if (interaction.isMessageComponent?.()) {
        await interaction.update({ content: 'Unable to render this question. Please try again.', components: [], embeds: [] });
      } else {
        await interaction.reply({ ephemeral: true, content: 'Unable to render this question. Please try again.' });
      }
    } catch {}
    return;
  }
  if (interaction.isStringSelectMenu() || interaction.isButton()) {
    // Only edit the user's ephemeral reply or follow up ephemerally; never update the public message
    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply(payload); } catch (e) {
        try { console.error('[QUIZ] editReply failed in renderQuestion:', e?.message); } catch {}
        try { await interaction.followUp({ ephemeral: true, ...payload }); } catch {}
      }
    } else {
      try { await interaction.reply({ ephemeral: true, ...payload }); } catch (e) {
        try { console.error('[QUIZ] reply failed in renderQuestion:', e?.message); } catch {}
      }
    }
  } else {
    // Slash command path: edit the deferred reply
    if (first) {
      await interaction.editReply(payload).catch(e => { try { console.error('[QUIZ] editReply failed (slash first):', e?.message); } catch {} });
    } else {
      await interaction.editReply(payload).catch(e => { try { console.error('[QUIZ] editReply failed (slash next):', e?.message); } catch {} });
    }
  }
}

async function finalizeQuiz(interaction) {
  // If a character role is already present, don't re-finalize
  if (await enforceNoRetake(interaction)) return;
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

  let embed;
  let files = undefined;
  if (RESULTS && topCharacterId && RESULTS[topCharacterId]) {
    const r = RESULTS[topCharacterId];
    // Italicize quoted lines within body content
    const formattedBody = String(r.body ?? '')
      .replace(/"([^"\\]+)"/g, '_"$1"_');
    const teaser = X_TEASERS[topCharacterId];
    const bodyWithTeaser = teaser ? `${formattedBody}\n\nTeaser: ${teaser}` : formattedBody;
    embed = new EmbedBuilder()
      .setTitle(`${r.heading ?? nameMap.get(topCharacterId) ?? 'Result'}`)
      .setDescription(`${r.subtitle ? `_${r.subtitle}_\n\n` : ''}${bodyWithTeaser}`);
    // Attach local image file if present
    if (r.image) {
      try {
        const imgPath = path.isAbsolute(r.image) ? r.image : path.join(process.cwd(), r.image);
        if (fs.existsSync(imgPath)) {
          const fileName = path.basename(imgPath);
          files = [new AttachmentBuilder(imgPath).setName(fileName)];
          embed.setImage(`attachment://${fileName}`);
        }
      } catch {}
    }
  } else {
    const matchedName = nameMap.get(topCharacterId) ?? 'Unknown';
    embed = new EmbedBuilder()
      .setTitle(`You matched: ${matchedName}`)
      .setDescription('Thanks for completing the quiz.');
  }

  const payload = { embeds: [embed], components: [], files };
  if (interaction.isStringSelectMenu() || interaction.isButton()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async e => {
        try { console.error('[QUIZ] finalize editReply failed (component):', e?.message); } catch {}
        try { await interaction.followUp({ ephemeral: true, ...payload }); } catch {}
      });
    } else {
      // Never update the public message; reply ephemerally instead
      await interaction.reply({ ephemeral: true, ...payload }).catch(async e => {
        try { console.error('[QUIZ] finalize reply failed (component):', e?.message); } catch {}
      });
    }
  } else if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(async e => {
      try { console.error('[QUIZ] finalize editReply failed (slash):', e?.message); } catch {}
      try { await interaction.followUp({ ephemeral: true, ...payload }); } catch {}
    });
  } else {
    await interaction.reply({ ephemeral: true, ...payload }).catch(e => { try { console.error('[QUIZ] finalize reply failed:', e?.message); } catch {} });
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
    new SlashCommandBuilder().setName('start-quiz').setDescription('Start the Da Daqg HQ character quiz'),
    new SlashCommandBuilder().setName('post-quiz').setDescription('Post the Start Quiz button in this channel or fallback'),
    new SlashCommandBuilder()
      .setName('check-perms')
      .setDescription('Check my permissions in a channel')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to check').setRequired(false))
    ,
    new SlashCommandBuilder()
      .setName('check-quiz-channel')
      .setDescription('Admin: verify quiz channel setup and permissions')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to verify').setRequired(false))
    ,
    new SlashCommandBuilder()
      .setName('bot-info')
      .setDescription('Admin: show running bot info (cwd, entry, version, timestamps)')
    ,
    new SlashCommandBuilder()
      .setName('reset-quiz')
      .setDescription('Admin: reset a user\'s stored quiz data')
      .addUserOption(opt => opt.setName('user').setDescription('User to reset').setRequired(true))
    ,
    new SlashCommandBuilder().setName('ping').setDescription('Health check'),
    new SlashCommandBuilder().setName('health').setDescription('Bot health and uptime')
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('Registered dev commands');
}

if (process.env.NODE_ENV === 'development') {
  registerCommandsDev().catch(console.error);
}

client.login(process.env.DISCORD_TOKEN);


