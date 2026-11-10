/* Teacher preferences - a static page against one Apps Script endpoint.
 *
 * Deliberately a mirror of Spoi's own TeacherRequest.html: weeks are
 * toggle buttons, and a slot cycles neutral -> "hentar ekki" -> "hentar
 * vel" -> neutral. A teacher who has used one should not have to learn
 * the other. Rooms use the same cycle, which is the whole reason this
 * exists outside Google Forms: Forms cannot vary a question's options by
 * a previous answer, so it could never show a course its own rooms.
 *
 * No build step and no dependencies - GitHub Pages serves these three
 * files as they are.
 */
'use strict';

const CONFIG = {
  // Apps Script web app, deployed "Execute as: Me" / "Anyone".
  apiUrl: 'https://script.google.com/macros/s/AKfycbzgHtN6imSwNb9QPJBMKMC7IonETyfbCZ3vAyGTyfBg3DiqW5Ls5Ocm4zsRT-WN1hW9/exec',

  schools: [
    { value: 'von', label: 'VoN - Verkfræði- og náttúruvísindasvið',
      en: 'VoN - School of Engineering and Natural Sciences' },
    { value: 'fvs', label: 'FVS - Félagsvísindasvið', en: 'FVS - School of Social Sciences' },
    { value: 'hug', label: 'HUG - Hugvísindasvið', en: 'HUG - School of Humanities' },
    { value: 'mvs', label: 'MVS - Menntavísindasvið', en: 'MVS - School of Education' },
    { value: 'hvs', label: 'HVS - Heilbrigðisvísindasvið', en: 'HVS - School of Health Sciences' }
  ],

  // ISO weeks, per semester. The selected term picks the range, and
  // ?weeks=2-16 still overrides both.
  // ISO rather than teaching weeks 1-14 on purpose: programmes start in
  // different weeks, so "week 3" means a different date per programme
  // while week 34 is the same Monday for everyone. The cost is that the
  // number is unfamiliar, which is why every button carries its date.
  weeks: { from: 34, to: 47 },
  weeksBySemester: { H: { from: 34, to: 47 }, V: { from: 2, to: 16 }, S: { from: 22, to: 30 } },
  // The year comes from the selected term where there is one, and is
  // guessed from the week range otherwise - see resolveYear.

  // Slot 0 starts 08:20 and each slot is 50 minutes - the same constants
  // Spoi uses (SLOT_ZERO_START_MINUTES / SLOT_STEP_MINUTES, Code.js), so
  // the tokens produced here ("mán-0") are the ones Spoi already speaks.
  slotZeroStartMinutes: 8 * 60 + 20,
  slotStepMinutes: 50,
  firstSlot: 0,
  lastSlot: 8,

  // token is what is sent and never changes with the page's language.
  days: [
    { token: 'mán', label: 'Mán', en: 'Mon' },
    { token: 'þri', label: 'Þri', en: 'Tue' },
    { token: 'mið', label: 'Mið', en: 'Wed' },
    { token: 'fim', label: 'Fim', en: 'Thu' },
    { token: 'fös', label: 'Fös', en: 'Fri' }
  ],

  // No caps on how many rooms or times a teacher marks: an answer is a
  // wish the administrator reviews and completes in Spoi, and Besta
  // treats a "hentar ekki" time as costly, not forbidden. (Earlier: at
  // most 3 rooms "hentar vel", 5 times "hentar ekki", and 5 rooms had to
  // remain usable.)
};

// course_id -> its catalog rows, filled by the one GET below.
const catalog = new Map();
// room_id -> room row, every room in the school. The catalog GET already
// returns every row, so searching outside a course's own list costs no
// extra request - only a second index over data already in memory.
const allRooms = new Map();
// Rooms the teacher searched for and added, which are NOT on this
// course's own list. Kept apart so they can be shown as such: the prefill
// did not propose them, and that is worth seeing.
const extraRooms = new Set();

// Every catalog row the school returned, across all its terms, kept so
// that switching term re-filters in memory instead of re-fetching.
let catalogRows = [];

const state = {
  weeks: new Set(),
  // "mán-0" -> 'prefer' | 'avoid'
  slots: new Map(),
  // room_id -> 'prefer' | 'avoid'
  rooms: new Map(),
  // { year, semester } - which term these wishes are FOR. A school can
  // be planning two at once (VON: haust 2026 running, vor 2027 being
  // built), and a wish that does not name its term gets imported into
  // both, describing courses the other term does not teach. Null until
  // the catalog has been read, since the catalog is what says which
  // terms exist.
  term: null,
  // Initials of the course's registered teachers the respondent unticked:
  // "does not teach this term". Every teacher starts ticked.
  notTeaching: new Set(),
  // label -> session types ticked for that teacher by hand. Absent means
  // "the course's own types", the default for a ticked teacher.
  typesOn: new Map(),
  // The courses the typed kennitala is registered on this term, as
  // { school, course_id }, or null when it is not known yet. Fetched one
  // kennitala at a time (POST my_courses); the page never holds a list of
  // anyone else's. myCoursesEnforced is false for a term the lookup has
  // no data for, and every course is offered as before.
  myCourses: null,
  myCoursesEnforced: true,
  myCoursesError: ''
};

const el = (id) => document.getElementById(id);

/* ---------- language ---------------------------------------------- */

// Icelandic unless ?lang=en, or the switch in the header (remembered in
// this browser), asks for English. Only what the page SHOWS changes: what
// it sends - day tokens, session-type codes, room ids, the teacher's own
// words - is the same in both, so the office reads one kind of answer.
// The script's own error replies stay Icelandic.
// The site's own key (assets/site.js), so a language chosen on the front
// page carries over here and back.
const LANG_KEY = 'spoi-lang';

function initialLang() {
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked === 'en' || asked === 'is') return asked;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'is') return saved;
  } catch (error) { /* storage blocked: Icelandic */ }
  return 'is';
}

let lang = initialLang();
const tr = (is, en) => (lang === 'en' ? en : is);
const dayLabel = (day) => (lang === 'en' ? day.en : day.label);

// "V", "v", "vor" all name one semester; the query string is typed by a
// person and the sheet is filled in by another, so neither is guaranteed
// to be the bare letter this compares on.
const semesterLetter = (value) => {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  return text ? text.charAt(0) : '';
};

/* What a term is CALLED, as a teacher would say it.
 *
 * Fall-anchored again: year 2026 semester V is "Vor 2027". Labelling it
 * "Vor 2026" would name a term that ended months ago, and a teacher
 * checking they are answering for the right one would see the wrong
 * answer at the very moment they were trying to verify it.
 */
function termLabel(term) {
  if (!term || !term.year) return '';
  const year = Number(term.year);
  const names = lang === 'en'
    ? { H: 'Autumn', V: 'Spring', S: 'Summer' }
    : { H: 'Haust', V: 'Vor', S: 'Sumar' };
  const name = names[term.semester] || term.semester;
  return name + ' ' + (term.semester === 'H' ? year : year + 1);
}

const sameTerm = (a, b) =>
  !!a && !!b && String(a.year) === String(b.year) && a.semester === b.semester;

// ?year=2026&semester=V, the way ?school= already works: the link an
// administrator sends decides, so the teacher does not have to.
function termFromQuery() {
  const params = new URLSearchParams(location.search);
  const year = String(params.get('year') || '').trim();
  const semester = semesterLetter(params.get('semester'));
  return year && semester ? { year: year, semester: semester } : null;
}

// The terms the catalog holds, newest first - haust before vor WITHIN a
// year, because the year is fall-anchored.
function termsInRows(rows) {
  const rank = { H: 0, V: 1, S: 2 };
  const seen = new Map();
  rows.forEach((row) => {
    const year = String(row.year || '').trim();
    const semester = semesterLetter(row.semester);
    if (!year || !semester) return;
    const key = year + semester;
    if (!seen.has(key)) seen.set(key, { year: year, semester: semester });
  });
  return Array.from(seen.values()).sort((a, b) =>
    (Number(b.year) - Number(a.year))
    || ((rank[b.semester] ?? 9) - (rank[a.semester] ?? 9)));
}

/* ---------- helpers ---------------------------------------------- */

function slotLabel(slot) {
  const total = CONFIG.slotZeroStartMinutes + slot * CONFIG.slotStepMinutes;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return hh + ':' + mm;
}

function weekRangeFromQuery() {
  const raw = new URLSearchParams(location.search).get('weeks');
  const match = raw && raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (match) return { from: Number(match[1]), to: Number(match[2]) };
  // Otherwise the semester decides: autumn and spring do not share weeks,
  // and offering a spring course weeks 34-47 asks about dates its term
  // does not contain.
  const semester = state.term && state.term.semester;
  return (semester && CONFIG.weeksBySemester[semester]) || CONFIG.weeks;
}

/* Which year's weeks these are.
 *
 * "This year" is wrong half the time: wishes are collected months before
 * the term they describe, so spring weeks 2-16 gathered in autumn belong
 * to NEXT year, and showing this year's dates would be a year out - the
 * exact mistake the dates were added to prevent.
 *
 * So the range picks its own year: whichever one it has not finished in
 * yet. Autumn 34-47 read in September resolves to this year (week 47 is
 * still ahead); read in December it rolls to next year, because this
 * year's term is over and the only wishes anyone can still submit are for
 * the next one. Spring 2-16 read at any point after April rolls the same
 * way. Nothing to update annually, and nothing to forget.
 */
function resolveYear(range, today) {
  const now = today || new Date();
  const thisYear = now.getUTCFullYear();
  // End of the range's last week, not its Monday: a term in progress must
  // not jump forward while it is still running.
  const endOfRange = mondayOfIsoWeek(thisYear, range.to).getTime() + 7 * 86400000;
  return endOfRange < now.getTime() ? thisYear + 1 : thisYear;
}

