import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
} from 'discord.js';

const DATA_URL = process.env.DATA_URL
  ?? 'https://raw.githubusercontent.com/ReynRule/saudade/main/data/state.json';

const { DISCORD_TOKEN, CLIENT_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID environment variables.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Data loading (60s cache)
 * state.json: { season:{start,end}, players:{ [name]:{ guild, lastScore,
 *   hours:{ "YYYY-MM-DDTHH":{count,gain} }, jumps:{ total,j10,j20,j30,
 *   hours:{ key:{j10,j20,j30} } }, past:[{start,end,total,wave}] } }, updated }
 * Hour key "…T21" = bucket 21:55–22:55 KST (poll.js keeps at most 24 buckets).
 * season/past start & end are UTC timestamps (shown here in KST).
 * ------------------------------------------------------------------ */
let cache = { at: 0, data: null };
async function getState() {
  if (cache.data && Date.now() - cache.at < 60_000) return cache.data;
  try {
    const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Failed to load data (HTTP ${r.status})`);
    cache = { at: Date.now(), data: await r.json() };
  } catch (e) {
    // remote file broken/unreachable: keep serving the last good copy
    if (cache.data) {
      console.error('using stale data:', e.message);
      return cache.data;
    }
    throw new Error('Data is temporarily unavailable');
  }
  return cache.data;
}

/* ---------------------------- helpers ----------------------------- */
const HOUR = 3_600_000;
const pad = n => String(n).padStart(2, '0');
const fmt = n => Math.round(n).toLocaleString('en-US');
const sign = n => (n >= 0 ? `+${fmt(n)}` : fmt(n));
const esc = s => String(s).replace(/([\\*_~`|>])/g, '\\$1');
const NO_PING = { parse: [] };
const CHUNK = 3500; // embed description limit is 4096

const hourLabel = k => {
  const h = Number(k.slice(11, 13));
  return `${k.slice(5, 10)} ${pad(h)}:55–${pad((h + 1) % 24)}:55`;
};
const kstDay = iso => new Date(Date.parse(`${iso}Z`) + 9 * HOUR).toISOString().slice(5, 10);

const jumpsAt = (p, k) => {
  const j = p.jumps?.hours?.[k];
  return j ? (j.j10 || 0) + (j.j20 || 0) + (j.j30 || 0) : 0;
};

// Same as the web page: last 24 stored hour buckets (incl. the in-progress one), summed.
function stats(p) {
  const keys = Object.keys(p.hours ?? {}).sort().slice(-24);
  return {
    rwph: keys.reduce((a, k) => a + (p.hours[k].count || 0), 0),
    gain: keys.reduce((a, k) => a + (p.hours[k].gain || 0), 0),
  };
}

function findPlayer(state, q) {
  const names = Object.keys(state.players);
  const l = q.toLowerCase();
  const name = names.find(n => n.toLowerCase() === l)
    ?? names.find(n => n.toLowerCase().startsWith(l))
    ?? names.find(n => n.toLowerCase().includes(l));
  return name ? [name, state.players[name]] : null;
}

/**
 * Mobile-friendly list: each entry is a short text block (no padded code-block table,
 * which scrolls sideways / breaks on phones). Overflow goes into public follow-ups.
 */
async function sendList(i, { content, title, entries, empty, color }) {
  const chunks = [];
  let cur = '';
  for (const e of entries) {
    if (cur && (cur + '\n' + e).length > CHUNK) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + e;
  }
  if (cur) chunks.push(cur);
  if (!chunks.length) chunks.push(empty ?? 'No data.');

  const embed = (c, idx) => new EmbedBuilder().setColor(color)
    .setTitle(idx === 0 ? title : `${title} (cont.)`)
    .setDescription(c);
  await i.editReply({ content, embeds: [embed(chunks[0], 0)], allowedMentions: NO_PING });
  for (let n = 1; n < chunks.length; n++) {
    await i.followUp({ embeds: [embed(chunks[n], n)], allowedMentions: NO_PING });
  }
}

const updatedLine = s => (s.updated ? `Data updated <t:${Math.floor(s.updated / 1000)}:R>` : '');

/* --------------------------- commands ----------------------------- */
const SORTS = [
  { name: 'Score', value: 'score' },
  { name: '24h RWPH', value: 'rwph' },
  { name: '24h Gain', value: 'gain' },
  { name: 'Season Jumps', value: 'jumps' },
  { name: 'Name', value: 'name' },
];

const commands = [
  new SlashCommandBuilder().setName('hourly')
    .setDescription('Hourly stats for a player (Hour KST / RWPH / Gain / Jumps)')
    .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('hours').setDescription('How many hours to show (default 24)').setMinValue(1).setMaxValue(72)),
  new SlashCommandBuilder().setName('skips')
    .setDescription('Past-season jump (skip) counts for a player')
    .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('guild')
    .setDescription('Show every member of the Nth SD guild (1 = SD, 2 = SD2, …)')
    .addIntegerOption(o => o.setName('number').setDescription('Guild number').setRequired(true).setMinValue(1).setMaxValue(50))
    .addStringOption(o => o.setName('sort').setDescription('Sort by (default: Score)').addChoices(...SORTS))
    .addStringOption(o => o.setName('order').setDescription('Sort order')
      .addChoices({ name: 'Descending', value: 'desc' }, { name: 'Ascending', value: 'asc' })),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  // Global registration: commands are available in every server the bot is in
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Global slash commands registered.');
}

