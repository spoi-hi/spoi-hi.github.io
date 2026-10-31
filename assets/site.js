/* Language switch for the static pages (IS / EN).
 *
 * Text in both languages sits side by side as <span class="i18n"
 * lang="is"> / lang="en"; site.css hides the one not chosen, keyed on
 * <html data-lang>. Loaded in <head>, so the choice applies before the page
 * is drawn. The choice is remembered per browser - if storage is blocked,
 * the page still works and starts in Icelandic.
 */
(function () {
  var KEY = 'spoi-lang';
  // "Annað": a svið's or deild's timetables filed under no level below it.
  var TERMS = { Vor: 'Spring', Haust: 'Autumn', Sumar: 'Summer', 'Annað': 'Other' };

  function stored() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function remember(lang) {
    try { window.localStorage.setItem(KEY, lang); } catch (e) { /* private window */ }
  }

  // Term headings Spoi writes into the faculty pages ("Vor 2027").
  function translateTerms(lang) {
    document.querySelectorAll('.timetable-list h3').forEach(function (h) {
      if (!h.dataset.is) h.dataset.is = h.textContent;
      var word = h.dataset.is.split(' ')[0];
      h.textContent = lang === 'en' && TERMS[word] ? h.dataset.is.replace(word, TERMS[word]) : h.dataset.is;
    });
  }

  // Spoi's own note in an empty faculty list (render_school_list).
  var NOTES = { 'Engar stundatöflur birtar enn.': 'No timetables published yet.' };
  function translateNotes(lang) {
    document.querySelectorAll('.timetable-list em').forEach(function (em) {
      if (!em.dataset.is) em.dataset.is = em.textContent;
      em.textContent = lang === 'en' && NOTES[em.dataset.is] ? NOTES[em.dataset.is] : em.dataset.is;
    });
  }

  function apply(lang) {
    var root = document.documentElement;
    root.dataset.lang = lang;
    root.lang = lang;
    document.querySelectorAll('.lang-switch button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
    translateTerms(lang);
    translateNotes(lang);
    document.dispatchEvent(new CustomEvent('spoi:lang', { detail: lang }));
  }

  var initial = stored() === 'en' ? 'en' : 'is';
  document.documentElement.dataset.lang = initial;
  document.documentElement.lang = initial;

  document.addEventListener('DOMContentLoaded', function () {
    apply(initial);
    document.querySelectorAll('.lang-switch button').forEach(function (b) {
      b.addEventListener('click', function () { remember(b.dataset.lang); apply(b.dataset.lang); });
    });
  });
})();
