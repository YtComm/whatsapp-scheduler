require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { google } = require('googleapis');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SPREADSHEET_ID      = process.env.SPREADSHEET_ID;
const SHEET_NAME          = process.env.SHEET_NAME || 'Sessions';
const PERSONAL_SHEET_NAME = process.env.PERSONAL_SHEET_NAME || 'Personal';
const WHATSAPP_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME;

// Track scheduled jobs to avoid duplicates across hourly refreshes
const scheduledJobs = new Map();

// Track which phones we've messaged (phone → sheet row number, 1-indexed from row 2)
// Used to know which row to update when a reply comes in
const personalPhoneToRow = new Map();

// Track phones we've already marked as replied (avoid duplicate writes)
const repliedPhones = new Set();

// ─── GOOGLE SHEETS AUTH ────────────────────────────────────────────────────
function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// ─── SESSIONS SHEET ────────────────────────────────────────────────────────
// Columns:
// A: type           → reminder / feedback / announcement / (anything else uses column N)
// B: sessionName
// C: speaker
// D: designation
// E: company
// F: date           → DD/MM/YYYY (session date, used in templates)
// G: time           → HH:MM 24hr (session start time, used in templates)
// H: weekNumber
// I: dayNumber
// J: link           → Zoom link (reminder) / Feedback form link (feedback) / optional link (announcement)
// K: passcode       → reminder only
// L: sendDate       → DD/MM/YYYY — when to actually send this message
// M: sendTime       → HH:MM 24hr — what time to send
// N: customMessage  → only read when type is not reminder/feedback/announcement

async function getSessionRows() {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:N1000`,
  });
  return (res.data.values || []).filter(row => row[0]);
}

// ─── PERSONAL SHEET ────────────────────────────────────────────────────────
// Columns:
// A: phone      → international format without +, e.g. 919876543210
// B: message    → exact message text to send
// C: sendDate   → DD/MM/YYYY
// D: sendTime   → HH:MM 24hr
// E: status     → auto-filled: "Replied ✅" (written by bot)
// F: repliedAt  → auto-filled: timestamp when reply received (written by bot)

async function getPersonalRows() {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${PERSONAL_SHEET_NAME}!A2:F1000`,
  });
  return (res.data.values || []).filter(row => row[0] && row[1]);
}

// ─── WRITE REPLY STATUS TO SHEET ──────────────────────────────────────────
async function markReplied(sheetRowNumber) {
  // sheetRowNumber is the actual Google Sheets row (header is row 1, data starts at row 2)
  try {
    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    const timestamp = new Date().toLocaleString('en-IN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${PERSONAL_SHEET_NAME}!E${sheetRowNumber}:F${sheetRowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['Replied ✅', timestamp]],
      },
    });

    console.log(`📝 Sheet updated → row ${sheetRowNumber} marked as replied at ${timestamp}`);
  } catch (err) {
    console.error(`❌ Failed to update sheet for row ${sheetRowNumber}:`, err.message);
  }
}

// ─── MESSAGE TEMPLATES ─────────────────────────────────────────────────────
function buildReminderMessage(s) {
  const [day, month, year] = s.date.split('/');
  const dateObj = new Date(Number(year), Number(month) - 1, Number(day));
  const dateStr = dateObj.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', weekday: 'long',
  });
  return `Good morning Folks! 😃
Hope you're all set for day ${s.dayNumber} of ${s.weekNumber} week of D2CX 🥳
We have an amazing masterclass lined up for you today, ${dateStr} 👇

📌 Session: ${s.sessionName}
⌚ Time: ${formatTime12hr(s.sessionTime)} IST
🔗 Link To Join: ${s.link}
*Passcode:* ${s.passcode}

In case you face any issues or have questions, feel free to text me. 🙌
See you in the session! 🚀`;
}

function buildFeedbackMessage(s) {
  return `Hey folks 👋
It was lovely having you all in today's session on *${s.sessionName}* by ${s.speaker}, ${s.designation} at ${s.company} 💯

Please take 30 seconds to fill out the feedback form 👇
${s.link}

Look forward to seeing your feedback! 🙏`;
}

