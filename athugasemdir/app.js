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
    { value: 'von', label: 'VoN - Verkfræði- og náttúruvísindasvið' },
    { value: 'fvs', label: 'FVS - Félagsvísindasvið' },
    { value: 'hug', label: 'HUG - Hugvísindasvið' },
    { value: 'mvs', label: 'MVS - Menntavísindasvið' },
    { value: 'hvs', label: 'HVS - Heilbrigðisvísindasvið' }
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

  days: [
    { token: 'mán', label: 'Mán' },
    { token: 'þri', label: 'Þri' },
    { token: 'mið', label: 'Mið' },
    { token: 'fim', label: 'Fim' },
    { token: 'fös', label: 'Fös' }
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
  const names = { H: 'Haust', V: 'Vor', S: 'Sumar' };
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

function shortDate(date) {
  return date.getUTCDate() + '.' + (date.getUTCMonth() + 1) + '.';
}

function longDate(date) {
  return date.getUTCDate() + '. ' + MONTHS_IS[date.getUTCMonth()];
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
  select.innerHTML = '';
  CONFIG.schools.forEach((school) => {
    const option = document.createElement('option');
    option.value = school.value;
    option.textContent = school.label;
    select.appendChild(option);
  });
  const preset = new URLSearchParams(location.search).get('school');
  if (preset) select.value = preset;
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
    button.title = 'Vika ' + week + ' hefst mánudaginn ' + longDate(monday);

    button.onclick = () => {
      if (state.weeks.has(week)) state.weeks.delete(week);
      else state.weeks.add(week);
      renderWeeks();
      renderSummary();
    };
    target.appendChild(button);
  }

  el('weekAnchor').textContent =
    'Almanaksvikur (ekki kennsluvikur). Vika ' + range.from + ' hefst mánudaginn '
    + longDate(mondayOfIsoWeek(year, range.from)) + '.';
}