/* The calendar year the week buttons should show dates from.
 *
 * A known term answers this outright, and answers it correctly: Spoi
 * counts academic years fall-anchored, so vor 2027 is year 2026 semester
 * V, and the calendar year its weeks fall in is one MORE than the year
 * the term is filed under. Getting that backwards would date every spring
 * button a year early - the exact error the dates were added to prevent.
 *
 * resolveYear's guess stays as the fallback, for a catalog written before
 * it carried terms at all.
 */
function calendarYearForWeeks() {
  const term = state.term;
  if (term && term.year) {
    const year = Number(term.year);
    if (year >= 2000 && year <= 2100) return term.semester === 'H' ? year : year + 1;
  }
  return resolveYear(weekRangeFromQuery());
}

// Monday of an ISO week. ISO week 1 is the one containing 4 January, so
// that date is the anchor everything else counts from.
function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // getUTCDay() is 0 for Sunday; ISO counts Monday as day 1.
  const isoDay = jan4.getUTCDay() || 7;
  const mondayOfWeek1 = Date.UTC(year, 0, 4 - (isoDay - 1));
  return new Date(mondayOfWeek1 + (week - 1) * 7 * 86400000);
}

const MONTHS_IS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí',
                   'ágúst', 'september', 'október', 'nóvember', 'desember'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                   'August', 'September', 'October', 'November', 'December'];

function shortDate(date) {
  return lang === 'en'
    ? date.getUTCDate() + '/' + (date.getUTCMonth() + 1)
    : date.getUTCDate() + '.' + (date.getUTCMonth() + 1) + '.';
}

function longDate(date) {
  return lang === 'en'
    ? date.getUTCDate() + ' ' + MONTHS_EN[date.getUTCMonth()]
    : date.getUTCDate() + '. ' + MONTHS_IS[date.getUTCMonth()];
}

// "Vika 34 hefst mánudaginn 17. ágúst" / "Week 34 starts on Monday 17 August".
function weekStartsText(week, monday) {
  return tr('Vika ' + week + ' hefst mánudaginn ', 'Week ' + week + ' starts on Monday ')
    + longDate(monday);
}

function setStatus(message, kind) {
  const node = el('status');
  node.textContent = message || '';
  node.className = 'status' + (kind ? ' ' + kind : '');
}

// Cycles neutral -> prefer -> avoid -> neutral. The positive answer comes
// first because a click is read as "I want this": landing on "hentar
// ekki" from one tap on a room you just went and searched for reverses
// what you asked for, and a teacher correcting that has to click twice
// more to escape.
//
// A refused step CLEARS the mark rather than doing nothing, and returns
// false so the caller can say why. Doing nothing would strand the button:
// a room stuck on "hentar vel" whose next step is capped would retry that
// same capped step on every further click and could never be reset. Every
// click must move, or the cycle is a trap.
function cycle(map, key, capPrefer, capAvoid) {
  const current = map.get(key);
  if (!current) {
    if (capPrefer != null && countOf(map, 'prefer') >= capPrefer) return false;
    map.set(key, 'prefer');
  } else if (current === 'prefer') {
    if (capAvoid != null && countOf(map, 'avoid') >= capAvoid) {
      map.delete(key);
      return false;
    }
    map.set(key, 'avoid');
  } else {
    map.delete(key);
  }
  return true;
}

function countOf(map, value) {
  let n = 0;
  map.forEach((v) => { if (v === value) n++; });
  return n;
}

function keysWith(map, value) {
  const out = [];
  map.forEach((v, k) => { if (v === value) out.push(k); });
  return out;
}

/* ---------- rendering -------------------------------------------- */

function renderSchools() {
  const select = el('school');
  // Redrawn when the language changes: the school already chosen stays.
  const current = select.value;
  select.innerHTML = '';
  CONFIG.schools.forEach((school) => {
    const option = document.createElement('option');
    option.value = school.value;
    option.textContent = lang === 'en' ? school.en : school.label;
    select.appendChild(option);
  });
  const preset = current || new URLSearchParams(location.search).get('school');
  if (preset) select.value = preset;
}

// Every week of the term, the default: a teacher narrows it only when the
// course really is not taught all term.
function selectAllWeeks() {
  const range = weekRangeFromQuery();
  state.weeks.clear();
  for (let week = range.from; week <= range.to; week++) state.weeks.add(week);
}

// All of the term's weeks ticked says nothing, so it is sent as none: an
// answer then carries a week wish only when the teacher made one.
function chosenWeeks() {
  const range = weekRangeFromQuery();
  const weeks = Array.from(state.weeks).sort((a, b) => a - b);
  return weeks.length === range.to - range.from + 1 ? [] : weeks;
}

function weekRangeText(range) {
  return range.from + '-' + range.to;
}

// Teachers count teaching weeks (1-14); the plan and the proposals use
// calendar weeks. Under the editor's week box: where to read which dates
// a week number is, with the term's first week as an example.
function calendarWeeksHint() {
  const range = weekRangeFromQuery();
  const hint = document.createElement('p');
  hint.className = 'hint plan-weeks-hint';
  const link = document.createElement('a');
  link.href = '#weeksCard';
  link.textContent = tr('3. Vikur', '3. Weeks');
  const start = weekStartsText(range.from, mondayOfIsoWeek(calendarYearForWeeks(), range.from));
  if (lang === 'en') {
    hint.append('Calendar weeks, not teaching weeks: ' + start.charAt(0).toLowerCase() + start.slice(1)
      + '. ', link, ' below shows the date of every week.');
  } else {
    hint.append('Almanaksvikur, ekki kennsluvikur: ' + start.charAt(0).toLowerCase() + start.slice(1)
      + '. Í ', link, ' hér fyrir neðan sést dagsetning hverrar viku.');
  }
  return hint;
}

function renderWeeks() {
  const range = weekRangeFromQuery();
  const year = calendarYearForWeeks();
  const target = el('weekGrid');
  target.innerHTML = '';
  for (let week = range.from; week <= range.to; week++) {
    const monday = mondayOfIsoWeek(year, week);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'week-btn' + (state.weeks.has(week) ? ' selected' : '');

    // Number and date together. A teacher counts teaching weeks 1-14, so
    // a bare "34" invites reading it as the 34th week of teaching; the
    // Monday underneath is what makes it unambiguous without a paragraph
    // of explanation.
    const number = document.createElement('span');
    number.className = 'week-no';
    number.textContent = week;
    const date = document.createElement('span');
    date.className = 'week-date';
    date.textContent = shortDate(monday);
    button.append(number, date);
    button.title = weekStartsText(week, monday);

    button.onclick = () => {
      if (state.weeks.has(week)) state.weeks.delete(week);
      else state.weeks.add(week);
      renderWeeks();
      renderSummary();
    };
    target.appendChild(button);
  }

  el('weekAnchor').textContent =
    tr('Almanaksvikur (ekki kennsluvikur). ', 'Calendar weeks (not teaching weeks). ')
    + weekStartsText(range.from, mondayOfIsoWeek(year, range.from)) + '.';
}

function renderSlots() {
  const target = el('slotGrid');
  target.innerHTML = '';

  target.appendChild(document.createElement('div')); // empty corner
  CONFIG.days.forEach((day) => {
    const head = document.createElement('div');
    head.className = 'slot-head';
    head.textContent = dayLabel(day);
    target.appendChild(head);
  });

  for (let slot = CONFIG.firstSlot; slot <= CONFIG.lastSlot; slot++) {
    const time = document.createElement('div');
    time.className = 'slot-time';
    time.textContent = slotLabel(slot);
    target.appendChild(time);

    CONFIG.days.forEach((day) => {
      const token = day.token + '-' + slot;
      const value = state.slots.get(token);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slot-btn'
        + (value === 'prefer' ? ' preferred' : '')
        + (value === 'avoid' ? ' blocked' : '');
      button.textContent = value === 'prefer' ? tr('Hentar', 'Suits')
        : (value === 'avoid' ? tr('Ekki', 'Not') : '');
      button.title = dayLabel(day) + ' ' + slotLabel(slot);
      button.onclick = () => {
        cycle(state.slots, token, null, null);
        setStatus('');
        renderSlots();
        renderSummary();
      };
      target.appendChild(button);
    });
  }
}

// Folded so a teacher can type on any keyboard: "idn" finds IÐN508M and
// "arnagardur" finds Árnagarður. Matches the folding normalize_room_key
// does on the Python side - letters are folded, never dropped, or "Oddi"
// and "Óðinn" would collapse onto each other.
const FOLD = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ý: 'y',
               ð: 'd', þ: 'th', æ: 'ae', ö: 'o' };

function fold(value) {
  return String(value == null ? '' : value).toLowerCase()
    .replace(/[áéíóúýðþæö]/g, (ch) => FOLD[ch]);
}

// --- course combobox --------------------------------------------------
// A <select> of 196 courses is a scroll, not a choice. The select is
// still the value; this only makes it findable by typing.
const COURSE_RESULT_LIMIT = 12;
let courseMatches = [];
let courseCursor = -1;

function courseLabel(courseId) {
  const first = (catalog.get(courseId) || [])[0] || {};
  return courseId + (first.course_name ? ' — ' + first.course_name : '');
}