function buildAnnouncementMessage(s) {
  const [day, month, year] = s.date.split('/');
  const dateObj = new Date(Number(year), Number(month) - 1, Number(day));
  const dateStr = dateObj.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', weekday: 'long',
  });
  return `📢 Hey D2CX Fam!

Exciting news — we've got *${s.sessionName}* coming up on ${dateStr} at ${formatTime12hr(s.sessionTime)} IST 🎉

Our speaker is *${s.speaker}*, ${s.designation} at ${s.company} — you won't want to miss this one! 🔥
${s.link ? `\n🔗 More details: ${s.link}` : ''}
Stay tuned and keep showing up! 💪`;
}

function formatTime12hr(time24) {
  if (!time24 || !time24.includes(':')) return time24;
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// ─── DATETIME HELPERS ──────────────────────────────────────────────────────
function parseDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [day, month, year] = dateStr.split('/');
  const [hour, minute] = timeStr.split(':');
  const dt = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
  return isNaN(dt.getTime()) ? null : dt;
}

// ─── SCHEDULE A SINGLE MESSAGE ─────────────────────────────────────────────
function scheduleMessage({ jobKey, sendDT, label, send }) {
  const now = new Date();

  if (scheduledJobs.has(jobKey)) return;

  if (sendDT <= now) {
    console.log(`⏭️  Skipped (past) → ${label}`);
    return;
  }

  const delay = sendDT - now;
  console.log(`⏰ Scheduled → ${label} at ${sendDT.toLocaleString('en-IN')}`);

  const timer = setTimeout(async () => {
    try {
      await send();
      console.log(`✅ Sent → ${label}`);
    } catch (err) {
      console.error(`❌ Failed → ${label}:`, err.message);
    }
  }, delay);

  scheduledJobs.set(jobKey, timer);
}

// ─── PROCESS SESSIONS TAB ─────────────────────────────────────────────────
function processSessionRows(rows, whatsappClient, groupId) {
  rows.forEach((row, idx) => {
    const type        = (row[0] || '').toLowerCase().trim();
    const sessionName = row[1] || '';
    const speaker     = row[2] || '';
    const designation = row[3] || '';
    const company     = row[4] || '';
    const date        = row[5] || '';
    const sessionTime = row[6] || '';
    const weekNumber  = row[7] || '';
    const dayNumber   = row[8] || '';
    const link        = row[9] || '';
    const passcode    = row[10] || '';
    const sendDate    = row[11] || '';
    const sendTime    = row[12] || '';
    const customMsg   = row[13] || '';

    if (!sendDate || !sendTime) return;

    const sendDT = parseDateTime(sendDate, sendTime);
    if (!sendDT) {
      console.warn(`⚠️  Sessions row ${idx + 2}: Invalid send datetime "${sendDate} ${sendTime}"`);
      return;
    }

    const s = { sessionName, speaker, designation, company, date, sessionTime, weekNumber, dayNumber, link, passcode };
    const jobKey = `session-row${idx}-${sendDate}-${sendTime}`;

    let getMessage;
    if (type === 'reminder') {
      getMessage = () => buildReminderMessage(s);
    } else if (type === 'feedback') {
      getMessage = () => buildFeedbackMessage(s);
    } else if (type === 'announcement') {
      getMessage = () => buildAnnouncementMessage(s);
    } else if (customMsg) {
      getMessage = () => customMsg;
    } else {
      console.warn(`⚠️  Sessions row ${idx + 2}: Unknown type "${type}" with no custom message — skipping`);
      return;
    }

    scheduleMessage({
      jobKey,
      sendDT,
      label: `[${type}] "${sessionName}"`,
      send: () => whatsappClient.sendMessage(groupId, getMessage()),
    });
  });
}

