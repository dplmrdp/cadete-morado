// scripts/update_calendars.js
// Node.js script to scrape FAVoley + IMD pages with Puppeteer and generate two .ics files.
// Produces ./calendarios/imd.ics and ./calendarios/federado.ics
//
// Usage: node scripts/update_calendars.js
//
// Notes:
// - Designed to run in GitHub Actions (Linux).
// - If a selector stops working, adjust the DOM selectors in the extract* functions.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// CONFIG
const OUTPUT_DIR = 'calendarios';
const TEAM_SHORT = 'FLORES MORADO';

// URLs (from you)
const FAVOLEY_CALENDAR = 'https://favoley.es/es/tournament/1321417/calendar/3652130/all';
const IMD_CALENDAR = 'https://imd.sevilla.org/app/jjddmm_resultados/';

// Helper to ensure output dir
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Utility: format datetime to ICS timestamp (YYYYMMDDTHHMMSS)
function toICSDateTime(date) {
  function pad(n){return n<10?'0'+n:''+n;}
  return date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate())+'T'+pad(date.getHours())+pad(date.getMinutes())+pad(date.getSeconds());
}

// Utility: format DATE (YYYYMMDD)
function toICSDate(date){
  function pad(n){return n<10?'0'+n:''+n;}
  return date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate());
}

