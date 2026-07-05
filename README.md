# D2CX WhatsApp Scheduler

Auto-sends session reminders + feedback messages to your WhatsApp group. You fill the sheet, it handles the rest.

## What it sends

- **9:00 AM on session day** → morning reminder with Zoom link + passcode
- **60 mins after session start** → feedback form message

## Sheet format (tab name: Sessions)

| Col | Field | Example |
|-----|-------|---------|
| A | Session Name | Cracking Influencer Marketing |
| B | Speaker | Ashwarya Garg |
| C | Designation | Cofounder |
| D | Company | HYPD |
| E | Date (DD/MM/YYYY) | 22/03/2025 |
| F | Time (24hr HH:MM) | 11:00 |
| G | Week Number | 4th |
| H | Day Number | day 2 |
| I | Zoom Link | https://zoom.us/j/... |
| J | Passcode | d2cx |
| K | Feedback Form Link | https://forms.gle/... |

## Setup

### 1. Install
npm install

### 2. Google Sheets API
1. Go to console.cloud.google.com
2. Create project → enable Google Sheets API
3. IAM & Admin → Service Accounts → Create → download JSON key
4. Rename to service-account.json and place in this folder
5. Share your Google Sheet with the service account email (Viewer access)

### 3. Edit .env
SPREADSHEET_ID = the long ID from your sheet URL
WHATSAPP_GROUP_NAME = exact name of your WhatsApp group

### 4. Run
node index.js

Scan the QR code with WhatsApp on first run. Done.

## Keep it running 24/7 (PM2)
npm install -g pm2
pm2 start index.js --name d2cx-scheduler
pm2 save
pm2 startup

## Notes
- Sheet is re-checked every hour — add new sessions anytime, no restart needed
- Won't send duplicate messages
- If WhatsApp disconnects, restart the app and re-scan QR