function renderSlots() {
  const target = el('slotGrid');
  target.innerHTML = '';

  target.appendChild(document.createElement('div')); // empty corner
  CONFIG.days.forEach((day) => {
    const head = document.createElement('div');
    head.className = 'slot-head';
    head.textContent = day.label;
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
      button.textContent = value === 'prefer' ? 'Hentar' : (value === 'avoid' ? 'Ekki' : '');
      button.title = day.label + ' ' + slotLabel(slot);
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
      ? 'Engin námskeið skráð fyrir þetta svið enn.'
      : (visibleCourseIds().length ? 'Ekkert námskeið fannst.' : courseHintText());
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
  const forTerm = state.term ? ' á ' + termLabel(state.term).toLowerCase() : '';
  if (!catalog.size) return 'Engin námskeið skráð fyrir þetta svið' + forTerm + ' enn.';
  if (state.myCoursesError) return 'Villa: ' + state.myCoursesError;
  if (state.myCourses === null) {
    return validSsn() ? 'Sæki námskeiðin þín…' : 'Sláðu inn kennitölu til að sjá námskeiðin þín.';
  }
  const count = visibleCourseIds().length;
  if (!state.myCoursesEnforced) return count + ' námskeið í boði fyrir þetta svið' + forTerm + '.';
  if (count) {
    return 'Þú ert skráð/ur á ' + count + ' námskeið' + forTerm + ' á þessu sviði.';
  }
  const school = el('school').value.toLowerCase();
  const elsewhere = Array.from(new Set(state.myCourses
    .map((c) => String(c.school || '').toUpperCase())
    .filter((name) => name && name.toLowerCase() !== school)));
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
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');
    // A script deployed before this lookup existed answers as if it were a
    // wish; without "enforced" in the reply, nothing is filtered.
    state.myCoursesEnforced = body.enforced !== false && Array.isArray(body.courses);
    state.myCourses = Array.isArray(body.courses) ? body.courses : [];
  } catch (error) {
    if (request !== myCoursesRequest) return;
    state.myCoursesError = 'Tókst ekki að sækja námskeiðin þín (' + error.message + ').';
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
  state.weeks.clear();
  state.slots.clear();
  state.notTeaching.clear();
  state.typesOn.clear();
  el('teachersNote').value = '';
  el('note').value = '';
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
// ?course=, from the "plan" tab the course-list update writes). Read-only:
// context for the wishes below, not something this page changes.
let planRequest = 0;
async function loadPlan() {
  const request = ++planRequest;
  const courseId = el('course').value;
  el('planGrid').innerHTML = '';
  el('planList').innerHTML = '';
  if (!courseId || !state.term) return;
  el('planHint').textContent = 'Sæki drög…';
  try {
    const url = CONFIG.apiUrl + '?school=' + encodeURIComponent(el('school').value)
      + '&year=' + encodeURIComponent(state.term.year)
      + '&semester=' + encodeURIComponent(state.term.semester)
      + '&course=' + encodeURIComponent(courseId);
    const body = await (await fetch(url)).json();
    if (request !== planRequest) return;  // another course was picked since
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');
    renderPlan(body.plan || []);
  } catch (error) {
    if (request !== planRequest) return;
    el('planHint').textContent = 'Tókst ekki að sækja drögin (' + error.message + ').';
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
      day: day,
      dayIndex: day ? dayIndex[day] : -1,
      start: Number.isFinite(start) ? start : -1,
      length: length,
      typeCode: type,
      type: TYPE_LABELS[type] || 'Óskilgreind tegund',
      room: String(row.room || ''),
      teachers: String(row.teachers || '').split('::').filter(Boolean),
      weeks: String(row.weeks || '').split('::').map(Number).filter((week) => week > 0)
    };
  });
}

function sessionTimeText(session) {
  if (session.start < 0) return 'Ekki tímasett';
  const day = CONFIG.days[session.dayIndex].label;
  const end = CONFIG.slotZeroStartMinutes + (session.start + session.length) * CONFIG.slotStepMinutes - 10;
  return day + ' ' + slotLabel(session.start) + '\u2013'
    + String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
}

function renderPlan(rows) {
  const sessions = planSessions(rows);
  const updated = rows.length ? String(rows[0].updated || '') : '';
  el('planHint').textContent = sessions.length
    ? 'Tímar námskeiðsins eins og þeir standa núna í Spóa' + (updated ? ' (drög frá ' + updated + ')' : '')
      + '. Geta enn breyst - athugasemdir þínar hér fyrir neðan eru teknar með.'
    : 'Engir tímar skráðir fyrir námskeiðið í Spóa enn.';

  // The week grid: days across, slots down, each session a block spanning
  // its length. Sessions overlapping on one day share it side by side.
  const placed = sessions.filter((session) => session.start >= 0)
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
      head.textContent = day.label;
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
      block.className = 'plan-block type-' + (session.typeCode || 'none');
      block.style.gridRow = (session.start - first + 2) + ' / span ' + session.length;
      block.style.gridColumn = String(dayColumn[session.dayIndex] + session.lane);
      // The full name on a wide screen, a two-letter code on a phone
      // (style.css) - the list below spells everything out either way.
      const long = document.createElement('span');
      long.className = 'plan-long';
      long.textContent = session.type;
      const short = document.createElement('span');
      short.className = 'plan-short';
      short.textContent = TYPE_SHORT[session.typeCode] || '?';
      const who = document.createElement('span');
      who.className = 'plan-who';
      who.textContent = session.teachers.join(', ');
      block.append(long, short, who);
      block.title = sessionTimeText(session) + ' \u00b7 ' + session.type
        + (session.room ? ' \u00b7 ' + session.room : '')
        + (session.weeks.length ? ' \u00b7 vikur ' + weekRangesText(session.weeks) : '');
      grid.appendChild(block);
    });
  }

  // The same sessions in words, with everything the blocks leave out.
  const list = el('planList');
  list.innerHTML = '';
  sessions.slice().sort((a, b) => (a.start < 0) - (b.start < 0) || a.dayIndex - b.dayIndex || a.start - b.start)
    .forEach((session) => {
      const item = document.createElement('div');
      item.className = 'plan-item';
      item.textContent = [
        sessionTimeText(session),
        session.type,
        session.teachers.length ? session.teachers.join(', ') : 'enginn kennari skráður',
        session.room,
        session.weeks.length ? 'vikur ' + weekRangesText(session.weeks) : ''
      ].filter(Boolean).join(' \u00b7 ');
      list.appendChild(item);
    });
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
  const bits = [row.building, row.capacity ? row.capacity + ' sæti' : ''].filter(Boolean);
  meta.textContent = bits.join(' · ')
    + (isExtra ? ' · utan lista' : '')
    + (value === 'prefer' ? ' — hentar vel' : (value === 'avoid' ? ' — hentar ekki' : ''));

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
    empty.textContent = 'Engar stofur skráðar fyrir þetta námskeið enn. Leitaðu að stofu hér fyrir neðan.';
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
  node.textContent = countOf(state.rooms, 'prefer') + ' henta vel, '
    + countOf(state.rooms, 'avoid') + ' henta ekki.';
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
      ? 'Sú stofa er þegar á listanum að ofan.'
      : 'Engin stofa fannst.';
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
    empty.textContent = 'Engir kennarar skráðir á námskeiðið í Uglu.';
    target.appendChild(empty);
    return;
  }
  const codes = Object.keys(TYPE_LABELS);
  const table = document.createElement('table');
  table.className = 'teacher-table';
  const head = document.createElement('tr');
  ['Kennari', 'Kennir'].concat(codes.map((code) => TYPE_HEADINGS[code])).forEach((text) => {
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
    }, label + ' kennir námskeiðið'));
    const on = teacherTypesOn(label);
    codes.forEach((code) => {
      row.appendChild(checkboxCell(on.indexOf(code) >= 0, (checked) => {
        const types = new Set(state.notTeaching.has(label) ? [] : teacherTypesOn(label));
        state.notTeaching.delete(label);
        if (checked) types.add(code); else types.delete(code);
        state.typesOn.set(label, types);
        renderTeachers();
        renderSummary();
      }, label + ': ' + TYPE_LABELS[code]));
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
  scrollHint.textContent = 'Strjúktu töfluna til hliðar til að sjá allar tegundir tíma.';
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
    ['Misseri', termLabel(state.term)],
    ['Vikur', Array.from(state.weeks).sort((a, b) => a - b).join(', ')],
    ['Tímar sem henta', keysWith(state.slots, 'prefer').join(', ')],
    ['Tímar sem henta ekki', keysWith(state.slots, 'avoid').join(', ')],
    ['Stofur sem henta', roomNames(keysWith(state.rooms, 'prefer'))],
    ['Stofur sem henta ekki', roomNames(keysWith(state.rooms, 'avoid'))],
    ['Aðrar stofur', others.length
      ? others.length + ': ' + roomNames(others)
      : ''],
    // Nobody unticked is an answer ("they all teach"), not a gap.
    ['Kenna ekki á misserinu', courseTeacherLabels()
      .filter((label) => state.notTeaching.has(label)).join(', ')
      || (courseTeacherLabels().length ? 'allir kenna' : '')]
  ];
  if (courseTeacherLabels().length) {
    rows.push(['Hver kennir hvað', courseTeacherLabels()
      .filter((label) => !state.notTeaching.has(label))
      .map((label) => label + ': '
        + (teacherTypesOn(label).map((code) => TYPE_LABELS[code]).join(', ') || 'tegund ekki tilgreind'))
      .join('; ')]);
  }
  if (el('teachersNote').value.trim()) rows.push(['Um kennara', el('teachersNote').value.trim()]);
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
    v.textContent = value || 'ekkert valið';
    row.append(l, v);
    target.appendChild(row);
  });
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
  select.innerHTML = '<option value="">Sæki námskeið…</option>';
  catalogRows = [];

  try {
    // Fetched WITHOUT a term filter on purpose: the reply is what tells
    // the page which terms exist, and a filtered one could not populate
    // the term selector. Switching term afterwards re-filters these rows
    // rather than asking again.
    const response = await fetch(CONFIG.apiUrl + '?school=' + encodeURIComponent(school));
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');
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
    select.innerHTML = '<option value="">Tókst ekki að sækja námskeið</option>';
    el('courseHint').textContent = 'Villa: ' + error.message;
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
      ? 'Athugasemdirnar gilda fyrir ' + termLabel(chosen) + '.'
      : 'Ekkert misseri skráð í námsframboði.';
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
  state.weeks.clear();
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
    const courseId = String(row.course_id || '').trim();
    if (!courseId) return;
    if (!catalog.has(courseId)) catalog.set(courseId, []);
    catalog.get(courseId).push(row);

    // The same row indexed a second way. A room appears once per course
    // that uses it, so the first sighting wins and the rest collapse
    // onto it - this index is about the room, not the course.
    const roomId = String(row.room_id || '').trim();
    if (roomId && !allRooms.has(roomId)) allRooms.set(roomId, row);
  });

  select.innerHTML = '<option value="">Veldu námskeið…</option>';
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
  if (!courseId) { setStatus('Veldu námskeið fyrst.', 'err'); return; }

  // Ten digits, no separators. Spoi joins a wish to a teacher through the
  // kennitala embedded in teachers.username - without it the submission
  // reaches the sheet and then has nothing to attach to, which looks like
  // a successful answer that quietly never arrives.
  const ssn = el('ssn').value.replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(ssn)) {
    setStatus('Sláðu inn kennitölu (10 tölustafir) - án hennar rata athugasemdirnar ekki á rétt námskeið.', 'err');
    el('ssn').focus();
    return;
  }

  if (!state.term) { setStatus('Ekkert misseri valið.', 'err'); return; }

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
    weeks: Array.from(state.weeks).sort((a, b) => a - b),
    note: el('note').value.trim(),
    // Only this course's own initials: a set left over from another
    // course would name teachers the course does not have.
    not_teaching: courseTeacherLabels().filter((label) => state.notTeaching.has(label)),
    // label -> types, for every teacher still ticked.
    teacher_types: courseTeacherLabels().filter((label) => !state.notTeaching.has(label))
      .reduce((out, label) => { out[label] = teacherTypesOn(label); return out; }, {}),
    teachers_note: el('teachersNote').value.trim()
  };

  el('submitBtn').disabled = true;
  setStatus('Sendi…');
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
    if (!body.ok) throw new Error(body.error || 'Óþekkt villa');
    setStatus('Athugasemdir vistaðar fyrir ' + termLabel(state.term) + '. Takk!', 'ok');
  } catch (error) {
    // The write may well have landed even when the reply cannot be read -
    // say so rather than implying the answer was lost.
    setStatus(
      'Ekki tókst að staðfesta sendingu (' + error.message + '). '
        + 'Athugaðu hvort athugasemdirnar skiluðu sér áður en þú sendir aftur.',
      'err'
    );
  }
  el('submitBtn').disabled = false;
}

/* ---------- wiring ------------------------------------------------ */

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