/* --------------------------- handlers ----------------------------- */
async function handle(i) {
  await i.deferReply(); // public reply (not ephemeral)
  const state = await getState();

  if (i.commandName === 'hourly') {
    const found = findPlayer(state, i.options.getString('player', true));
    if (!found) return i.editReply('Player not found.');
    const [name, p] = found;
    const n = i.options.getInteger('hours') ?? 24;
    const keys = Object.keys(p.hours ?? {}).sort().reverse().slice(0, n);
    const entries = keys.map(k => {
      const h = p.hours[k];
      const j = jumpsAt(p, k);
      return `**${hourLabel(k)}**\n└ RWPH \`${fmt(h.count || 0)}\` · wave \`${sign(h.gain || 0)}\` · JUMP \`${j || '-'}\``;
    });
    return sendList(i, {
      content: [
        `**${esc(name)}** · ${esc(p.guild ?? '-')}`,
        `Score **${fmt(p.lastScore ?? 0)}**`,
        `Season jumps **${p.jumps?.total ?? 0}**`,
        updatedLine(state),
      ].filter(Boolean).join('\n'),
      title: 'Hourly stats', entries, empty: 'No hourly data yet.', color: 0x5865f2,
    });
  }

  if (i.commandName === 'skips') {
    const found = findPlayer(state, i.options.getString('player', true));
    if (!found) return i.editReply('Player not found.');
    const [name, p] = found;
    const past = [...(p.past ?? [])].reverse(); // newest first
    const cur = p.jumps?.total ?? 0;
    const head = [
      `**${esc(name)}** · ${esc(p.guild ?? '-')}`,
      `Current season jumps: **${cur}**`,
      `j10 **${p.jumps?.j10 ?? 0}** · j20 **${p.jumps?.j20 ?? 0}** · j30 **${p.jumps?.j30 ?? 0}**`,
    ];
    if (!past.length) {
      return i.editReply({ content: `${head.join('\n')}\nNo past-season records.`, allowedMentions: NO_PING });
    }
    const total = past.reduce((a, s) => a + (s.total || 0), 0);
    const entries = past.map(s =>
      `**${kstDay(s.start)} ~ ${kstDay(s.end)}**\n└ Final wave \`${fmt(s.wave || 0)}\` · Jumps \`${s.total || 0}\``);
    return sendList(i, {
      content: `${head.join('\n')}\nPast seasons total: **${total}**`,
      title: 'Past seasons', entries, color: 0xf39c12,
    });
  }

  if (i.commandName === 'guild') {
    const num = i.options.getInteger('number', true);
    const sort = i.options.getString('sort') ?? 'score';
    const order = i.options.getString('order') ?? (sort === 'name' ? 'asc' : 'desc');
    const gName = num === 1 ? 'SD' : `SD${num}`;

    const members = Object.entries(state.players)
      .filter(([, p]) => (p.guild ?? '').toLowerCase() === gName.toLowerCase())
      .map(([name, p]) => ({ name, score: p.lastScore ?? 0, jumps: p.jumps?.total ?? 0, ...stats(p) }));

    if (!members.length) {
      const all = [...new Set(Object.values(state.players).map(p => p.guild))].sort().join(', ');
      const msg = `No members found for **${gName}**.\nAvailable guilds: ${all}`;
      return i.editReply({ content: msg.slice(0, 1900), allowedMentions: NO_PING });
    }

    const val = { score: m => m.score, rwph: m => m.rwph, gain: m => m.gain, jumps: m => m.jumps };
    members.sort((a, b) => sort === 'name'
      ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : val[sort](a) - val[sort](b));
    if (order === 'desc') members.reverse();

    const entries = members.map((m, idx) =>
      `**${idx + 1}. ${esc(m.name)}**\n`
      + `└ ${fmt(m.score)} · RWPH \`${fmt(m.rwph)}\` · \`${sign(m.gain)}\` · JUMP \`${m.jumps}\``);

    const totGain = members.reduce((a, m) => a + m.gain, 0);
    const totJumps = members.reduce((a, m) => a + m.jumps, 0);
    const sortName = SORTS.find(s => s.value === sort).name;
    return sendList(i, {
      content: [
        `**${gName}** · ${members.length} members`,
        `24h Gain **${sign(totGain)}** · Season jumps **${totJumps}**`,
        `Per player: Score · RWPH · Gain · JUMP (24h totals)`,
        updatedLine(state),
      ].filter(Boolean).join('\n'),
      title: `${gName} — by ${sortName} (${order === 'desc' ? 'high → low' : 'low → high'})`,
      entries, color: 0x2ecc71,
    });
  }
}

/* ---------------------------- client ------------------------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  // GitHub Actions jobs max out at 6h: exit cleanly after 350 min so the queued run takes over
  const lifetime = Number(process.env.BOT_LIFETIME_MIN ?? 350) * 60_000;
  setTimeout(async () => {
    console.log('Lifetime reached, restarting via next run.');
    await client.destroy();
    process.exit(0);
  }, lifetime);
});

client.on('interactionCreate', async i => {
  try {
    if (i.isAutocomplete()) {
      const q = i.options.getFocused().toLowerCase();
      const state = await getState();
      return i.respond(Object.entries(state.players)
        .filter(([n]) => n.toLowerCase().includes(q))
        .slice(0, 25)
        .map(([n, p]) => ({ name: `${n} (${p.guild})`.slice(0, 100), value: n.slice(0, 100) })));
    }
    if (i.isChatInputCommand()) await handle(i);
  } catch (e) {
    console.error(e);
    const msg = `Error: ${e.message}`;
    if (i.isRepliable()) (i.deferred || i.replied ? i.editReply(msg) : i.reply(msg)).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