function renderCourseResults(open) {
  const box = el('courseSearch');
  const list = el('courseResults');
  const query = fold(box.value.trim());
  list.innerHTML = '';

  // A query that exactly matches the chosen course means the teacher is
  // looking at their own selection, not searching - so stay closed.
  const selected = el('course').value;
  if (open === false || (selected && box.value === courseLabel(selected))) {
    courseMatches = [];
    courseCursor = -1;
    list.hidden = true;
    box.setAttribute('aria-expanded', 'false');
    return;
  }

  courseMatches = visibleCourseIds()
    .filter((courseId) => !query || fold(courseLabel(courseId)).indexOf(query) >= 0)
    .sort()
    .slice(0, COURSE_RESULT_LIMIT);
  courseCursor = -1;

  if (courseMatches.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'combo-empty';
    empty.textContent = !catalog.size
      ? tr('Engin námskeið skráð fyrir þetta svið enn.', 'No courses listed for this school yet.')
      : (visibleCourseIds().length ? tr('Ekkert námskeið fannst.', 'No course found.') : courseHintText());
    list.appendChild(empty);
  } else {
    courseMatches.forEach((courseId, index) => {
      const item = document.createElement('li');
      item.className = 'combo-item';
      item.setAttribute('role', 'option');
      item.textContent = courseLabel(courseId);
      // mousedown, not click: blur would close the list first.
      item.onmousedown = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        pickCourse(courseId);
      };
      item.onclick = () => pickCourse(courseId);
      item.dataset.index = String(index);
      list.appendChild(item);
    });
  }
  list.hidden = false;
  box.setAttribute('aria-expanded', 'true');
}

// The kennitala's own courses in this school and term - or every course,
// when the lookup has no data for the term. Nothing before the lookup has
// answered: a list of every course would invite answering for one the
// teacher does not teach.
function visibleCourseIds() {
  if (state.myCourses === null) return [];
  const all = Array.from(catalog.keys());
  if (!state.myCoursesEnforced) return all;
  const school = el('school').value.toLowerCase();
  const mine = new Set(state.myCourses
    .filter((c) => !c.school || c.school.toLowerCase() === school)
    .map((c) => c.course_id));
  return all.filter((courseId) => mine.has(courseId));
}

function courseHintText() {
  const en = lang === 'en';
  const forTerm = state.term
    ? (en ? ' for ' : ' á ') + termLabel(state.term).toLowerCase() : '';
  if (!catalog.size) {
    return en ? 'No courses listed for this school' + forTerm + ' yet.'
      : 'Engin námskeið skráð fyrir þetta svið' + forTerm + ' enn.';
  }
  if (state.myCoursesError) {
    return en ? 'Error: could not fetch your courses (' + state.myCoursesError + ').'
      : 'Villa: Tókst ekki að sækja námskeiðin þín (' + state.myCoursesError + ').';
  }
  if (state.myCourses === null) {
    if (validSsn()) return tr('Sæki námskeiðin þín…', 'Fetching your courses…');
    return tr('Sláðu inn kennitölu til að sjá námskeiðin þín.',
      'Type your kennitala to see your courses.');
  }
  const count = visibleCourseIds().length;
  if (!state.myCoursesEnforced) {
    return en ? count + (count === 1 ? ' course' : ' courses') + ' offered for this school' + forTerm + '.'
      : count + ' námskeið í boði fyrir þetta svið' + forTerm + '.';
  }
  if (count) {
    return en ? 'You are registered on ' + count + (count === 1 ? ' course' : ' courses') + forTerm
        + ' in this school.'
      : 'Þú ert skráð/ur á ' + count + ' námskeið' + forTerm + ' á þessu sviði.';
  }
  const school = el('school').value.toLowerCase();
  const elsewhere = Array.from(new Set(state.myCourses
    .map((c) => String(c.school || '').toUpperCase())
    .filter((name) => name && name.toLowerCase() !== school)));
  if (en) {
    return elsewhere.length
      ? 'You are not registered on a course in this school' + forTerm + ', but in '
        + elsewhere.join(', ') + '. Choose that school above.'
      : 'You are not registered as a teacher on any course' + forTerm
        + '. Contact your school\'s office to be registered in Ugla.';
  }
  return elsewhere.length
    ? 'Þú ert ekki skráð/ur á námskeið á þessu sviði' + forTerm + ', en á ' + elsewhere.join(', ')
      + '. Veldu það svið hér að ofan.'
    : 'Þú ert ekki skráð/ur kennari á námskeið' + forTerm
      + '. Hafðu samband við skrifstofu sviðsins til að fá skráningu í Uglu.';
}

function renderCourseHint() {
  el('courseHint').textContent = courseHintText();
  // A course chosen before the kennitala changed may not be this
  // teacher's; it is dropped rather than answered for.
  const selected = el('course').value;
  if (selected && visibleCourseIds().indexOf(selected) < 0) {
    el('course').value = '';
    el('courseSearch').value = '';
    onCourseChange();
  }
}

function validSsn() {
  return /^\d{10}$/.test(el('ssn').value.replace(/[\s-]/g, ''));
}

let myCoursesRequest = 0;
async function loadMyCourses() {
  const request = ++myCoursesRequest;
  state.myCourses = null;
  state.myCoursesEnforced = true;
  state.myCoursesError = '';
  renderCourseHint();
  if (!validSsn() || !state.term) return;
  try {
    // POST, so the kennitala is not in a URL. text/plain for the same
    // reason as submit(): no CORS preflight.
    const response = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'my_courses',
        teacher_ssn: el('ssn').value.replace(/[\s-]/g, ''),
        year: state.term.year,
        semester: state.term.semester
      })
    });
    const body = await response.json();
    if (request !== myCoursesRequest) return;  // a newer kennitala or term won
    if (!body.ok) throw new Error(body.error || tr('Óþekkt villa', 'Unknown error'));
    // A script deployed before this lookup existed answers as if it were a
    // wish; without "enforced" in the reply, nothing is filtered.
    state.myCoursesEnforced = body.enforced !== false && Array.isArray(body.courses);
    state.myCourses = Array.isArray(body.courses) ? body.courses : [];
  } catch (error) {
    if (request !== myCoursesRequest) return;
    state.myCoursesError = error.message;
  }
  renderCourseHint();
}

function highlightCourse(next) {
  if (courseMatches.length === 0) return;
  const items = Array.from(el('courseResults').children);
  courseCursor = (next + courseMatches.length) % courseMatches.length;
  items.forEach((item, index) => {
    item.className = 'combo-item' + (index === courseCursor ? ' active' : '');
  });
}

function onCourseKeydown(event) {
  const key = event && event.key;
  if (key === 'ArrowDown') { highlightCourse(courseCursor + 1); event.preventDefault(); }
  else if (key === 'ArrowUp') { highlightCourse(courseCursor - 1); event.preventDefault(); }
  else if (key === 'Enter') {
    // With nothing highlighted, a single match is unambiguous - Enter
    // takes it rather than making the teacher arrow down to it first.
    const pick = courseCursor >= 0 ? courseMatches[courseCursor]
      : (courseMatches.length === 1 ? courseMatches[0] : null);
    if (pick) { pickCourse(pick); event.preventDefault(); }
  } else if (key === 'Escape') {
    renderCourseResults(false);
  }
}

function pickCourse(courseId) {
  el('course').value = courseId;
  el('courseSearch').value = courseLabel(courseId);
  renderCourseResults(false);
  onCourseChange();
}

// A new course starts from a clean form: weeks, times, rooms, teachers and
// both notes describe ONE course, and carrying them into the next one would
// send the first course's wishes under the second's name.
function onCourseChange() {
  state.rooms.clear();
  selectAllWeeks();
  state.slots.clear();
  state.notTeaching.clear();
  state.typesOn.clear();
  el('teachersNote').value = '';
  el('note').value = '';
  resetProposal();
  // Extras belong to the course they were chosen for.
  extraRooms.clear();
  el('roomSearch').value = '';
  setStatus('');
  renderWeeks();
  renderSlots();
  showStepsForCourse();
  loadPlan();
}

/* ---------- the course's current draft ----------------------------- */

// The course's sessions as they stand in Spoi now (the survey script's
// ?course=, from the "plan" tab the course-list update writes). Context for
// the wishes below, and what a proposed change starts from - see proposal.
let planRequest = 0;
async function loadPlan() {
  const request = ++planRequest;
  const courseId = el('course').value;
  el('planGrid').innerHTML = '';
  el('planList').innerHTML = '';
  proposal.sessions = [];
  if (!courseId || !state.term) return;
  proposal.loaded = false;
  el('planHint').textContent = tr('Sæki drög…', 'Fetching the draft…');
  try {
    const url = CONFIG.apiUrl + '?school=' + encodeURIComponent(el('school').value)
      + '&year=' + encodeURIComponent(state.term.year)
      + '&semester=' + encodeURIComponent(state.term.semester)
      + '&course=' + encodeURIComponent(courseId);
    const body = await (await fetch(url)).json();
    if (request !== planRequest) return;  // another course was picked since
    if (!body.ok) throw new Error(body.error || tr('Óþekkt villa', 'Unknown error'));
    renderPlan(body.plan || []);
  } catch (error) {
    if (request !== planRequest) return;
    el('planHint').textContent = tr('Tókst ekki að sækja drögin (', 'Could not fetch the draft (')
      + error.message + ').';
  }
}

// "2::3::4::7" -> "2–4, 7".
function weekRangesText(weeks) {
  const sorted = Array.from(new Set(weeks)).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(sorted[i] === sorted[j] ? String(sorted[i]) : sorted[i] + '\u2013' + sorted[j]);
    i = j;
  }
  return parts.join(', ');
}

function planSessions(rows) {
  const dayIndex = {};
  CONFIG.days.forEach((day, index) => { dayIndex[day.token] = index; });
  return rows.map((row) => {
    const parts = String(row.slot || '').split('-');
    const day = parts.length === 2 && parts[0] in dayIndex ? parts[0] : '';
    const start = day ? Number(parts[1]) : NaN;
    const length = Math.max(1, Number(row.n_timeslot) || 1);
    const type = String(row.type || '').trim().toLowerCase();
    return {
      id: String(row.session_id || '').trim(),
      name: String(row.name || '').trim(),
      day: day,
      dayIndex: day ? dayIndex[day] : -1,
      start: Number.isFinite(start) ? start : -1,
      length: length,
      typeCode: type,
      room: String(row.room || ''),
      teachers: String(row.teachers || '').split('::').filter(Boolean),
      weeks: String(row.weeks || '').split('::').map(Number).filter((week) => week > 0)
    };
  });
}

