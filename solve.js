// A faster drop-in for makefun-site 1.0.0: run(input) returns the same output tree, byte for byte.
//
// The reference is a pipeline of plugins over one build (readSources, frontMatter, permalinks, markdown, collections,
// tags, layouts, report), with lib/ for front matter, the Markdown subset, the template dialect and the text rules.
// This keeps every rule and the same order, and removes the constant costs that dominate it:
//
//   - escaping is one scan per run of text, not one call per character: inline() renders a whole plain run at once,
//     and escapeHtml returns the string itself when it holds no & < > " or ';
//   - a source's front matter is found by scanning for "\n---" instead of splitting the whole body into lines;
//   - the block lexer gates each regex on the line's first character, so a plain paragraph line runs none;
//   - a post's word count is one pass with no match array or regex;
//   - nothing is read but the input: no clock, no environment, no file.

// ------------------------------------------------------------------------------------------------ text

/** `text` with & < > " and ' escaped, the reference's table and its order. */
function escapeHtml(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return text;
  let out = text.slice(0, i);
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    out +=
      c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : c === 39 ? '&#39;' : text[i];
  }
  return out;
}

/** `v` as the template shows it: textOf then escaped, one pass when the text needs no escape (the common case). */
function escOf(v) {
  if (v === null || v === undefined) return '';
  const text = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : textOf(v);
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return text;
  let out = text.slice(0, i);
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    out +=
      c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : c === 39 ? '&#39;' : text[i];
  }
  return out;
}

const SLUG_MAX = 64;
const MARKS = /\p{M}/gu;

/** The slug rule: NFKD, marks dropped, A-Z lowered, every other run one "-", at most 64, never empty. */
function slugify(text) {
  const plain = text.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = null;
    if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = plain[i];
    if (keep === null) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += keep;
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let end = out.length;
    while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
    out = out.slice(0, end);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken`, added to it. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ------------------------------------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const TRAIL = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let plain = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const nx = raw.charCodeAt(i + 1);
        if ((nx !== 34 && nx !== 92) || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(plain, i) + raw[i + 1];
        plain = i + 2;
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    return { value: out + raw.slice(plain, raw.length - 1) };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      if (m === null) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (const p of parts) {
        const t = p.trim();
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. The closing
 * "---" is found by scanning, so a long body is never split into lines to find it.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  if (text.length > 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let closeAt = -1;
  if (text.length > 3) {
    let idx = text.indexOf('\n---', 3);
    while (idx !== -1) {
      const after = idx + 4;
      if (after === text.length || text.charCodeAt(after) === 10) {
        closeAt = idx;
        break;
      }
      idx = text.indexOf('\n---', idx + 1);
    }
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const head = text.slice(4, closeAt);
  if (head.length > 0) {
    const lines = head.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (line.length === 0 || (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9 ? line.trim() === '' : false)) continue;
      if (line.charCodeAt(0) === 35) continue;
      const m = LINE.exec(line);
      if (m === null) return { error: `line ${j + 2} is not "key: value"` };
      const key = m[1];
      let raw = m[2] ?? '';
      if (TRAIL.test(raw)) raw = raw.replace(TRAIL, '');
      if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeAt + 4) };
}

// ------------------------------------------------------------------------------------------------ markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const QUOTE_BODY = /^> ?/;

const isSpaceOrTab = (c) => c === 32 || c === 9;

/** Whether `line` is only spaces and tabs. */
function isBlank(line) {
  const n = line.length;
  if (n === 0) return true;
  if (!isSpaceOrTab(line.charCodeAt(0))) return false;
  for (let i = 1; i < n; i++) if (!isSpaceOrTab(line.charCodeAt(i))) return false;
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** `line` with its spaces and tabs at either end dropped. */
function trimLine(line) {
  const n = line.length;
  let a = 0;
  while (a < n && isSpaceOrTab(line.charCodeAt(a))) a++;
  let b = n;
  while (b > a && isSpaceOrTab(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === n ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  const n = line.length;
  if (n === 0) return true;
  const c0 = line.charCodeAt(0);
  if (isSpaceOrTab(c0)) return isBlank(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const n = line.length;
    if (n === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (isSpaceOrTab(c0) && isBlank(line)) {
      i++;
      continue;
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < total && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(QUOTE_BODY, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    let bullet = null;
    if (c0 === 45 || c0 === 42) bullet = BULLET.exec(line);
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < total) {
        const cur = lines[i];
        const m = marker.exec(cur);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (cur.charCodeAt(0) === 32 && CONTINUED.test(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const joined = [];
      for (const parts of items) joined.push(parts.join('\n'));
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: joined });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const end = s.length - what.length;
  const w0 = what.charCodeAt(0);
  for (let j = from; j <= end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE.has(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL = (c) => c === 92 || c === 96 || c === 42 || c === 91;

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped once, not per character. */
const SPECIAL_RE = /[\\`*\[]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are found by one regex scan, escaped once. */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let plain = 0;
  let i = 0;
  SPECIAL_RE.lastIndex = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (m === null) break;
    i = m.index;
    const c = s.charCodeAt(i);
    if (i > plain) out += escapeHtml(s.slice(plain, i));
    if (c === 92) {
      const nx = s.charCodeAt(i + 1);
      if (i + 1 < n && ESCAPABLE.has(nx)) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      plain = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      plain = i;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        plain = i;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      plain = i;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = mm + 1;
      plain = i;
      continue;
    }
    out += '[';
    i++;
    plain = i;
  }
  if (n > plain) out += escapeHtml(s.slice(plain, n));
  return out;
}