// Build VEVENT for timed event
function buildTimedEvent(startDate, summary, location){
  const dtstart = toICSDateTime(startDate);
  // default duration 2 hours (user can edit later); adjust if needed
  const endDate = new Date(startDate.getTime() + 1000*60*60*2);
  const dtend = toICSDateTime(endDate);
  return [
    'BEGIN:VEVENT',
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location || 'Lugar por confirmar'}`,
    'END:VEVENT'
  ].join('\n') + '\n';
}

// Build VEVENT for all-day range (DTSTART;VALUE=DATE ... DTEND;VALUE=DATE)
function buildAllDayEvent(startDate, endDate, summary, location){
  // ICS DTEND is exclusive -> set to day after the end
  const dtstart = toICSDate(startDate);
  const dtend = toICSDate(new Date(endDate.getTime() + 24*60*60*1000));
  return [
    'BEGIN:VEVENT',
    `DTSTART;VALUE=DATE:${dtstart}`,
    `DTEND;VALUE=DATE:${dtend}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location || 'Lugar por confirmar'}`,
    'END:VEVENT'
  ].join('\n') + '\n';
}

// Main extraction functions
async function extractFromFavoley(page) {
  // Navigate and wait for rendering
  await page.goto(FAVOLEY_CALENDAR, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait additional time to ensure JS-built calendar loads
  await page.waitForTimeout(1500);

  // Evaluate in page context and return array of matches
  // Each match: {start: Date OR null, end: Date OR null, dateStr: string, home: string, away: string, location: string|null}
  const matches = await page.evaluate(() => {
    // Generic approach: find visible text blocks that resemble match rows
    // Clupik / Favoley tends to render calendar as tables or lists; we'll search for rows that contain team names.
    const rows = [];
    // Try common selectors
    const possibleTables = Array.from(document.querySelectorAll('table, .calendar, .calendar-list, .list-jornadas, .panel-body'));
    if(possibleTables.length === 0){
      // fallback: take all <tr> and try parse text
      possibleTables.push(...Array.from(document.querySelectorAll('tr')));
    }
    // Collect text nodes
    const texts = [];
    possibleTables.forEach(t => {
      texts.push(t.innerText.trim());
    });
    const big = texts.join('\\n---\\n');
    // Heuristic parser: search for lines containing "FLORES" or common team tokens and parse nearby tokens
    // (Because DOM structures vary, actually parsing DOM on server is better. Client side we return the big text and hope Node side refines)
    return { raw: big };
  });

  // If we didn't get structured matches, parse 'matches.raw' for FLORES occurrences
  const raw = matches.raw || '';
  const events = [];

  // Heuristic: split into blocks by 'Jornada' or 'Calendario' markers
  const blocks = raw.split(/Jornada|Calendario|\\n\\s*\\n/gi).filter(b => /FLORES|Flores|FLORES MORADO/i.test(b));
  for(const b of blocks){
    // Find lines with our team
    const lines = b.split('\\n').map(s => s.trim()).filter(Boolean);
    for(const line of lines){
      // Example line patterns vary. We attempt to detect lines that contain 'FLORES' and another team
      if(/FLORES/i.test(line)){
        // attempt to extract [date] and [teams]
        // common patterns: "DATE ... TEAM1 vs TEAM2 ... LUGAR"
        // Use very permissive regex to capture date-like fragments (dd/mm/yyyy or dd/mm/yy)
        const dateMatch = b.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/);
        let date = null;
        if(dateMatch) date = dateMatch[1];
        // find team pair
        const teamLine = line.replace(/\\s{2,}/g,' ').replace(/\\t/g,' ');
        // split by common separators
        const sep = [' - ', ' – ', ' vs ', ' VS ', ' vs. ', '–', 'VS', 'V', ' v '];
        let homeAway = null;
        for(const s of sep){
          if(teamLine.includes(s)){
            homeAway = teamLine.split(s).map(x=>x.trim());
            break;
          }
        }
        if(!homeAway){
          // fallback split by two capital words sequences
          const parts = teamLine.split(/\s{2,}/);
          if(parts.length >= 2) homeAway = [parts[0], parts[1]];
        }
        if(homeAway && homeAway.length >= 2){
          // determine if has time like HH:MM
          const timeMatch = b.match(/(\\d{1,2}:\\d{2})/);
          const time = timeMatch ? timeMatch[1] : null;
          // build object
          events.push({
            dateText: date,
            timeText: time,
            home: homeAway[0],
            away: homeAway[1],
            location: null
          });
        } else {
          // may be weekend-block only listing -> try find "Fin de semana" range
          // search for patterns like dd/mm - dd/mm or "17/10/25 – 19/10/25"
          const rangeMatch = b.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})\\s*[-–]\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/);
          if(rangeMatch){
            events.push({
              dateText: rangeMatch[1],
              endDateText: rangeMatch[2],
              timeText: null,
              home: null,
              away: 'FLORES MORADO',
              location: null,
              weekendRange: true
            });
          }
        }
      }
    }
  }

  // Return heuristic events (may be empty if structure differs)
  return events;
}

async function extractFromIMD(page) {
  await page.goto(IMD_CALENDAR, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForTimeout(1500);

  // Try to find JSON data or DOM table of matches
  const result = await page.evaluate(() => {
    // Try known patterns: tables with class 'table' or 'resultados' etc.
    const text = document.body.innerText || '';
    return { raw: text };
  });

  const raw = result.raw || '';
  const events = [];

  // Heuristic parsing: find lines containing FLORES MORADO and date/time
  const lines = raw.split('\\n').map(l=>l.trim()).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    const l = lines[i];
    if(/FLORES MORADO/i.test(l) || /CD LAS FLORES SEVILLA MORADO/i.test(l)){
      // attempt to grab surrounding lines for date/time and opponent/location
      // look back/forward 3 lines
      const windowLines = lines.slice(Math.max(0,i-4), i+4).join(' | ');
      // date
      const dateMatch = windowLines.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/);
      const timeMatch = windowLines.match(/(\\d{1,2}:\\d{2})/);
      // opponent: other team name in the same window
      // try to extract pattern "TEAM A  -  TEAM B" or "TEAM A vs TEAM B"
      const vsMatch = windowLines.match(/(.{2,60})\\s+(?:-|–|vs|VS|v)\\s+(.{2,60})/);
      let home=null, away=null;
      if(vsMatch){
        home = vsMatch[1].trim();
        away = vsMatch[2].trim();
      } else {
        // fallback: the matching line itself may contain both teams
        const parts = l.split(/-|–|vs|VS|v/);
        if(parts.length>=2){
          home=parts[0].trim(); away=parts[1].trim();
        } else {
          // fallback: find nearest uppercase team strings
          const possible = windowLines.match(/[A-ZÑÁÉÍÓÚ0-9\\s]{4,50}/g);
          if(possible && possible.length>=2){
            home = possible[0].trim(); away = possible[1].trim();
          }
        }
      }
      events.push({
        dateText: dateMatch ? dateMatch[1] : null,
        timeText: timeMatch ? timeMatch[1] : null,
        home: home,
        away: away,
        location: null
      });
    }
  }

  return events;
}

// Normalize names to short forms (YOU CAN EXTEND THIS MAP)
function normalizeTeam(name) {
  if(!name) return null;
  name = name.toUpperCase().replace(/\\s+/g,' ').trim();
  const map = {
    'CD LAS FLORES SEVILLA MORADO': 'FLORES MORADO',
    'CD LAS FLORES SEVILLA AMARILLO': 'FLORES AMARILLO',
    'ROCHELAMBERT C.V': 'ROCHELA',
    'PALESTRA CLUB VOLEIBOL A': 'PALESTRA A',
    'CONDEQUINTO A': 'CONDEQUINTO A',
    'CD ARBOLEDA': 'ARBOLEDA',
    'CLUB VOLEIBOL ALCALÁ SA': 'ALCALÁ SA'
  };
  // try exact match first
  if(map[name]) return map[name];
  // try contains
  for(const k of Object.keys(map)){
    if(name.includes(k)) return map[k];
  }
  // else return trimmed title-case-ish
  return name.replace(/\\s{2,}/g,' ').trim();
}

// Build ICS file wrapper
function buildCalendar(events, prodid){
  let ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:${prodid}\n`;
  for(const ev of events){
    if(ev.timeText && ev.dateText){
      // parse date and time dd/mm/yyyy and HH:MM
      const parts = ev.dateText.split('/');
      if(parts.length===3){
        const day = parseInt(parts[0],10), month = parseInt(parts[1],10)-1, year = parseInt(parts[2],10);
        // accept yy or yyyy
        const y = year < 100 ? (2000 + year) : year;
        const hhmm = ev.timeText.split(':');
        const hour = parseInt(hhmm[0],10), min = parseInt(hhmm[1],10);
        const dt = new Date(y, month, day, hour, min, 0);
        const summary = `${normalizeTeam(ev.home)} vs ${normalizeTeam(ev.away)}`;
        ics += buildTimedEvent(dt, summary, ev.location || 'Lugar por confirmar');
      }
    } else if(ev.weekendRange || (ev.dateText && ev.endDateText)) {
      // weekend block: parse range
      const p1 = ev.dateText.split('/'), p2 = ev.endDateText.split('/');
      const y1 = parseInt(p1[2],10) < 100 ? 2000 + parseInt(p1[2],10) : parseInt(p1[2],10);
      const y2 = parseInt(p2[2],10) < 100 ? 2000 + parseInt(p2[2],10) : parseInt(p2[2],10);
      const start = new Date(y1, parseInt(p1[1],10)-1, parseInt(p1[0],10));
      const end = new Date(y2, parseInt(p2[1],10)-1, parseInt(p2[0],10));
      const summary = `${normalizeTeam(ev.home || ev.away)} vs ${normalizeTeam(ev.away || ev.home)}`;
      ics += buildAllDayEvent(start, end, summary, ev.location || 'Por confirmar');
    } else if(ev.dateText && !ev.timeText){
      // single date but no time -> treat as whole weekend (Fri-Sun) if close to a weekend date
      const p = ev.dateText.split('/');
      const y = parseInt(p[2],10) < 100 ? 2000 + parseInt(p[2],10) : parseInt(p[2],10);
      const start = new Date(y, parseInt(p[1],10)-1, parseInt(p[0],10));
      // make block fri-sun that includes that date
      // find the friday of that week
      const day = start.getDay(); // 0 Sun ... 6 Sat
      // compute friday (5)
      // compute date for Friday before or same week
      const friday = new Date(start);
      const diffToFriday = (5 - day);
      friday.setDate(start.getDate() + diffToFriday);
      // If that gives negative shift >3 etc, just use date.. simpler: use start..end = start .. start+2
      const end = new Date(start.getTime() + 2*24*60*60*1000);
      const summary = `${normalizeTeam(ev.home || ev.away)} vs ${normalizeTeam(ev.away || ev.home)}`;
      ics += buildAllDayEvent(start, end, summary, ev.location || 'Por confirmar');
    }
  }
  ics += 'END:VCALENDAR\n';
  return ics;
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  // FEDERADO extraction
  console.log('Scraping FAVoley...');
  let fedEvents = [];
  try {
    const rawFed = await extractFromFavoley(page);
    // rawFed is array of event objects from evaluate -> handled above
    fedEvents = rawFed; // may be empty; script will still write a calendar (useful for debugging)
    console.log('FAVoley events found:', fedEvents.length);
  } catch (e) {
    console.error('Error extracting from FAVoley:', e);
  }

  // IMD extraction
  console.log('Scraping IMD...');
  let imdEvents = [];
  try {
    const rawImd = await extractFromIMD(page);
    imdEvents = rawImd;
    console.log('IMD events found:', imdEvents.length);
  } catch (e) {
    console.error('Error extracting from IMD:', e);
  }

  await browser.close();

  // Build ICS strings
  const imdIcs = buildCalendar(imdEvents, '-//FLORES MORADO//IMD//ES');
  const fedIcs = buildCalendar(fedEvents, '-//FLORES MORADO//FEDERADO//ES');

  // Write files
  fs.writeFileSync(path.join(OUTPUT_DIR,'imd.ics'), imdIcs, 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR,'federado.ics'), fedIcs, 'utf8');

  console.log('Wrote', OUTPUT_DIR + '/imd.ics', OUTPUT_DIR + '/federado.ics');
})();
