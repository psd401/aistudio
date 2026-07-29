'use strict';

const DEFAULT_EMPTY_MESSAGES = Object.freeze({
  calendar: 'Nothing is scheduled for today.',
  inbox: 'No inbox items need attention.',
  chat: 'No new highlights were found in the configured spaces.',
  freshservice: 'No open tickets or pending approvals were found.',
  staff_leave: 'No staff leave items were returned for today.',
  atrium: 'No Atrium items changed in the selected window.',
  weather: 'No weather observations were returned.',
  news: 'No recent stories were returned for the configured topics.',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function plainText(value, fallback = '') {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function compactObject(value, depth = 0) {
  if (depth > 2 || value == null) return '';
  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map((item) => compactObject(item, depth + 1))
      .filter(Boolean)
      .join(' · ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .slice(0, 8)
      .map(([key, item]) => {
        const rendered = compactObject(item, depth + 1);
        return rendered ? `${key}: ${rendered}` : '';
      })
      .filter(Boolean)
      .join(' · ');
  }
  return plainText(value);
}

function firstText(item, keys, fallback = '') {
  for (const key of keys) {
    const value = plainText(item[key]);
    if (value) return value;
  }
  return fallback;
}

function normalizedItem(item, index) {
  if (typeof item === 'string') {
    return { headline: item, body: '', meta: '', url: null };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return {
      headline: `Item ${index + 1}`,
      body: plainText(item),
      meta: '',
      url: null,
    };
  }
  const headline = firstText(
    item,
    ['headline', 'title', 'subject', 'name'],
    `Item ${index + 1}`,
  );
  const body = firstText(item, [
    'body',
    'summary',
    'description',
    'detail',
  ]);
  const meta = firstText(item, ['meta', 'time', 'date', 'updatedAt']);
  return {
    headline,
    body: body || compactObject(item),
    meta,
    url: safeUrl(item.url || item.link),
  };
}

function synthesisSectionMap(synthesis) {
  const map = Object.create(null);
  for (const section of asArray(synthesis && synthesis.sections)) {
    if (
      section &&
      typeof section === 'object' &&
      typeof section.id === 'string' &&
      section.id
    ) {
      map[section.id] = section;
    }
  }
  return map;
}

function rawSectionItems(section) {
  if (section && section.custom === true) return [];
  const data = section && section.data;
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of [
    'items',
    'events',
    'messages',
    'emails',
    'tickets',
    'approvals',
    'absences',
    'stories',
    'results',
  ]) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (Object.keys(data).length > 0) return [data];
  return [];
}

function sectionView(raw, synthesized) {
  const synthesizedItems = asArray(synthesized && synthesized.items);
  const rawItems = rawSectionItems(raw);
  return {
    id: raw.id,
    title:
      plainText(synthesized && synthesized.title) ||
      plainText(raw.title) ||
      raw.id,
    summary: plainText(synthesized && synthesized.summary),
    items: (synthesizedItems.length > 0 ? synthesizedItems : rawItems)
      .slice(0, 12)
      .map(normalizedItem),
    emptyMessage:
      plainText(synthesized && synthesized.emptyMessage) ||
      plainText(raw.emptyMessage) ||
      DEFAULT_EMPTY_MESSAGES[raw.id] ||
      'Nothing to report in this section.',
    custom: raw.custom === true,
  };
}

function renderItem(item) {
  const headline = item.url
    ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.headline)}</a>`
    : escapeHtml(item.headline);
  return [
    '<article class="item">',
    `<h3>${headline}</h3>`,
    item.meta ? `<p class="meta">${escapeHtml(item.meta)}</p>` : '',
    item.body ? `<p>${escapeHtml(item.body)}</p>` : '',
    '</article>',
  ].join('');
}

function renderSection(section) {
  const body =
    section.items.length > 0
      ? section.items.map(renderItem).join('')
      : `<p class="empty">${escapeHtml(section.emptyMessage)}</p>`;
  return [
    `<section class="section${section.custom ? ' custom' : ''}" id="${escapeHtml(section.id)}">`,
    '<div class="section-heading">',
    `<p class="kicker">${section.custom ? 'Custom desk' : 'Daily desk'}</p>`,
    `<h2>${escapeHtml(section.title)}</h2>`,
    '</div>',
    section.summary ? `<p class="summary">${escapeHtml(section.summary)}</p>` : '',
    body,
    '</section>',
  ].join('');
}

function renderPeople(people) {
  const entries = asArray(people).filter(
    (person) => person && typeof person === 'object',
  );
  if (entries.length === 0) return '';
  return [
    '<aside class="people"><p class="kicker">My people</p><ul>',
    ...entries.map((person) => {
      const name =
        plainText(person.displayName) ||
        plainText(person.email) ||
        plainText(person.chatId) ||
        'Unresolved person';
      const detail = [plainText(person.title), plainText(person.department)]
        .filter(Boolean)
        .join(' · ');
      return `<li><strong>${escapeHtml(name)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</li>`;
    }),
    '</ul></aside>',
  ].join('');
}

function renderPodcast(podcast) {
  if (!podcast || podcast.enabled === false) return '';
  const url = safeUrl(podcast.url);
  if (!url) {
    return '<aside class="podcast"><p class="kicker">Podcast edition</p><p>Audio was disabled or unavailable for this run.</p></aside>';
  }
  return [
    '<aside class="podcast">',
    '<p class="kicker">Podcast edition</p>',
    '<h2>Listen to today’s brief</h2>',
    `<audio controls preload="none" src="${escapeHtml(url)}">`,
    `<a href="${escapeHtml(url)}">Download the MP3</a>`,
    '</audio>',
    '</aside>',
  ].join('');
}

function newspaperView(snapshot, synthesis) {
  const safeSnapshot =
    snapshot && typeof snapshot === 'object' ? snapshot : {};
  const safeSynthesis =
    synthesis && typeof synthesis === 'object' ? synthesis : {};
  const synthesized = synthesisSectionMap(safeSynthesis);
  const lead =
    safeSynthesis.leadStory &&
    typeof safeSynthesis.leadStory === 'object'
      ? safeSynthesis.leadStory
      : {};
  const title =
    plainText(safeSnapshot.title) ||
    `Morning Brief — ${plainText(safeSnapshot.localDate)}`;
  return {
    sections: asArray(safeSnapshot.sections).map((raw) =>
      sectionView(raw, synthesized[raw.id]),
    ),
    leadHeadline:
      plainText(lead.headline) ||
      plainText(safeSynthesis.headline) ||
      'Your day, at a glance',
    leadSummary:
      plainText(lead.summary) ||
      plainText(safeSynthesis.subheadline) ||
      'A concise morning read assembled from the sources available to you.',
    title,
    date: plainText(safeSnapshot.displayDate) || title,
    generatedAt: plainText(safeSnapshot.generatedAt),
    people: safeSnapshot.people,
  };
}

function renderNewspaper({ snapshot, synthesis, podcast = null }) {
  const view = newspaperView(snapshot, synthesis);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(view.title)}</title>
<style>
:root{--ink:#17202a;--paper:#f8f3e8;--rule:#b79d74;--accent:#7d2131;--muted:#615b52}
*{box-sizing:border-box}body{margin:0;background:#d9d3c7;color:var(--ink);font-family:Georgia,"Times New Roman",serif;line-height:1.45}
main{width:min(1120px,calc(100% - 24px));margin:18px auto;background:var(--paper);box-shadow:0 16px 48px #332d2440;padding:clamp(20px,4vw,54px)}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
.masthead{text-align:center;border-block:4px double var(--ink);padding:18px 0 13px}.masthead h1{font-size:clamp(2.35rem,8vw,5.8rem);line-height:.9;margin:0;letter-spacing:-.055em}
.dateline{display:flex;justify-content:space-between;gap:20px;margin-top:12px;font-size:.78rem;letter-spacing:.12em;text-transform:uppercase}.kicker{font:700 .72rem/1.2 Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 7px}
.lead{padding:28px 0;border-bottom:1px solid var(--rule);display:grid;grid-template-columns:minmax(0,2fr) minmax(220px,1fr);gap:30px}.lead h2{font-size:clamp(2rem,5vw,4rem);line-height:1;margin:0 0 14px;letter-spacing:-.035em}.lead p{font-size:1.13rem;margin:0;color:var(--muted)}
.people,.podcast{border-left:5px solid var(--accent);background:#eee5d4;padding:18px}.people ul{list-style:none;padding:0;margin:0}.people li{padding:8px 0;border-bottom:1px solid #b79d7460}.people li:last-child{border:0}.people span{display:block;color:var(--muted);font-size:.86rem}
.podcast{margin:24px 0}.podcast h2{margin:0 0 12px}.podcast audio{width:100%}
.sections{columns:2 340px;column-gap:34px}.section{break-inside:avoid;padding:25px 0;border-bottom:1px solid var(--rule)}.section.custom{border-top:5px solid var(--accent);padding-top:18px}.section-heading h2{font-size:1.9rem;line-height:1.05;margin:0}.summary{font-style:italic;color:var(--muted)}
.item{padding:13px 0;border-top:1px solid #b79d7460}.item h3{font-size:1.08rem;line-height:1.25;margin:0}.item p{margin:6px 0 0}.meta{font:700 .7rem/1.2 Arial,sans-serif!important;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.empty{color:var(--muted);font-style:italic}
footer{border-top:4px double var(--ink);margin-top:28px;padding-top:13px;text-align:center;font-size:.78rem;color:var(--muted)}
@media(max-width:720px){main{margin:0;width:100%;padding:20px}.lead{grid-template-columns:1fr}.dateline{display:block}.dateline span{display:block;margin-top:5px}.sections{columns:1}}
@media print{body{background:white}main{box-shadow:none;margin:0;width:100%}.podcast audio{display:none}}
</style>
</head>
<body><main>
<header class="masthead"><p class="kicker">Personal daily edition</p><h1>Morning Brief</h1><div class="dateline"><span>${escapeHtml(view.date)}</span><span>Private edition</span></div></header>
<section class="lead"><div><p class="kicker">Lead story</p><h2>${escapeHtml(view.leadHeadline)}</h2><p>${escapeHtml(view.leadSummary)}</p></div>${renderPeople(view.people)}</section>
${renderPodcast(podcast)}
<div class="sections">${view.sections.map(renderSection).join('')}</div>
<footer>Prepared from sources available to this account${view.generatedAt ? ` · Generated ${escapeHtml(view.generatedAt)}` : ''}</footer>
</main></body></html>`;
}

module.exports = {
  DEFAULT_EMPTY_MESSAGES,
  compactObject,
  escapeHtml,
  renderNewspaper,
  safeUrl,
  sectionView,
};
