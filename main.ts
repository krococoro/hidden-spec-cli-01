// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), finds the
// lines each edit names at the first of three matching tiers, and writes every
// change or none, printing what it changed or why it failed. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

interface Move {
  old: string;
  new: string;
}

type Edit = (tree: Tree) => Move | null;

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

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line compared at a tier (SPEC.md section 5): 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at which O occurs in `lines` at `tier`, at or after `from`; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const k = o.length;
  const out: number[] = [];
  if (k === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]!) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier (0, 1, 2; only 0 with --strict) at which O occurs at least once. */
function findFirstTier(lines: string[], o: string[], from: number, strict: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

type LineKind = 'ctx' | 'old' | 'new';
interface LineItem {
  text: string;
  kind: LineKind;
}

/**
 * The lines that replace the matched lines: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line of N
 * is re-indented (the leading spaces/tabs P of O's first line replaced by F,
 * those of the file's first matched line).
 */
function buildReplacement(fileLines: string[], pos: number, oItems: LineItem[], nItems: LineItem[], tier: number): string[] {
  const oCtx: number[] = [];
  oItems.forEach((it, idx) => {
    if (it.kind === 'ctx') oCtx.push(idx);
  });
  const f = fileLines[pos] === undefined ? '' : leadingWs(fileLines[pos]!);
  const p = oItems.length === 0 ? '' : leadingWs(oItems[0]!.text);
  let ctxSeen = 0;
  return nItems.map((it) => {
    if (it.kind === 'ctx') {
      const oi = oCtx[ctxSeen];
      ctxSeen += 1;
      return oi === undefined ? it.text : fileLines[pos + oi]!;
    }
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return it.text;
  });
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` / `+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const raw = (tab < 0 ? rest : rest.slice(0, tab)).trim();
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

/** Parse one hunk body starting after the header at `start`; returns the index after the body. */
function parseHunk(lines: string[], start: number, sec: USection, a: number): number {
  const n = lines.length;
  const body: HunkBodyLine[] = [];
  let i = start + 1;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '', raw: line });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ') body.push({ kind: 'ctx', text: line.slice(1), raw: line });
    else if (c === '-') body.push({ kind: 'old', text: line.slice(1), raw: line });
    else if (c === '+') body.push({ kind: 'new', text: line.slice(1), raw: line });
    else if (c === '\\') body.push({ kind: 'bs', text: line.slice(1), raw: line });
    else break;
    i += 1;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  sec.hunks.push({ a, body });
  return i;
}

/**
 * Parse one section's header and hunks starting at `start`; returns the index
 * of the line that starts the next section (or the end of the patch).
 */