function sessionTimeText(session) {
  if (session.start < 0) return tr('Ekki tímasett', 'No time set');
  const day = dayLabel(CONFIG.days[session.dayIndex]);
  const end = CONFIG.slotZeroStartMinutes + (session.start + session.length) * CONFIG.slotStepMinutes - 10;
  return day + ' ' + slotLabel(session.start) + '\u2013'
    + String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
}

// The course's sessions from the plan, and what the teacher proposes to do
// with them ("Tillaga að tímum"). Nothing here changes Spói: the proposal is
// sent with the answer and an administrator accepts or rejects each part in
// Tímabókanir. A session the plan names no session_id for (a plan tab
// written before the column existed) can be seen but not changed.
const proposal = {
  sessions: [],
  updated: '',
  // The plan has been fetched and drawn for the chosen course.
  loaded: false,
  // session_id -> { op: 'change'|'remove', slot, n_timeslot, weeksText, note }
  changes: new Map(),
  // [{ type, slot, n_timeslot, weeksText, note }]
  added: [],
  // { kind: 'change', id } | { kind: 'add', index } | null
  editing: null
};

function resetProposal() {
  proposal.changes.clear();
  proposal.added = [];
  proposal.editing = null;
  el('planEditor').hidden = true;
}

function renderPlan(rows) {
  proposal.sessions = planSessions(rows);
  proposal.updated = rows.length ? String(rows[0].updated || '') : '';
  proposal.loaded = true;
  renderPlanView();
}

function slotToken(dayIndex, start) {
  return dayIndex >= 0 && start >= 0 ? CONFIG.days[dayIndex].token + '-' + start : '';
}

// "mið-2" -> { dayIndex, start }, or -1s for "Ekki tímasett".
function parseSlotToken(token) {
  const parts = String(token || '').split('-');
  const dayIndex = CONFIG.days.findIndex((day) => day.token === parts[0]);
  const start = parts.length === 2 ? Number(parts[1]) : NaN;
  return dayIndex >= 0 && Number.isInteger(start) ? { dayIndex, start } : { dayIndex: -1, start: -1 };
}

// "34-40, 42" -> [34..40, 42]; blank -> [] ("as before"). Weeks outside
// 1-53 are ignored rather than refused: the server drops them anyway.
function parseWeeksText(text) {
  const weeks = new Set();
  String(text || '').split(/[,\s]+/).filter(Boolean).forEach((part) => {
    const match = part.match(/^(\d{1,2})(?:[-–](\d{1,2}))?$/);
    if (!match) return;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (let week = Math.min(from, to); week <= Math.max(from, to); week++) {
      if (week >= 1 && week <= 53) weeks.add(week);
    }
  });
  return Array.from(weeks).sort((a, b) => a - b);
}

// A proposed session drawn and described like a plan session.
function proposedSession(base, change) {
  const where = parseSlotToken(change.slot);
  const weeks = parseWeeksText(change.weeksText);
  const typeCode = change.type || base.typeCode;
  return Object.assign({}, base, {
    dayIndex: where.dayIndex,
    start: where.start,
    length: change.n_timeslot,
    typeCode: typeCode,
    weeks: weeks.length ? weeks : (base.weeks || [])
  });
}

// A session type's name in the page's language; a code Spoi has no
// teaching name for (a test, a blank) is "Óskilgreind tegund".
function typeName(code) {
  if (!TYPE_LABELS[code]) return tr('Óskilgreind tegund', 'Unspecified type');
  return lang === 'en' ? TYPE_LABELS_EN[code] : TYPE_LABELS[code];
}

function sessionLabel(session) {
  return (session.name || typeName(session.typeCode)) + ' (' + sessionTimeText(session) + ')';
}

// One line per proposed change, for the list, the summary and the
// administrator's email: "Fyrirlestrar (Þri 08:20–09:50) -> Mið 10:00–10:40".
function proposalLines() {
  const lines = [];
  proposal.sessions.forEach((session) => {
    const change = proposal.changes.get(session.id);
    if (!change) return;
    if (change.op === 'remove') {
      lines.push(tr('Fella niður: ', 'Cancel: ') + sessionLabel(session) + (change.note ? ' - ' + change.note : ''));
      return;
    }
    const next = proposedSession(session, change);
    const weeks = parseWeeksText(change.weeksText);
    lines.push(sessionLabel(session) + ' → '
      + (next.typeCode !== session.typeCode ? typeName(next.typeCode) + ' ' : '') + sessionTimeText(next)
      + (weeks.length ? tr(', almanaksvikur ', ', calendar weeks ') + weekRangesText(weeks) : '')
      + (change.note ? ' - ' + change.note : ''));
  });
  proposal.added.forEach((item) => {
    const next = proposedSession({ typeCode: item.type, weeks: [], teachers: [] }, item);
    const weeks = parseWeeksText(item.weeksText);
    lines.push(tr('Nýr tími: ', 'New session: ') + typeName(next.typeCode) + ' ' + sessionTimeText(next)
      + (weeks.length ? tr(', almanaksvikur ', ', calendar weeks ') + weekRangesText(weeks) : '')
      + (item.note ? ' - ' + item.note : ''));
  });
  return lines;
}

// What the answer carries: see cleanSessionChanges_ in the survey script,
// which checks every part against the course's plan again.
function sessionChangesPayload() {
  const out = [];
  proposal.changes.forEach((change, id) => {
    if (change.op === 'remove') {
      out.push({ op: 'remove', session_id: id, note: change.note });
    } else {
      out.push({ op: 'change', session_id: id, type: change.type, slot: change.slot, n_timeslot: change.n_timeslot,
        weeks: parseWeeksText(change.weeksText), note: change.note });
    }
  });
  proposal.added.forEach((item) => {
    out.push({ op: 'add', type: item.type, slot: item.slot, n_timeslot: item.n_timeslot,
      weeks: parseWeeksText(item.weeksText), note: item.note });
  });
  return out;
}

