# Stundatöflur

Public timetable site, served by GitHub Pages.

- **`index.html`** — faculty picker.
- **`assets/`** — `site.css` and `site.js`, shared by the front page, the faculty
  pages, `kennsla/` and `404.html`: layout, dark mode, and the IS/EN switch
  (text in both languages as `<span class="i18n" lang="is|en">`).
- **`von/ fvs/ hug/ mvs/ hvs/`** — one page per faculty, with its timetable
  PDFs in `pdf/`.
- **`kennsla/`** — tutorial videos for staff, written by Spoi's
  `scripts/tutorial_site.py` (do not edit by hand).
- **`athugasemdir/`** — the teacher-wishes page: weeks, times and rooms for a
  course the teacher picks. Static; it talks to an Apps Script endpoint
  that appends to a private Google Sheet.

Everything here is static. No build step, no dependencies.

## Publishing

Settings → Pages → Deploy from branch → `main` / root.

## Published timetables

Spoi writes these. In a school's Stundatöflur, ticking **Birta á vef** on a
timetable publishes it here, and every later save into Núverandi lausn
republishes it; unticking or deleting it takes the page down. Spoi's
backend commits directly to `main` (one commit per change, none when
nothing changed):

- `<faculty>/<term>/<name>.html` — one self-contained page per timetable
  (week grid plus a list of every session). No teacher names.
- `<faculty>/<term>/timetables.json` — that term's manifest.
- `<faculty>/index.html` — the list between the `spoi:timetables` markers is
  regenerated from the manifests. Edit anything outside the markers freely;
  inside them, edits are overwritten.

`<faculty>` is the school's `short_name` in Spoi's lookup spreadsheet,
lowercased; `<term>` is e.g. `haust-2026`.

## The wishes page

`athugasemdir/app.js` has a `CONFIG` block at the top: the endpoint URL, the five
faculties, the week range, the slot grid, and how many rooms a teacher may
name. Two URL parameters are useful for links sent to a faculty:

```
athugasemdir/?school=von        preselects the faculty
athugasemdir/?weeks=2-16        spring term instead of the default 34-47
```

The endpoint URL is public, which is inherent to a link teachers open, and
the same exposure a public Google Form has. Every submission is validated
server-side and only ever appended, so the worst case is junk rows rather
than damage to existing answers.
