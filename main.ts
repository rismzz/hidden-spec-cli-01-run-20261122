// mend: the command-line tool SPEC.md specifies. It applies an edit an AI model wrote,
// in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool
// calls), to a tree of text files: every file is changed or nothing is. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Sections of SPEC.md: 1 the command line, 2 output and exit codes, 3 files, lines and
// paths, 4 detecting the format, 5 matching lines at three tiers, 6 unified diffs,
// 7 SEARCH/REPLACE blocks, 8 V4A patches, 9 JSON edits, 10 order and atomicity.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Line equality at one matching tier: 0 exact, 1 trailing space/tab ignored, 2 both ends ignored. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occursAt(file: string[], at: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j++) {
    if (!tierEq(file[at + j]!, o[j]!, tier)) return false;
  }
  return true;
}

function findOccurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i++) {
    if (occursAt(file, i, o, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which o occurs, with every occurrence there; null when it never occurs. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of the new text: a context line (its index in O) or a line the patch writes. */
type NLine = { ctx: number } | { text: string };

/**
 * Resolve the new lines: a context line is the file's own matched line, never the
 * patch's; at tier 2 every other line is re-indented from O's first line to the file's.
 */
function resolveN(n: NLine[], file: string[], at: number, o: string[], tier: number): string[] {
  const f = at < file.length ? leadWs(file[at]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  for (const e of n) {
    if ('ctx' in e) {
      out.push(file[at + e.ctx]!);
      continue;
    }
    let s = e.text;
    if (tier === 2 && s !== '' && !wsOnly(s) && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

/** Detect the format (section 4), or null when no format holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** The JSON edits of a patch (section 9): one array, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function devNull(p: string): string | null {
  return p === '/dev/null' ? null : p;
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, trimmed. */
function headerPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function parseHunkHeader(l: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

function parseDiffGit(l: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

/** Split a hunk body into its old lines and its new lines; a `\` after the last context or `+` line. */
function splitHunk(body: string[]): { o: string[]; n: NLine[]; noFinal: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxAdd = -1;
  for (let j = 0; j < body.length; j++) {
    const l = body[j]!;
    if (l.startsWith(' ')) {
      n.push({ ctx: o.length });
      o.push(l.slice(1));
      lastCtxAdd = j;
    } else if (l === '') {
      // An empty body line is a context line whose text is empty.
      n.push({ ctx: o.length });
      o.push('');
      lastCtxAdd = j;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1) });
      lastCtxAdd = j;
    }
  }
  const noFinal = lastCtxAdd >= 0 && body[lastCtxAdd + 1] !== undefined && body[lastCtxAdd + 1]!.startsWith('\\');
  return { o, n, noFinal };
}

/** A created file ends with a line break unless a `\` line follows its last `+` line. */
function creationNoFinal(hunks: Hunk[]): boolean {
  let lastH = -1;
  let lastJ = -1;
  for (let hi = 0; hi < hunks.length; hi++) {
    const b = hunks[hi]!.body;
    for (let j = 0; j < b.length; j++) {
      if (b[j]!.startsWith('+')) {
        lastH = hi;
        lastJ = j;
      }
    }
  }
  if (lastH < 0) return false;
  const b = hunks[lastH]!.body;
  return b[lastJ + 1] !== undefined && b[lastJ + 1]!.startsWith('\\');
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyUnifiedHunks(f: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, noFinal } = splitHunk(h.body);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      const ins = n.map((e) => ('text' in e ? e.text : ''));
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !noFinal;
      d += ins.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const ins = resolveN(n, f.lines, best, o, found.tier);
    const atEnd = best + o.length === f.lines.length;
    f.lines.splice(best, o.length, ...ins);
    if (atEnd) f.final = !noFinal;
    d += ins.length - o.length;
  }
}

function parseUnifiedSections(lines: string[]): UniSection[] {
  const secs: UniSection[] = [];
  const n = lines.length;
  let cur: UniSection | null = null;
  let state: 'out' | 'hdr' | 'body' | 'aft' = 'out';
  let body: string[] = [];
  let hunkA = 0;
  const begin = (dOld: string | undefined, dNew: string | undefined): void => {
    cur = {
      pairOld: undefined,
      pairNew: undefined,
      hasPair: false,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: dOld,
      diffNew: dNew,
      creation: false,
      deletion: false,
      hunks: [],
    };
    secs.push(cur);
    state = 'hdr';
  };
  const endBody = (): void => {
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    cur!.hunks.push({ a: hunkA, body });
    body = [];
    state = 'aft';
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    const no = i + 1;
    if (state === 'body') {
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        body.push(l);
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const [dOld, dNew] = parseDiffGit(l, no);
      begin(dOld, dNew);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'hdr' && cur !== null && !cur.hasPair) {
        cur.pairOld = devNull(stripAB(headerPath(l)));
        cur.pairNew = devNull(stripAB(headerPath(lines[i + 1]!)));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      begin(undefined, undefined);
      cur!.pairOld = devNull(stripAB(headerPath(l)));
      cur!.pairNew = devNull(stripAB(headerPath(lines[i + 1]!)));
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (state === 'out') {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${no}`);
      i++;
      continue;
    }
    if (state === 'hdr') {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (l.startsWith('+++ ')) {
        cur!.pairNew = devNull(stripAB(headerPath(l)));
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        hunkA = parseHunkHeader(l, no);
        body = [];
        state = 'body';
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur!.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur!.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur!.creation = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur!.deletion = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      hunkA = parseHunkHeader(l, no);
      body = [];
      state = 'body';
      i++;
      continue;
    }
    i++;
  }
  if (state === 'body') endBody();
  return secs;
}

/** One unified section is one edit: a creation, a deletion, a move, or a change. */
function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.pairNew !== undefined ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
  const oldP = oldPath === undefined ? '' : oldPath;
  const newP = newPath === undefined ? '' : newPath;
  if (sec.creation || oldPath === null) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      for (const h of sec.hunks) {
        for (const l of h.body) {
          if (l.startsWith('+')) out.push(l.slice(1));
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (creationNoFinal(sec.hunks) ? '' : '\n'));
    };
  }
  if (sec.deletion || newPath === null) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(cur);
      applyUnifiedHunks(f, sec.hunks, strict, oldP);
      tree.now.set(newP, renderFile(f));
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, nw: newP });
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const f = parseFile(cur);
    applyUnifiedHunks(f, sec.hunks, strict, oldP);
    tree.now.set(oldP, renderFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnifiedSections(lines).map((s) => uniSectionEdit(s, strict));
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t }));
    const ins = resolveN(n, f.lines, at, oldLines, found.tier);
    f.lines.splice(at, oldLines.length, ...ins);
    tree.now.set(path, renderFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---- section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, raw: string[], sectionLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    idx = 1;
  }
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    const no = sectionLine + 1 + idx;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, o: [], n: [], eof: false };
        chunks.push(cur);
      }
      if (l.startsWith(' ')) {
        cur.n.push({ ctx: cur.o.length });
        cur.o.push(l.slice(1));
      } else if (l.startsWith('-')) {
        cur.o.push(l.slice(1));
      } else if (l.startsWith('+')) {
        cur.n.push({ text: l.slice(1) });
      } else {
        cur.n.push({ ctx: cur.o.length });
        cur.o.push('');
      }
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(curText);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers) {
          for (let j = cursor; j < f.lines.length; j++) {
            if (tierEq(f.lines[j]!, ch.anchor, t)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((e) => ('text' in e ? e.text : ''));
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      let tier = -1;
      let at = -1;
      for (const t of tiers) {
        for (let j = cursor; j + ch.o.length <= f.lines.length; j++) {
          if (!occursAt(f.lines, j, ch.o, t)) continue;
          if (ch.eof && j + ch.o.length !== f.lines.length) continue;
          at = j;
          tier = t;
          break;
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      const ins = resolveN(ch.n, f.lines, at, ch.o, tier);
      f.lines.splice(at, ch.o.length, ...ins);
      cursor = at + ins.length;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      let end = last;
      for (let j = i + 1; j < last; j++) {
        const lj = lines[j]!;
        if (lj.startsWith('*** Add File: ') || lj.startsWith('*** Delete File: ') || lj.startsWith('*** Update File: ')) {
          end = j;
          break;
        }
      }
      const raw = lines.slice(i + 1, end);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      if (l.startsWith('*** Add File: ')) {
        const path = l.slice(14).trim();
        const fileLines: string[] = [];
        for (let k = 0; k < raw.length; k++) {
          const rl = raw[k]!;
          if (rl === '') fileLines.push('');
          else if (rl.startsWith('+')) fileLines.push(rl.slice(1));
          else throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        edits.push(vAddEdit(path, fileLines));
      } else if (l.startsWith('*** Delete File: ')) {
        const path = l.slice(17).trim();
        for (let k = 0; k < raw.length; k++) {
          if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
        }
        edits.push(vDeleteEdit(path));
      } else {
        edits.push(vUpdateEdit(l.slice(17).trim(), raw, i + 1, strict));
      }
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ---- sections 1, 2 and 10: the command line, the output, and the write ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      movedOld.add(m.old);
      movedNew.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