function parseSection(lines: string[], start: number, sec: USection): number {
  const n = lines.length;
  let i = start;
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (inHeader) {
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          pairOld = headerPath(line);
          pairNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec.newFileMode = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec.deletedFileMode = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        i = parseHunk(lines, i, sec, parseInt(m[1]!, 10));
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      if (DIFF_GIT.exec(line) === null) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(lines, i, sec, parseInt(m[1]!, 10));
      continue;
    }
    i += 1;
  }
  if (pairOld !== undefined) sec.oldPath = pairOld;
  else if (renameFrom !== null) sec.oldPath = renameFrom;
  if (pairNew !== undefined) sec.newPath = pairNew;
  else if (renameTo !== null) sec.newPath = renameTo;
  return i;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = DIFF_GIT.exec(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = { oldPath: dg[1]!, newPath: dg[2]!, newFileMode: false, deletedFileMode: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { oldPath: null, newPath: null, newFileMode: false, deletedFileMode: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): FileState {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const oItems: LineItem[] = [];
    const nItems: LineItem[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        oItems.push({ text: b.text, kind: 'ctx' });
        nItems.push({ text: b.text, kind: 'ctx' });
      } else if (b.kind === 'old') oItems.push({ text: b.text, kind: 'old' });
      else if (b.kind === 'new') nItems.push({ text: b.text, kind: 'new' });
    }
    const oLines = oItems.map((x) => x.text);
    let lastCtxNew = -1;
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'new') lastCtxNew = k;
    }
    const bsAfter = lastCtxNew >= 0 && h.body[lastCtxNew + 1] !== undefined && h.body[lastCtxNew + 1]!.kind === 'bs';
    if (oLines.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > f.lines.length) at = f.lines.length;
      const atEnd = at === f.lines.length;
      const ins = nItems.map((x) => x.text);
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !bsAfter;
      d += nItems.length;
    } else {
      const found = findFirstTier(f.lines, oLines, 0, strict);
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
      const atEnd = best + oLines.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, oItems, nItems, found.tier);
      f.lines.splice(best, oLines.length, ...repl);
      if (atEnd) f.final = !bsAfter;
      d += nItems.length - oLines.length;
    }
  }
  return f;
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || sec.newFileMode) {
      if (newP === null) return null;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === 'new') {
            lines.push(h.body[k]!.text);
            lastPlus = { hunk: h, idx: k };
          }
        }
      }
      let final = true;
      if (lastPlus !== null) {
        const next = lastPlus.hunk.body[lastPlus.idx + 1];
        if (next !== undefined && next.kind === 'bs') final = false;
      }
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : ''));
      return null;
    }
    if (newP === null || sec.deletedFileMode) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return null;
    }
    if (oldP !== newP) {
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = applyHunks(cur, sec.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(f));
      return { old: oldP, new: newP };
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const f = applyHunks(cur, sec.hunks, oldP, strict);
    tree.now.set(oldP, serializeFile(f));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return null;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = parseFile(cur);
    const found = findFirstTier(f.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length !== 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const oItems: LineItem[] = b.oldLines.map((t) => ({ text: t, kind: 'old' as LineKind }));
    const nItems: LineItem[] = b.newLines.map((t) => ({ text: t, kind: 'new' as LineKind }));
    const repl = buildReplacement(f.lines, pos, oItems, nItems, found.tier);
    f.lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(p, serializeFile(f));
    return null;
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: LineKind; text: string }[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

function findAnchor(lines: string[], from: number, anchor: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = normLine(anchor, tier);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, tier) === want) return i;
    }
  }
  return -1;
}

function findChunkOccurrence(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(lines, o, tier, from);
    if (eof) {
      const end = occ.find((pos) => pos + o.length === lines.length);
      if (end !== undefined) return { pos: end, tier };
    } else if (occ.length > 0) {
      return { pos: occ[0]!, tier };
    }
  }
  return null;
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree: Tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return null;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = parseFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const idx = findAnchor(f.lines, cursor, ch.anchor, strict);
        if (idx < 0) throw new Fail('no-match', p);
        cursor = idx + 1;
      }
      const oItems: LineItem[] = [];
      const nItems: LineItem[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          oItems.push({ text: b.text, kind: 'ctx' });
          nItems.push({ text: b.text, kind: 'ctx' });
        } else if (b.kind === 'old') oItems.push({ text: b.text, kind: 'old' });
        else nItems.push({ text: b.text, kind: 'new' });
      }
      const oLines = oItems.map((x) => x.text);
      if (oLines.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = nItems.map((x) => x.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findChunkOccurrence(f.lines, oLines, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const repl = buildReplacement(f.lines, found.pos, oItems, nItems, found.tier);
        f.lines.splice(found.pos, oLines.length, ...repl);
        cursor = found.pos + repl.length;
      }
    }
    const text = serializeFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      return { old: p, new: sec.moveTo };
    }
    tree.now.set(p, text);
    return null;
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const startLine = i + 1;
    i += 1;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      raw.push({ text: l, num: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aSectionEdit({ kind, path, moveTo: null, lines: fileLines, chunks: [] }, strict));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aSectionEdit({ kind, path, moveTo: null, lines: [], chunks: [] }, strict));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({
            kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
            text: l === '' ? '' : l.slice(1),
          });
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(v4aSectionEdit({ kind, path, moveTo, lines: [], chunks }, strict));
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                     */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      return null;
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
      return null;
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
      return null;
    };
  }
  return null;
}

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

/* ------------------------------------------------------------------ */
/* Command line, output and exit codes (SPEC.md sections 1, 2 and 10) */
/* ------------------------------------------------------------------ */

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
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== null) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, text: `A ${p}` });
    else if (now === null) rows.push({ key: p, text: `D ${p}` });
    else rows.push({ key: p, text: `M ${p}` });
  }
  for (const m of moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      const di = rows.findIndex((r) => r.text === `D ${m.old}`);
      const ai = rows.findIndex((r) => r.text === `A ${m.new}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      }
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