function renderPlanView() {
  const sessions = proposal.sessions;
  const updated = proposal.updated;
  el('planHint').textContent = lang === 'en'
    ? (sessions.length
      ? 'The course\'s sessions as they stand in Spói now' + (updated ? ' (draft of ' + updated + ')' : '')
        + '. They may still change - your answers below are taken into account.'
      : 'No sessions registered for the course in Spói yet.')
      + ' You can propose changes to the sessions, or a new session - the timetabler reviews them.'
      + ' The weeks are calendar weeks, not teaching weeks - the date of every week is in 3. Weeks.'
    : (sessions.length
      ? 'Tímar námskeiðsins eins og þeir standa núna í Spóa' + (updated ? ' (drög frá ' + updated + ')' : '')
        + '. Geta enn breyst - athugasemdir þínar hér fyrir neðan eru teknar með.'
      : 'Engir tímar skráðir fyrir námskeiðið í Spóa enn.')
      + ' Þú getur lagt til breytingar á tímunum, eða nýjan tíma - stundatöfluhaldari fer yfir þær.'
      + ' Vikurnar eru almanaksvikur, ekki kennsluvikur - dagsetningar hverrar viku eru í 3. Vikur.';

  // What the grid draws: each session as it is (faded when the teacher
  // changes or drops it), and each proposed session dashed.
  const blocks = [];
  sessions.forEach((session) => {
    const change = proposal.changes.get(session.id);
    if (!change) {
      blocks.push(Object.assign({ variant: '' }, session));
      return;
    }
    blocks.push(Object.assign({}, session, { variant: change.op === 'remove' ? 'removed' : 'moved' }));
    if (change.op === 'change') blocks.push(Object.assign(proposedSession(session, change), { variant: 'proposed' }));
  });
  proposal.added.forEach((item) => {
    blocks.push(Object.assign(proposedSession({ typeCode: item.type, weeks: [], teachers: [], room: '' }, item),
      { variant: 'proposed' }));
  });

  // The week grid: days across, slots down, each session a block spanning
  // its length. Sessions overlapping on one day share it side by side.
  const placed = blocks.filter((session) => session.start >= 0)
    .sort((a, b) => a.dayIndex - b.dayIndex || a.start - b.start);
  const grid = el('planGrid');
  grid.innerHTML = '';
  if (placed.length) {
    const lanesByDay = CONFIG.days.map(() => []);
    placed.forEach((session) => {
      const lanes = lanesByDay[session.dayIndex];
      let lane = lanes.findIndex((end) => end <= session.start);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = session.start + session.length;
      session.lane = lane;
    });
    const first = Math.min(CONFIG.firstSlot, ...placed.map((s) => s.start));
    const last = Math.max(CONFIG.lastSlot, ...placed.map((s) => s.start + s.length - 1));
    const columns = ['44px'];
    const dayColumn = [];
    lanesByDay.forEach((lanes) => {
      const count = Math.max(1, lanes.length);
      dayColumn.push(columns.length + 1);
      for (let i = 0; i < count; i++) columns.push('minmax(0, ' + (1 / count).toFixed(4) + 'fr)');
    });
    grid.style.gridTemplateColumns = columns.join(' ');
    grid.style.gridTemplateRows = 'auto repeat(' + (last - first + 1) + ', 26px)';
    CONFIG.days.forEach((day, index) => {
      const head = document.createElement('div');
      head.className = 'plan-head';
      head.textContent = dayLabel(day);
      head.style.gridColumn = dayColumn[index] + ' / span ' + Math.max(1, lanesByDay[index].length);
      head.style.gridRow = '1';
      grid.appendChild(head);
    });
    for (let slot = first; slot <= last; slot++) {
      const time = document.createElement('div');
      time.className = 'plan-time';
      time.textContent = slotLabel(slot);
      time.style.gridRow = String(slot - first + 2);
      time.style.gridColumn = '1';
      grid.appendChild(time);
      const line = document.createElement('div');
      line.className = 'plan-line';
      line.style.gridRow = String(slot - first + 2);
      line.style.gridColumn = '2 / -1';
      grid.appendChild(line);
    }
    placed.forEach((session) => {
      const block = document.createElement('div');
      block.className = 'plan-block type-' + (session.typeCode || 'none')
        + (session.variant ? ' plan-' + session.variant : '');
      block.style.gridRow = (session.start - first + 2) + ' / span ' + session.length;
      block.style.gridColumn = String(dayColumn[session.dayIndex] + session.lane);
      // The full name on a wide screen, a two-letter code on a phone
      // (style.css) - the list below spells everything out either way.
      const long = document.createElement('span');
      long.className = 'plan-long';
      long.textContent = (session.variant === 'proposed' ? tr('Tillaga: ', 'Proposal: ') : '')
        + typeName(session.typeCode);
      const short = document.createElement('span');
      short.className = 'plan-short';
      short.textContent = (lang === 'en' ? TYPE_SHORT_EN : TYPE_SHORT)[session.typeCode] || '?';
      const who = document.createElement('span');
      who.className = 'plan-who';
      who.textContent = (session.teachers || []).join(', ');
      block.append(long, short, who);
      block.title = (session.variant === 'proposed' ? tr('Tillaga: ', 'Proposal: ') : '')
        + sessionTimeText(session) + ' · ' + typeName(session.typeCode)
        + (session.room ? ' · ' + session.room : '')
        + (session.weeks.length ? tr(' · almanaksvikur ', ' · calendar weeks ') + weekRangesText(session.weeks) : '');
      grid.appendChild(block);
    });
  }

  // The same sessions in words, with everything the blocks leave out, and
  // the way in to changing each one.
  const list = el('planList');
  list.innerHTML = '';
  sessions.slice().sort((a, b) => (a.start < 0) - (b.start < 0) || a.dayIndex - b.dayIndex || a.start - b.start)
    .forEach((session) => {
      const change = proposal.changes.get(session.id);
      const item = document.createElement('div');
      item.className = 'plan-item' + (change ? ' plan-item-changed' : '');
      const text = document.createElement('span');
      text.className = 'plan-item-text';
      text.textContent = [
        session.name,
        sessionTimeText(session),
        typeName(session.typeCode),
        session.teachers.length ? session.teachers.join(', ') : tr('enginn kennari skráður', 'no teacher registered'),
        session.room,
        session.weeks.length ? tr('almanaksvikur ', 'calendar weeks ') + weekRangesText(session.weeks) : ''
      ].filter(Boolean).join(' · ');
      item.appendChild(text);
      if (change) {
        const line = document.createElement('span');
        line.className = 'plan-item-proposal';
        line.textContent = change.op === 'remove'
          ? tr('Tillaga: fella niður', 'Proposal: cancel')
          : tr('Tillaga: ', 'Proposal: ')
            + (change.type && change.type !== session.typeCode ? typeName(change.type) + ' · ' : '')
            + sessionTimeText(proposedSession(session, change))
            + (parseWeeksText(change.weeksText).length
              ? tr(', almanaksvikur ', ', calendar weeks ') + weekRangesText(parseWeeksText(change.weeksText)) : '');
        item.appendChild(line);
      }
      if (session.id) {
        item.appendChild(planButton(change ? tr('Breyta tillögu', 'Edit proposal')
          : tr('Leggja til breytingu', 'Propose a change'),
          () => openEditor({ kind: 'change', id: session.id })));
        if (change) item.appendChild(planButton(tr('Afturkalla', 'Undo'), () => {
          proposal.changes.delete(session.id);
          closeEditor();
        }));
      }
      list.appendChild(item);
    });
  proposal.added.forEach((added, index) => {
    const item = document.createElement('div');
    item.className = 'plan-item plan-item-changed';
    const line = document.createElement('span');
    line.className = 'plan-item-proposal';
    const next = proposedSession({ typeCode: added.type, weeks: [], teachers: [] }, added);
    line.textContent = tr('Nýr tími (tillaga): ', 'New session (proposal): ') + typeName(next.typeCode)
      + ' · ' + sessionTimeText(next)
      + (next.weeks.length ? tr(' · almanaksvikur ', ' · calendar weeks ') + weekRangesText(next.weeks) : '');
    item.appendChild(line);
    item.appendChild(planButton(tr('Breyta', 'Edit'), () => openEditor({ kind: 'add', index })));
    item.appendChild(planButton(tr('Eyða', 'Delete'), () => {
      proposal.added.splice(index, 1);
      closeEditor();
    }));
    list.appendChild(item);
  });
  const add = planButton(tr('+ Leggja til nýjan tíma', '+ Propose a new session'), () => {
    proposal.added.push({ type: 'du', slot: '', n_timeslot: 1, weeksText: '', note: '' });
    openEditor({ kind: 'add', index: proposal.added.length - 1 });
  });
  add.classList.add('plan-add');
  list.appendChild(add);
  renderSummary();
}

function planButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function closeEditor() {
  proposal.editing = null;
  el('planEditor').hidden = true;
  renderPlanView();
}

// The editor for one change or one new session. Built once per opening and
// not redrawn while typing (that would take the cursor away); each input
// updates the proposal and redraws only the grid and list.
// quiet: redrawn in place (the language changed), so no scrolling to it.
function openEditor(target, quiet) {
  proposal.editing = target;
  const isAdd = target.kind === 'add';
  const base = isAdd ? null : proposal.sessions.find((session) => session.id === target.id);
  if (!isAdd && !base) return;
  let entry;
  if (isAdd) {
    entry = proposal.added[target.index];
  } else {
    entry = proposal.changes.get(target.id) || {
      op: 'change', type: base.typeCode, slot: slotToken(base.dayIndex, base.start),
      n_timeslot: base.length, weeksText: '', note: ''
    };
  }

  const box = el('planEditor');
  box.innerHTML = '';
  box.hidden = false;
  const title = document.createElement('h3');
  title.textContent = isAdd ? tr('Nýr tími (tillaga)', 'New session (proposal)')
    : tr('Tillaga um ', 'Proposal for ') + sessionLabel(base);
  box.appendChild(title);

  const field = (labelText, control) => {
    const label = document.createElement('label');
    label.className = 'plan-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(span, control);
    box.appendChild(label);
    return control;
  };
  const select = (options, value) => {
    const control = document.createElement('select');
    options.forEach(([optionValue, text]) => {
      const option = document.createElement('option');
      option.value = String(optionValue);
      option.textContent = text;
      control.appendChild(option);
    });
    control.value = String(value);
    return control;
  };

  // Any teaching type, for a new session and for an existing one (a
  // lecture that should be a dæmatími). A session of some other or no
  // type (a test, "Óskilgreind tegund") offers its own first, as Óbreytt.
  const typeOptions = Object.keys(TYPE_LABELS).map((code) => [code, typeName(code)]);
  if (!isAdd && !TYPE_LABELS[base.typeCode]) {
    typeOptions.unshift([base.typeCode, tr('Óbreytt (', 'Unchanged (') + typeName(base.typeCode) + ')']);
  }
  const typeSelect = field(tr('Tegund', 'Type'), select(typeOptions, isAdd ? entry.type : entry.type || base.typeCode));
  let removeBox = null;
  if (!isAdd) {
    removeBox = document.createElement('input');
    removeBox.type = 'checkbox';
    removeBox.checked = entry.op === 'remove';
    field(tr('Fella tímann niður', 'Cancel the session'), removeBox);
  }
  const where = parseSlotToken(entry.slot);
  const daySelect = field(tr('Dagur', 'Day'), select([[-1, tr('Ekki tímasett', 'No time set')]].concat(
    CONFIG.days.map((day, index) => [index, dayLabel(day)])), where.dayIndex));
  const startSelect = field(tr('Byrjar', 'Starts'), select([], 0));
  const lengthSelect = field(tr('Lengd', 'Length'), select([1, 2, 3, 4].map((n) =>
    [n, n + (n === 1 ? tr(' tími', ' period') : tr(' tímar', ' periods'))
      + ' (' + (n * 50 - 10) + tr(' mín)', ' min)')]), entry.n_timeslot));
  const weeksInput = document.createElement('input');
  weeksInput.type = 'text';
  weeksInput.placeholder = isAdd ? tr('t.d. ', 'e.g. ') + weekRangeText(weekRangeFromQuery())
    : tr('autt = óbreytt, t.d. ', 'blank = unchanged, e.g. ') + weekRangeText(weekRangeFromQuery());
  weeksInput.value = entry.weeksText;
  field(tr('Almanaksvikur', 'Calendar weeks'), weeksInput);
  box.appendChild(calendarWeeksHint());
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.maxLength = 500;
  noteInput.placeholder = tr('Af hverju? (valfrjálst)', 'Why? (optional)');
  noteInput.value = entry.note;
  field(tr('Skýring', 'Reason'), noteInput);

  // Start times that leave the session inside the day's grid.
  const fillStarts = (keep) => {
    const length = Number(lengthSelect.value);
    startSelect.innerHTML = '';
    for (let slot = CONFIG.firstSlot; slot + length - 1 <= CONFIG.lastSlot; slot++) {
      const option = document.createElement('option');
      option.value = String(slot);
      option.textContent = slotLabel(slot);
      startSelect.appendChild(option);
    }
    const options = Array.from(startSelect.options).map((o) => Number(o.value));
    startSelect.value = String(options.includes(keep) ? keep : options[options.length - 1]);
  };
  fillStarts(where.start >= 0 ? where.start : CONFIG.firstSlot);

  const update = () => {
    const removing = removeBox && removeBox.checked;
    [typeSelect, daySelect, startSelect, lengthSelect, weeksInput].filter(Boolean)
      .forEach((control) => { control.disabled = removing; });
    startSelect.disabled = removing || Number(daySelect.value) < 0;
    const next = {
      op: removing ? 'remove' : 'change',
      type: typeSelect ? typeSelect.value : base.typeCode,
      slot: Number(daySelect.value) < 0 ? '' : slotToken(Number(daySelect.value), Number(startSelect.value)),
      n_timeslot: Number(lengthSelect.value),
      weeksText: weeksInput.value,
      note: noteInput.value.trim()
    };
    if (isAdd) {
      proposal.added[target.index] = next;
      delete proposal.added[target.index].op;
    } else {
      const unchanged = next.op === 'change' && next.type === base.typeCode
        && next.slot === slotToken(base.dayIndex, base.start)
        && next.n_timeslot === base.length && !parseWeeksText(next.weeksText).length && !next.note;
      if (unchanged) proposal.changes.delete(target.id);
      else proposal.changes.set(target.id, next);
    }
    renderPlanView();
  };
  lengthSelect.addEventListener('change', () => { fillStarts(Number(startSelect.value)); update(); });
  [typeSelect, removeBox, daySelect, startSelect].filter(Boolean)
    .forEach((control) => control.addEventListener('change', update));
  [weeksInput, noteInput].forEach((control) => control.addEventListener('input', update));

  const done = planButton(tr('Lokið', 'Done'), closeEditor);
  done.classList.add('plan-done');
  box.appendChild(done);
  update();
  if (!quiet) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Every room this course may be given: the prefill's own list plus
// anything the teacher searched for and added.
function courseRoomRows() {
  // A course with no rooms yet comes as one row with a blank room_id.
  const rows = (catalog.get(el('course').value) || [])
    .filter((row) => String(row.room_id || '').trim());
  const seen = new Set(rows.map((row) => String(row.room_id || '').trim()));
  extraRooms.forEach((roomId) => {
    if (!seen.has(roomId) && allRooms.has(roomId)) rows.push(allRooms.get(roomId));
  });
  return rows;
}

function roomButton(row, isExtra) {
  const roomId = String(row.room_id || '').trim();
  const value = state.rooms.get(roomId);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'room-btn'
    + (value === 'prefer' ? ' preferred' : '')
    + (value === 'avoid' ? ' blocked' : '');

  const name = document.createElement('span');
  name.className = 'room-name';
  name.textContent = row.room_name || roomId;

  const meta = document.createElement('span');
  meta.className = 'room-meta';
  const bits = [row.building, row.capacity ? row.capacity + tr(' sæti', ' seats') : ''].filter(Boolean);
  meta.textContent = bits.join(' · ')
    + (isExtra ? tr(' · utan lista', ' · not on the list') : '')
    + (value === 'prefer' ? tr(' — hentar vel', ' — suits well')
      : (value === 'avoid' ? tr(' — hentar ekki', ' — does not suit') : ''));

  button.append(name, meta);
  button.onclick = () => {
    cycle(state.rooms, roomId, null, null);
    setStatus('');
    if (isExtra) extraRooms.add(roomId);
    renderRooms();
    renderRoomSearch();
    renderSummary();
  };
  return button;
}

function renderRooms() {
  const target = el('roomList');
  const rows = courseRoomRows();
  target.innerHTML = '';

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = tr('Engar stofur skráðar fyrir þetta námskeið enn. Leitaðu að stofu hér fyrir neðan.',
      'No rooms listed for this course yet. Search for a room below.');
    target.appendChild(empty);
    el('roomCount').textContent = '';
    return;
  }

  // A room the teacher searched in is marked as such, so the list never
  // implies the prefill proposed it.
  const courseRoomIds = new Set(
    (catalog.get(el('course').value) || []).map((row) => String(row.room_id || '').trim())
  );
  rows.forEach((row) => {
    const roomId = String(row.room_id || '').trim();
    if (!roomId) return;
    target.appendChild(roomButton(row, !courseRoomIds.has(roomId)));
  });

  const node = el('roomCount');
  node.className = 'hint';
  node.textContent = countOf(state.rooms, 'prefer') + tr(' henta vel, ', ' suit well, ')
    + countOf(state.rooms, 'avoid') + tr(' henta ekki.', ' do not suit.');
}