/** `src` rendered: its HTML, its table of contents and its excerpt. */
function renderMarkdown(src, env) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const h = inline(t.text, env);
        html += `<h${t.depth} id="${id}">${h}</h${t.depth}>\n`;
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html: h });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let body = '';
        for (const l of t.lines) body += `${escapeHtml(l)}\n`;
        html += `<pre><code${cls}>${body}</code></pre>\n`;
        break;
      }
      case 'hr':
        html += '<hr>\n';
        break;
      case 'blockquote':
        html += t.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>\n`;
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        html += `${open}\n`;
        for (const item of t.items) html += `<li>${inline(item, env)}</li>\n`;
        html += `</${tag}>\n`;
        break;
      }
      case 'paragraph': {
        const h = inline(t.text, env);
        if (excerpt === null) excerpt = h;
        html += `<p>${h}</p>\n`;
        break;
      }
    }
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const STANDALONE = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = STANDALONE.test(src.slice(lineStart, open)) && STANDALONE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** `src` parsed into its tree of nodes. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 1) body.push({ kind: 'var', path: tok.path });
    else if (tok.t === 2) body.push({ kind: 'raw', path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) out += (i === 0 ? '' : ', ') + textOf(v[i]);
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at a path below `v`, guarded exactly as the reference's lookup guards it. */
function dig(v, names, from) {
  for (let k = from; k < names.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, names[k])) return undefined;
    v = v[names[k]];
  }
  return v;
}

/**
 * `nodes` compiled into the body of a render function, as source. Every path resolves where the compiler can see it:
 * a name bound by an enclosing for is a local, every other head is a key of the one scope object the render is given
 * (a build's vars are flat: site, tags, recent, page, posts, pager or tag), so no scope chain is walked per node.
 *
 * Includes are expanded here rather than left as calls. A call would have to hand the callee the caller's loop
 * variables, which means either threading a scope through every render or rebuilding one per call; expanding leaves
 * every name in one lexical body, so `{% for p in posts %}{% include "card" %}{% endfor %}` reads `p.title` directly.
 * A template already being expanded is a cycle: it stays a call, and the render it reaches has no loop variables of
 * its own to lose (a cycle that reads them is not a shape a site has).
 *
 * `names` interns every dotted path's tail once per template, so all renders share the arrays.
 */
function compile(nodes, bound, at) {
  let src = '';
  const pathSrc = (path) => {
    const local = bound.get(path[0]);
    if (local !== undefined) {
      if (path.length === 1) return local;
      return `dig(${local},P[${at.name(path)}],1)`;
    }
    if (path.length === 1) return `S[${JSON.stringify(path[0])}]`;
    return `dig(S[${JSON.stringify(path[0])}],P[${at.name(path)}],1)`;
  };
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        src += `p.push(${JSON.stringify(n.text)});\n`;
        break;
      case 'var':
        src += `p.push(escOf(${pathSrc(n.path)}));\n`;
        break;
      case 'raw':
        src += `p.push(TEXT(${pathSrc(n.path)}));\n`;
        break;
      case 'if':
        src += `if(TRUTHY(${pathSrc(n.path)})!==${n.not ? 'true' : 'false'}){\n`;
        src += compile(n.then, bound, at);
        if (n.else !== null) {
          src += '}else{\n';
          src += compile(n.else, bound, at);
        }
        src += '}\n';
        break;
      case 'for': {
        const id = at.nextId();
        const a = `_a${id}`;
        const len = `_n${id}`;
        const idx = `_i${id}`;
        src += `{const ${a}=${pathSrc(n.path)};if(Array.isArray(${a})){const ${len}=${a}.length;`;
        src += `for(let ${idx}=0;${idx}<${len};${idx}++){const _e${id}=${a}[${idx}];`;
        src += `const _l${id}={index:${idx}+1,first:${idx}===0,last:${idx}===${len}-1,length:${len}};\n`;
        const inner = new Map(bound);
        inner.set(n.name, `_e${id}`);
        inner.set('loop', `_l${id}`);
        src += compile(n.body, inner, at);
        src += '}}}\n';
        break;
      }
      case 'include': {
        // The reference renders an included template in the scope it is included from, at most INCLUDE_DEPTH deep, and
        // one past that renders nothing. Expanding here reproduces both: the caller's loop variables stay in scope, and
        // the depth count stops the recursion where the reference does.
        if (at.depth >= INCLUDE_DEPTH) break;
        const inner = at.parsed.get(n.name);
        if (inner === undefined) break;
        at.depth++;
        src += compile(inner, bound, at);
        at.depth--;
        break;
      }
    }
  }
  return src;
}

/** Every name a template reads from outside its own loop scopes, includes followed. */
function freeHeads(nodes, bound, acc, templates, depth) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
      const h = n.path[0];
      if (!bound.has(h)) acc.add(h);
    }
    if (n.kind === 'if') {
      freeHeads(n.then, bound, acc, templates, depth);
      if (n.else !== null) freeHeads(n.else, bound, acc, templates, depth);
    } else if (n.kind === 'for') {
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      freeHeads(n.body, inner, acc, templates, depth);
    } else if (n.kind === 'include' && depth < INCLUDE_DEPTH) {
      const t = templates.get(n.name);
      if (t !== undefined) freeHeads(t, bound, acc, templates, depth + 1);
    }
  }
  return acc;
}

/**
 * Every template compiled into its render function (S, ctx, D) => string. Includes expand into the caller, so a
 * template's body is compiled from every place that includes it, each with its own bound loop variables; the word
 * "map" here means all of them at once, so an inner template's paths intern into the same arrays as an outer one's.
 */
function rendererOf(parsed) {
  // One array per distinct dotted path, interned across every render; `dig` reads it from index 1, its head being the
  // part already resolved.
  const keys = [];
  const seen = new Map();
  let next = 0;
  const at = {
    parsed,
    depth: 0,
    nextId() {
      return next++;
    },
    name(path) {
      const key = path.join('\u0000');
      const found = seen.get(key);
      if (found !== undefined) return found;
      seen.set(key, keys.length);
      keys.push(key);
      return keys.length - 1;
    },
  };
  const renders = new Map();
  for (const [name, nodes] of parsed) {
    at.depth = 0;
    renders.set(name, compile(nodes, new Map(), at));
  }
  next = 0;
  const P = keys.map((k) => k.split('\u0000'));
  const templates = new Map();
  for (const [name, body] of renders) {
    // eslint-disable-next-line no-new-func
    const make = new Function('escOf', 'TEXT', 'TRUTHY', 'dig', 'P', 'INCLUDE_DEPTH', `return function render(S,ctx,D){const p=[];let o="";\n${body}return p.join("")+o;}`);
    templates.set(name, make(escOf, textOf, truthy, dig, P, INCLUDE_DEPTH));
  }
  return templates;
}





// ------------------------------------------------------------------------------------------------ build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
function build(input) {
  const parsed = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // A site-only template's rendered bytes are the same on every page of this build; siteOnly marks those.
  const siteOnly = new Set();
  for (const [name, nodes] of parsed) {
    const heads = freeHeads(nodes, new Set(), new Set(), parsed, 0);
    let only = true;
    for (const h of heads) if (h !== 'site') { only = false; break; }
    if (only) siteOnly.add(name);
  }
  for (const [name, fn] of rendererOf(parsed)) templates.set(name, fn);

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const broken = new Set();
  const bySource = new Map();
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;
  for (const s of kept) sources.push(s);

  // 3. Each page's output directory and url, its slug unique in its directory.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if (SCHEME.test(target) || c0 === 47 || c0 === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug.
  const posts = [];
  for (const s of sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags, grouped by slug.
  const bySlugTag = new Map();
  const ownTags = (s) => {
    const raw = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (const name of raw) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlugTag.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlugTag.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlugTag.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlugTag.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, siteOnly, cache: new Map() };
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn({ site, tags: allTags, recent, ...vars }, ctx, 0);
  };
  for (const s of sources) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t, cards) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;

  function cardOf(s) {
    const cached = s.card;
    if (cached !== undefined) return cached;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  }

  function pageOf(s) {
    return {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  function tagOf(t, cardsMap) {
    return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardsMap.get(p)) };
  }
}

/** The entry's answer for one case's input. */
export function run(input) {
  return build(input);
}