// ─── PROCESS PERSONAL TAB ─────────────────────────────────────────────────
function processPersonalRows(rows, whatsappClient) {
  rows.forEach((row, idx) => {
    const phone    = (row[0] || '').replace(/\D/g, '');
    const message  = row[1] || '';
    const sendDate = row[2] || '';
    const sendTime = row[3] || '';
    const status   = (row[4] || '').trim(); // col E — already replied?

    if (!phone || !message || !sendDate || !sendTime) return;

    // Register phone → sheet row mapping for reply tracking
    // Sheet row = idx + 2 (header is row 1, data starts at row 2)
    const sheetRow = idx + 2;
    personalPhoneToRow.set(phone, sheetRow);

    // If already marked replied in the sheet, track it so we don't overwrite
    if (status.includes('Replied')) {
      repliedPhones.add(phone);
    }

    const sendDT = parseDateTime(sendDate, sendTime);
    if (!sendDT) {
      console.warn(`⚠️  Personal row ${sheetRow}: Invalid send datetime "${sendDate} ${sendTime}"`);
      return;
    }

    const jobKey = `personal-${phone}-${sendDate}-${sendTime}`;

    scheduleMessage({
      jobKey,
      sendDT,
      label: `[personal] → +${phone}`,
      send: () => whatsappClient.sendMessage(`${phone}@c.us`, message),
    });
  });
}

// ─── LOAD AND SCHEDULE EVERYTHING ─────────────────────────────────────────
async function loadAndSchedule(whatsappClient, groupId) {
  try {
    const [sessionRows, personalRows] = await Promise.all([
      getSessionRows(),
      getPersonalRows(),
    ]);

    console.log(`📋 Sessions: ${sessionRows.length} rows | Personal: ${personalRows.length} rows`);

    processSessionRows(sessionRows, whatsappClient, groupId);
    processPersonalRows(personalRows, whatsappClient);
  } catch (err) {
    console.error('❌ Failed to load sheets:', err.message);
  }
}

// ─── WHATSAPP CLIENT ───────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('\n✅ WhatsApp connected!\n');

  const chats = await client.getChats();
  const group = chats.find(c => c.isGroup && c.name === WHATSAPP_GROUP_NAME);

  if (!group) {
    console.error(`\n❌ Group "${WHATSAPP_GROUP_NAME}" not found.`);
    console.log('\nAvailable groups:');
    chats.filter(c => c.isGroup).forEach(g => console.log('  -', g.name));
    return;
  }

  console.log(`✅ Group found: "${group.name}"\n`);

  await loadAndSchedule(client, group.id._serialized);

  cron.schedule('0 * * * *', async () => {
    console.log('\n🔄 Hourly refresh...');
    await loadAndSchedule(client, group.id._serialized);
  });
});

// ─── REPLY LISTENER ───────────────────────────────────────────────────────
client.on('message', async (msg) => {
  // Only care about private (non-group) incoming messages
  if (msg.fromMe || msg.from.includes('@g.us')) return;

  // WhatsApp sometimes uses @lid (linked device ID) instead of @c.us
  // Use getContact() to resolve the real phone number
  let phone = null;
  try {
    const contact = await msg.getContact();
    if (contact && contact.number) {
      phone = contact.number.replace(/\D/g, '');
    }
  } catch (e) {
    // fallback to msg.from
  }

  if (!phone) {
    phone = msg.from.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
  }

  console.log(`📨 Incoming DM → resolved phone: ${phone}`);

  if (!personalPhoneToRow.has(phone)) return;

  // Only log the first reply — don't spam the sheet
  if (repliedPhones.has(phone)) return;

  repliedPhones.add(phone);
  const sheetRow = personalPhoneToRow.get(phone);

  console.log(`💬 Reply received from +${phone} → updating row ${sheetRow}`);
  await markReplied(sheetRow);
});

client.on('auth_failure', () => {
  console.error('❌ Auth failed. Delete .wwebjs_auth and restart.');
});

client.on('disconnected', (reason) => {
  console.log('⚠️  Disconnected:', reason);
  console.log('Restart the app to reconnect.');
});

console.log('🚀 Starting WhatsApp Scheduler...');
client.initialize();