// Rooms anywhere in the school matching the query, minus the ones this
// course already offers. Capped: a bare "V" would otherwise render every
// room in VR-I, II and III at once, and a list that long is not a search
// result, it is the catalogue again.
function renderRoomSearch() {
  const target = el('roomSearchResults');
  const query = fold(el('roomSearch').value.trim());
  target.innerHTML = '';
  if (query.length < 2) return;

  const shown = new Set(courseRoomRows().map((row) => String(row.room_id || '').trim()));
  const matches = [];
  let alreadyListed = 0;
  allRooms.forEach((row, roomId) => {
    const haystack = fold((row.room_name || '') + ' ' + (row.building || ''));
    if (haystack.indexOf(query) < 0) return;
    if (shown.has(roomId)) { alreadyListed++; return; }
    if (matches.length < 24) matches.push(row);
  });

  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    // "Engin stofa fannst" would be a lie the moment a teacher searches
    // for a room that is already above - which is exactly what happens
    // right after adding one, since the query is still in the box.
    empty.textContent = alreadyListed
      ? tr('Sú stofa er þegar á listanum að ofan.', 'That room is already on the list above.')
      : tr('Engin stofa fannst.', 'No room found.');
    target.appendChild(empty);
    return;
  }
  matches.forEach((row) => target.appendChild(roomButton(row, true)));
}

function showStepsForCourse() {
  const chosen = !!el('course').value;
  ['planCard', 'weeksCard', 'timesCard', 'roomsCard', 'teachersCard', 'noteCard', 'summaryCard', 'submitCard']
    .forEach((id) => { el(id).hidden = !chosen; });
  // A catalog written before it carried teachers has no such column at
  // all: the step is left out rather than claiming no teacher is registered.
  if (!catalogHasTeachers()) el('teachersCard').hidden = true;
  if (chosen) { renderRooms(); renderRoomSearch(); renderTeachers(); renderSummary(); }
}

function catalogHasTeachers() {
  for (const rows of catalog.values()) {
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'teachers'))) return true;
  }
  return false;
}

// The course's registered teachers as initials ("PE", "PT"), from the
// catalog's teachers column - the same on every row of a course. Initials
// only: this page is public. Spoi maps them back to teachers on import.
function courseTeacherLabels() {
  const rows = catalog.get(el('course').value) || [];
  const cell = rows.length ? String(rows[0].teachers || '') : '';
  return cell.split('::').map((label) => label.trim()).filter(Boolean);
}

// Spoi's session-type codes a teacher can be said to teach, as the page
// names them (COURSE_SESSION_EVENT_TYPES, spoi/gas/Code.js).
const TYPE_LABELS = {
  fl: 'Fyrirlestrar', du: 'Dæmatímar', ae: 'Æfingatímar', vl: 'Verklegt',
  ut: 'Umræðutímar', hp: 'Verkefnatímar', ms: 'Málstofa', vs: 'Vinnustofa', tt: 'Tölvutímar'
};

// Two letters each, for the draft's blocks on a phone.
const TYPE_SHORT = {
  fl: 'Fl', du: 'Dæ', ae: 'Æf', vl: 'Vl', ut: 'Um', hp: 'Vk', ms: 'Ms', vs: 'Vs', tt: 'Tö'
};

// The same names with a soft hyphen where each may break, so the table's
// nine headings fit a normal screen on two lines rather than scrolling.
const TYPE_HEADINGS = {
  fl: 'Fyrir\u00adlestrar', du: 'Dæma\u00adtímar', ae: 'Æfinga\u00adtímar', vl: 'Verk\u00adlegt',
  ut: 'Umræðu\u00adtímar', hp: 'Verkefna\u00adtímar', ms: 'Mál\u00adstofa', vs: 'Vinnu\u00adstofa',
  tt: 'Tölvu\u00adtímar'
};

// English, for ?lang=en. Codes stay what is sent.
const TYPE_LABELS_EN = {
  fl: 'Lectures', du: 'Problem sessions', ae: 'Practice sessions', vl: 'Lab work',
  ut: 'Discussion sessions', hp: 'Project sessions', ms: 'Seminar', vs: 'Workshop', tt: 'Computer sessions'
};

const TYPE_SHORT_EN = {
  fl: 'Le', du: 'Pr', ae: 'Pc', vl: 'Lb', ut: 'Di', hp: 'Pj', ms: 'Se', vs: 'Ws', tt: 'Co'
};

// The kinds of session the course has today, from the catalog's types
// column - what a ticked teacher starts with. Every type is OFFERED either
// way (TYPE_LABELS); this only decides which are pre-ticked.
function courseTypes() {
  const rows = catalog.get(el('course').value) || [];
  const cell = rows.length ? String(rows[0].types || '') : '';
  return cell.split('::').map((code) => code.trim().toLowerCase())
    .filter((code, index, all) => TYPE_LABELS[code] && all.indexOf(code) === index);
}

// The types a teacher is ticked for: what was ticked by hand, or the
// course's own types until then; none for a teacher who does not teach.
function teacherTypesOn(label) {
  if (state.notTeaching.has(label)) return [];
  const chosen = state.typesOn.get(label);
  return chosen ? Object.keys(TYPE_LABELS).filter((code) => chosen.has(code)) : courseTypes();
}

function checkboxCell(checked, onchange, title) {
  const cell = document.createElement('td');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.title = title;
  box.setAttribute('aria-label', title);
  box.onchange = () => onchange(box.checked);
  cell.appendChild(box);
  return cell;
}

// A table, as in Ugla: one row per registered teacher, "Kennir" (teaches
// this term), then one column per kind of session. Unticking "Kennir"
// clears the row; ticking it pre-ticks the course's own types; ticking a
// type ticks "Kennir". A teacher may teach with no type ticked - that just
// says nothing finer.
function renderTeachers() {
  const target = el('teacherList');
  target.innerHTML = '';
  const labels = courseTeacherLabels();
  if (!labels.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = tr('Engir kennarar skráðir á námskeiðið í Uglu.',
      'No teachers registered on the course in Ugla.');
    target.appendChild(empty);
    return;
  }
  const codes = Object.keys(TYPE_LABELS);
  const table = document.createElement('table');
  table.className = 'teacher-table';
  const head = document.createElement('tr');
  // English names break at their spaces; the Icelandic need soft hyphens.
  const headings = lang === 'en' ? TYPE_LABELS_EN : TYPE_HEADINGS;
  [tr('Kennari', 'Teacher'), tr('Kennir', 'Teaches')].concat(codes.map((code) => headings[code])).forEach((text) => {
    const th = document.createElement('th');
    th.textContent = text;
    head.appendChild(th);
  });
  const thead = document.createElement('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const body = document.createElement('tbody');
  labels.forEach((label) => {
    const row = document.createElement('tr');
    if (state.notTeaching.has(label)) row.className = 'not-teaching';
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = label;
    row.appendChild(name);
    row.appendChild(checkboxCell(!state.notTeaching.has(label), (checked) => {
      if (checked) state.notTeaching.delete(label); else state.notTeaching.add(label);
      state.typesOn.delete(label);
      renderTeachers();
      renderSummary();
    }, label + tr(' kennir námskeiðið', ' teaches the course')));
    const on = teacherTypesOn(label);
    codes.forEach((code) => {
      row.appendChild(checkboxCell(on.indexOf(code) >= 0, (checked) => {
        const types = new Set(state.notTeaching.has(label) ? [] : teacherTypesOn(label));
        state.notTeaching.delete(label);
        if (checked) types.add(code); else types.delete(code);
        state.typesOn.set(label, types);
        renderTeachers();
        renderSummary();
      }, label + ': ' + typeName(code)));
    });
    body.appendChild(row);
  });
  table.appendChild(body);
  const wrap = document.createElement('div');
  wrap.className = 'teacher-table-wrap';
  wrap.appendChild(table);
  target.appendChild(wrap);
  // Shown on a phone only (style.css), where the table scrolls sideways.
  const scrollHint = document.createElement('p');
  scrollHint.className = 'hint scroll-hint';
  scrollHint.textContent = tr('Strjúktu töfluna til hliðar til að sjá allar tegundir tíma.',
    'Swipe the table sideways to see every kind of session.');
  target.appendChild(scrollHint);
}

// What the page will actually send, in words, immediately above the
// button. A tri-state button says nothing about the payload, and a
// submission carrying no selections looks exactly like a good one - both
// to the teacher and afterwards in the sheet. Empty lines are marked so
// they read as "you have not answered this" rather than as blank space.
function renderSummary() {
  // "Aðrar stofur" rather than "eftirstandandi": marking a room "hentar
  // ekki" does not remove it. The backend moves it to the back of the
  // course's list and pulls it forward again if the course would
  // otherwise be left with too few rooms (MIN_PREFERRED_ROOMS,
  // room_preferences.py). Showing a "remaining" count would promise a veto
  // this is not, and the surprise would land on the one teacher who ends
  // up in the room they marked.
  const others = (catalog.get(el('course').value) || [])
    .map((row) => String(row.room_id || '').trim())
    .filter((id, index, all) => id && all.indexOf(id) === index)
    .filter((id) => !state.rooms.has(id));

  const rows = [
    [tr('Misseri', 'Term'), termLabel(state.term)],
    [tr('Vikur', 'Weeks'), chosenWeeks().length ? weekRangesText(chosenWeeks())
      : (state.weeks.size ? tr('Allar', 'All') : '')],
    [tr('Tímar sem henta', 'Times that suit'), slotNames(keysWith(state.slots, 'prefer'))],
    [tr('Tímar sem henta ekki', 'Times that do not suit'), slotNames(keysWith(state.slots, 'avoid'))],
    [tr('Stofur sem henta', 'Rooms that suit'), roomNames(keysWith(state.rooms, 'prefer'))],
    [tr('Stofur sem henta ekki', 'Rooms that do not suit'), roomNames(keysWith(state.rooms, 'avoid'))],
    [tr('Aðrar stofur', 'Other rooms'), others.length
      ? others.length + ': ' + roomNames(others)
      : ''],
    // Nobody unticked is an answer ("they all teach"), not a gap.
    [tr('Kenna ekki á misserinu', 'Not teaching this term'), courseTeacherLabels()
      .filter((label) => state.notTeaching.has(label)).join(', ')
      || (courseTeacherLabels().length ? tr('allir kenna', 'all teach') : '')]
  ];
  if (courseTeacherLabels().length) {
    rows.push([tr('Hver kennir hvað', 'Who teaches what'), courseTeacherLabels()
      .filter((label) => !state.notTeaching.has(label))
      .map((label) => label + ': '
        + (teacherTypesOn(label).map((code) => typeName(code)).join(', ')
          || tr('tegund ekki tilgreind', 'type not given')))
      .join('; ')]);
  }
  if (el('teachersNote').value.trim()) {
    rows.push([tr('Um kennara', 'About teachers'), el('teachersNote').value.trim()]);
  }
  rows.push([tr('Tillögur að tímum', 'Proposed sessions'), proposalLines().join('; ')]);
  const target = el('summary');
  target.innerHTML = '';
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'summary-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'summary-value' + (value ? '' : ' empty');
    v.textContent = value || tr('ekkert valið', 'nothing chosen');
    row.append(l, v);
    target.appendChild(row);
  });
}

// "mán-0" -> "Mán 08:20": the tokens are what is sent, not what a reader
// recognises.
function slotNames(tokens) {
  return tokens.map((token) => {
    const where = parseSlotToken(token);
    return where.dayIndex < 0 ? token : dayLabel(CONFIG.days[where.dayIndex]) + ' ' + slotLabel(where.start);
  }).join(', ');
}

// Room ids are what gets submitted, but they mean nothing to a reader -
// show the names the teacher actually clicked.
function roomNames(roomIds) {
  const rows = catalog.get(el('course').value) || [];
  return roomIds
    .map((id) => {
      const row = rows.filter((r) => String(r.room_id) === String(id))[0];
      return row ? (row.room_name || id) : id;
    })
    .join(', ');
}

/* ---------- data -------------------------------------------------- */

async function loadCatalog() {
  const school = el('school').value;
  const select = el('course');
  select.innerHTML = '<option value="">' + tr('Sæki námskeið…', 'Fetching courses…') + '</option>';
  catalogRows = [];

  try {
    // Fetched WITHOUT a term filter on purpose: the reply is what tells
    // the page which terms exist, and a filtered one could not populate
    // the term selector. Switching term afterwards re-filters these rows
    // rather than asking again.
    const response = await fetch(CONFIG.apiUrl + '?school=' + encodeURIComponent(school));
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || tr('Óþekkt villa', 'Unknown error'));
    catalogRows = body.rows || [];
    renderTerms();
    applyTerm();
    // The lookup is per term, so it waits for the catalog to say which -
    // and runs again, because another school can bring other terms.
    loadMyCourses();
  } catch (error) {
    // Everything the previous school left behind goes too. A failed
    // fetch that kept the old course's rooms selectable would let a wish
    // be built from one school's catalogue and submitted against another.
    catalog.clear();
    allRooms.clear();
    extraRooms.clear();
    state.rooms.clear();
    state.term = null;
    select.innerHTML = '<option value="">' + tr('Tókst ekki að sækja námskeið', 'Could not fetch courses')
      + '</option>';
    el('courseHint').textContent = tr('Villa: ', 'Error: ') + error.message;
    showStepsForCourse();
  }
}

/* Which term the page is collecting for.
 *
 * The link decides where it can (?year=&semester=, the way ?school=
 * already works), and otherwise the newest term in the catalog wins,
 * because wishes are gathered for the term being PLANNED rather than the
 * one running. Either way the choice is shown rather than merely applied:
 * a teacher filling in half an hour of preferences for the wrong term
 * finds out only when the answers never take effect.
 */
function renderTerms() {
  const select = el('term');
  const terms = termsInRows(catalogRows);
  const wanted = termFromQuery();
  // A term already chosen wins over the link. The link SEEDS the choice
  // - state.term is null on first render, so ?year=&semester= decides
  // then - but re-rendering must not undo a teacher who has since picked
  // the other term, which would silently snap the form back every time.
  const chosen = (state.term && terms.filter((t) => sameTerm(t, state.term))[0])
    || (wanted && terms.filter((t) => sameTerm(t, wanted))[0])
    || terms[0]
    || null;
  state.term = chosen;

  if (!select) return;
  select.innerHTML = '';
  terms.forEach((term) => {
    const option = document.createElement('option');
    option.value = term.year + '-' + term.semester;
    option.textContent = termLabel(term);
    select.appendChild(option);
  });
  if (chosen) select.value = chosen.year + '-' + chosen.semester;
  // A school with one term has no choice to make, and a dropdown of one
  // is an invitation to look for the other. Still rendered, just not
  // offered as a decision.
  select.disabled = terms.length < 2;
  const hint = el('termHint');
  if (hint) {
    hint.textContent = chosen
      ? tr('Athugasemdirnar gilda fyrir ', 'Your answers are for ') + termLabel(chosen) + '.'
      : tr('Ekkert misseri skráð í námsframboði.', 'No term listed in the course catalogue.');
  }
}

// Everything downstream of the term: the course list, the room index and
// the week dates all belong to one term and must be rebuilt when it
// changes. Any picks already made are dropped - they named rooms and
// weeks of the term being left behind.
function applyTerm() {
  const select = el('course');
  catalog.clear();
  allRooms.clear();
  extraRooms.clear();
  state.rooms.clear();
  selectAllWeeks();
  el('courseSearch').value = '';
  el('course').value = '';
  renderCourseResults(false);
  renderWeeks();

  const term = state.term;
  catalogRows.forEach((row) => {
    // A row with no term is kept whatever the term is: the catalog tab
    // predates these columns, and a school that has not been re-synced
    // yet would otherwise offer no courses at all.
    const rowYear = String(row.year || '').trim();
    const rowSemester = semesterLetter(row.semester);
    if (term && rowYear && rowSemester && !sameTerm({ year: rowYear, semester: rowSemester }, term)) {
      return;
    }
    // The same row indexed a second way. A room appears once per course
    // that uses it, so the first sighting wins and the rest collapse
    // onto it - this index is about the room, not the course. Rows with
    // no course are the school's whole rooms sheet, there for this index
    // alone: "Finna aðra stofu" finds any room, prefilled or not.
    const roomId = String(row.room_id || '').trim();
    if (roomId && !allRooms.has(roomId)) allRooms.set(roomId, row);

    const courseId = String(row.course_id || '').trim();
    if (!courseId) return;
    if (!catalog.has(courseId)) catalog.set(courseId, []);
    catalog.get(courseId).push(row);
  });

  select.innerHTML = '<option value="">' + tr('Veldu námskeið…', 'Choose a course…') + '</option>';
  Array.from(catalog.keys()).sort().forEach((courseId) => {
    const first = catalog.get(courseId)[0] || {};
    const option = document.createElement('option');
    option.value = courseId;
    option.textContent = courseId + (first.course_name ? ' — ' + first.course_name : '');
    select.appendChild(option);
  });

  renderCourseHint();
  showStepsForCourse();
}

function onTermChange() {
  const raw = String(el('term').value || '');
  const parts = raw.split('-');
  state.term = parts.length === 2 && parts[0]
    ? { year: parts[0], semester: semesterLetter(parts[1]) }
    : null;
  renderTerms();
  applyTerm();
  loadMyCourses();
}

async function submit() {
  const courseId = el('course').value;
  if (!courseId) { setStatus(tr('Veldu námskeið fyrst.', 'Choose a course first.'), 'err'); return; }

  // Ten digits, no separators. Spoi joins a wish to a teacher through the
  // kennitala embedded in teachers.username - without it the submission
  // reaches the sheet and then has nothing to attach to, which looks like
  // a successful answer that quietly never arrives.
  const ssn = el('ssn').value.replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(ssn)) {
    setStatus(tr('Sláðu inn kennitölu (10 tölustafir) - án hennar rata athugasemdirnar ekki á rétt námskeið.',
      'Type your kennitala (10 digits) - without it your answers cannot reach the right course.'), 'err');
    el('ssn').focus();
    return;
  }

  if (!state.term) { setStatus(tr('Ekkert misseri valið.', 'No term chosen.'), 'err'); return; }

  const payload = {
    school: el('school').value,
    // Sent with every wish, not inferred on arrival: the same course_id
    // can be taught in both terms, so nothing downstream can work out
    // which one an answer meant once it has been stored without it.
    year: state.term.year,
    semester: state.term.semester,
    course_id: courseId,
    teacher_email: el('email').value.trim(),
    teacher_ssn: ssn,
    prefer_rooms: keysWith(state.rooms, 'prefer'),
    avoid_rooms: keysWith(state.rooms, 'avoid'),
    prefer_times: keysWith(state.slots, 'prefer'),
    avoid_times: keysWith(state.slots, 'avoid'),
    weeks: chosenWeeks(),
    note: el('note').value.trim(),
    // Only this course's own initials: a set left over from another
    // course would name teachers the course does not have.
    not_teaching: courseTeacherLabels().filter((label) => state.notTeaching.has(label)),
    // label -> types, for every teacher still ticked.
    teacher_types: courseTeacherLabels().filter((label) => !state.notTeaching.has(label))
      .reduce((out, label) => { out[label] = teacherTypesOn(label); return out; }, {}),
    teachers_note: el('teachersNote').value.trim(),
    session_changes: sessionChangesPayload()
  };

  el('submitBtn').disabled = true;
  setStatus(tr('Sendi…', 'Sending…'));
  try {
    // text/plain keeps this a "simple request", so the browser skips the
    // CORS preflight - Apps Script cannot answer an OPTIONS call. The body
    // is still JSON and doPost parses it as such.
    const response = await fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || tr('Óþekkt villa', 'Unknown error'));
    setStatus(tr('Athugasemdir vistaðar fyrir ', 'Answers saved for ') + termLabel(state.term)
      + tr('. Takk!', '. Thank you!'), 'ok');
  } catch (error) {
    // The write may well have landed even when the reply cannot be read -
    // say so rather than implying the answer was lost.
    setStatus(
      tr('Ekki tókst að staðfesta sendingu (', 'Could not confirm the answer was received (')
        + error.message + '). '
        + tr('Athugaðu hvort athugasemdirnar skiluðu sér áður en þú sendir aftur.',
          'Check whether it arrived before sending again.'),
      'err'
    );
  }
  el('submitBtn').disabled = false;
}

/* ---------- switching language ------------------------------------ */

// The page's fixed text: an element with data-en has its English as HTML
// there, and its Icelandic is kept on first switch; data-en-placeholder
// does the same for a placeholder.
function applyStaticText() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-en]').forEach((node) => {
    if (node.dataset.is == null) node.dataset.is = node.innerHTML;
    node.innerHTML = lang === 'en' ? node.dataset.en : node.dataset.is;
  });
  document.querySelectorAll('[data-en-placeholder]').forEach((node) => {
    if (node.dataset.isPlaceholder == null) node.dataset.isPlaceholder = node.placeholder;
    node.placeholder = lang === 'en' ? node.dataset.enPlaceholder : node.dataset.isPlaceholder;
  });
  document.title = tr('Athugasemdir kennara', 'Teacher feedback');
  document.querySelectorAll('.lang-switch button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
  });
  applyVideoLanguage();
}

// The help video: two recordings of the same walk-through, one of the page
// in Icelandic (data-clip-is) and one in English (data-clip-en), each with
// IS and EN subtitles on the site's kennsla/video/. The page's language
// picks the recording and which subtitles are on.
function applyVideoLanguage() {
  const video = document.querySelector('.help-video video');
  if (!video) return;
  const clip = video.dataset[lang === 'en' ? 'clipEn' : 'clipIs'];
  if (!clip || video.dataset.clip === clip) return;
  video.dataset.clip = clip;
  const base = video.dataset.dir + clip;
  video.poster = base + '.jpg';
  video.innerHTML = '';
  const source = document.createElement('source');
  source.src = base + '.mp4';
  source.type = 'video/mp4';
  video.appendChild(source);
  [['is', 'Íslenska'], ['en', 'English']].forEach(([code, label]) => {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.srclang = code;
    track.label = label;
    track.src = base + '.' + code + '.vtt';
    track.default = code === lang;
    video.appendChild(track);
  });
  video.load();
}

// Everything already on screen is redrawn in the new language; nothing the
// teacher has chosen or typed is lost.
function setLang(next) {
  lang = next;
  try { localStorage.setItem(LANG_KEY, lang); } catch (error) { /* not remembered */ }
  const params = new URLSearchParams(location.search);
  params.set('lang', lang);
  history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
  applyStaticText();
  renderSchools();
  if (catalogRows.length) renderTerms();
  const placeholder = el('course').querySelector('option[value=""]');
  if (placeholder && catalogRows.length) placeholder.textContent = tr('Veldu námskeið…', 'Choose a course…');
  renderWeeks();
  renderSlots();
  renderCourseHint();
  setStatus('');
  if (el('course').value) {
    if (proposal.loaded) renderPlanView();
    if (proposal.editing) openEditor(proposal.editing, true);
    showStepsForCourse();
  }
}

/* ---------- wiring ------------------------------------------------ */

applyStaticText();
document.querySelectorAll('.lang-switch button').forEach((button) => {
  button.addEventListener('click', () => { if (button.dataset.lang !== lang) setLang(button.dataset.lang); });
});
renderSchools();
renderWeeks();
renderSlots();
loadCatalog();

el('school').addEventListener('change', loadCatalog);
el('term').addEventListener('change', onTermChange);
// Each keystroke restarts the lookup; only a complete kennitala sends one,
// and a reply to an older one is ignored.
el('ssn').addEventListener('input', loadMyCourses);
el('course').addEventListener('change', onCourseChange);
el('teachersNote').addEventListener('input', renderSummary);
el('roomSearch').addEventListener('input', renderRoomSearch);
el('courseSearch').addEventListener('input', () => renderCourseResults());
// Clicking into the box starts a new search: the chosen course's label is
// cleared so every course is listed, rather than having to be deleted by
// hand first. Leaving without picking puts it back (the blur below).
el('courseSearch').addEventListener('focus', () => {
  const selected = el('course').value;
  if (selected && el('courseSearch').value === courseLabel(selected)) el('courseSearch').value = '';
  renderCourseResults();
});
el('courseSearch').addEventListener('keydown', onCourseKeydown);
// Half-typed text left in the box would claim a course that was never
// selected, so leaving the field snaps it back to what is actually set.
el('courseSearch').addEventListener('blur', () => {
  const selected = el('course').value;
  el('courseSearch').value = selected ? courseLabel(selected) : '';
  renderCourseResults(false);
});
el('submitBtn').addEventListener('click', submit);

document.querySelectorAll('[data-weeks]').forEach((button) => {
  button.addEventListener('click', () => {
    const range = weekRangeFromQuery();
    state.weeks.clear();
    if (button.dataset.weeks === 'all') {
      for (let week = range.from; week <= range.to; week++) state.weeks.add(week);
    }
    renderWeeks();
    renderSummary();
  });
});
