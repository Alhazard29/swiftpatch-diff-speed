// Swiftpatch: a drop-in for makefun-diff 1.0.0's diffPatch({ old, new }) that returns the same patch faster.
//
// run(input) is the drop-in: the same string makefun-diff returns, for any { old, new }. runFile(bytes) answers a
// whole cases.json at once, straight from its bytes to the bytes of answers.json, and returns null for any file it
// does not read exactly as JSON.parse would (the driver then parses the file and calls run on every case).
//
// The answer is makefun-diff's, edit for edit; what changes is how little of the search is carried out.
//
//   1. Every line becomes a small integer, so the search compares integers, never strings. A line of the new text
//      is first compared, four bytes at a time, with the old line it most likely still is; only a line that differs
//      is hashed (two 32-bit rolling hashes in an open-addressing table).
//   2. The furthest-reaching frontier lives in one Int32Array and each step records one byte (deletion or insertion)
//      instead of linked path objects; the script is read back from those bytes at the end.
//   3. Pruning that cannot change the answer. makefun-diff's script is the history of the first path to reach both
//      ends, so every cell on it lies on a shortest script. A cell that provably lies on no script of length <= BOUND
//      (BOUND >= the shortest length) may therefore be treated as unreachable: it could only ever lose, or tie and
//      lose, against a cell of the real script, and the cells of the real script keep their exact values.
//        * BOUND comes from a real edit script: lines that occur exactly once in both texts are chained by a longest
//          increasing subsequence, and the small gaps between chain links are solved exactly.
//        * "Provably on no short script" uses a lower bound on the edits still needed from a point (x, y):
//          the lines left on both sides, less twice the most that can still be kept. Lines unique to both texts
//          can keep at most the longest increasing chain among those still ahead on either side; all other shared
//          lines at most the smaller count left on either side; lines the other text lacks keep nothing.
//
// Every hot loop sits in a function of its own that is called many times, so V8 compiles it from its entry instead
// of patching into a running loop and falling back out of it at the loop's end.

const DEAD = -0x40000000;

// ---------------------------------------------------------------- lines to integers

let tabSize = 1 << 17;
let tabH1 = new Int32Array(tabSize);
let tabH2 = new Int32Array(tabSize);
let tabId = new Int32Array(tabSize);
let idPos = new Int32Array(tabSize); // by id: an old line that is this line, or -1
let nextId = 0;

function growTable() {
  const oldSize = tabSize;
  const h1 = tabH1;
  const h2 = tabH2;
  const id = tabId;
  tabSize = oldSize * 2;
  tabH1 = new Int32Array(tabSize);
  tabH2 = new Int32Array(tabSize);
  tabId = new Int32Array(tabSize);
  const pos = new Int32Array(tabSize);
  pos.set(idPos);
  idPos = pos;
  const mask = tabSize - 1;
  for (let s = 0; s < oldSize; s++) {
    if (id[s] === 0) continue;
    let slot = (h1[s] ^ (h2[s] >>> 7)) & mask;
    while (tabId[slot] !== 0) slot = (slot + 1) & mask;
    tabId[slot] = id[s];
    tabH1[slot] = h1[s];
    tabH2[slot] = h2[s];
  }
}

/** The integer of the line with these two hashes, a new one when no line had them. */
function intern(h1, h2) {
  const mask = tabSize - 1;
  let slot = (h1 ^ (h2 >>> 7)) & mask;
  for (;;) {
    const id = tabId[slot];
    if (id === 0) break;
    if (tabH1[slot] === h1 && tabH2[slot] === h2) return id;
    slot = (slot + 1) & mask;
  }
  const id = ++nextId;
  tabId[slot] = id;
  tabH1[slot] = h1;
  tabH2[slot] = h2;
  idPos[id] = -1;
  if (nextId * 2 >= tabSize) growTable();
  return id;
}

let idsA = new Int32Array(1 << 16);
let idsB = new Int32Array(1 << 16);
let startA = new Int32Array(1 << 16);
let startB = new Int32Array(1 << 16);

function growA() {
  const ids = new Int32Array(idsA.length * 2);
  ids.set(idsA);
  idsA = ids;
  const st = new Int32Array(startA.length * 2);
  st.set(startA);
  startA = st;
}

function growB() {
  const ids = new Int32Array(idsB.length * 2);
  ids.set(idsB);
  idsB = ids;
  const st = new Int32Array(startB.length * 2);
  st.set(startB);
  startB = st;
}

// ---------------------------------------------------------------- lines of a string (the drop-in's path)

/** Cuts text into lines: ids and starts (grown through grow) get each line's integer and offset. Returns the count. */
function scanText(text, isOld) {
  const len = text.length;
  let count = 0;
  let at = 0;
  while (at < len) {
    const from = at;
    let h1 = -2128831035;
    let h2 = 374761393;
    let c = 0;
    while (at < len) {
      c = text.charCodeAt(at++);
      if (c === 10) break;
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = (Math.imul(h2, 1540483477) + c) | 0;
    }
    if (c !== 10) {
      // A last line with no newline is not equal to the same words with one.
      h1 ^= 0x5bd1e995;
      h2 = ~h2;
    }
    const id = intern(h1, h2);
    if (isOld) {
      if (count + 2 >= idsA.length) growA();
      idsA[count] = id;
      startA[count] = from;
    } else {
      if (count + 2 >= idsB.length) growB();
      idsB[count] = id;
      startB[count] = from;
    }
    count++;
  }
  if (isOld) startA[count] = len;
  else startB[count] = len;
  return count;
}

// ---------------------------------------------------------------- lines of a JSON string, read in place

let gBuf = new Uint8Array(0);
let gDv = new DataView(gBuf.buffer);
let gLen = 0;
let hEnd = 0; // after hashLine: where the line ends (past its \n), or where the string's closing quote is
let hId = 0;

/**
 * Hashes the line of a JSON string that starts at pos. Returns 1 for a line ended by \n (hEnd is past it), 2 for a
 * last line with no \n (hEnd is at the closing quote), 0 when the string ends at pos, -1 for a byte this reader does
 * not take (an escape JSON.stringify would not have written here, or the file's end).
 */
function hashLine(pos) {
  const buf = gBuf;
  const len = gLen;
  const from = pos;
  let h1 = -2128831035;
  let h2 = 374761393;
  while (pos < len) {
    const c = buf[pos];
    if (c === 0x5c) {
      const e = buf[pos + 1];
      if (e === 0x6e) {
        hEnd = pos + 2;
        hId = intern(h1, h2);
        return 1;
      }
      // \r \t \" \\ stand for one character each and are the only way JSON.stringify writes it.
      if (e !== 0x72 && e !== 0x74 && e !== 0x22 && e !== 0x5c) return -1;
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = (Math.imul(h2, 1540483477) + c) | 0;
      h1 = Math.imul(h1 ^ e, 16777619);
      h2 = (Math.imul(h2, 1540483477) + e) | 0;
      pos += 2;
      continue;
    }
    if (c === 0x22) {
      hEnd = pos;
      if (pos === from) return 0;
      hId = intern(h1 ^ 0x5bd1e995, ~h2);
      return 2;
    }
    if (c < 0x20) return -1;
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2, 1540483477) + c) | 0;
    pos++;
  }
  return -1;
}

/** Whether the len bytes at a and at b are the same. */
function sameBytes(a, b, len) {
  const dv = gDv;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    if (dv.getInt32(a + i, true) !== dv.getInt32(b + i, true)) return false;
  }
  const buf = gBuf;
  for (; i < len; i++) {
    if (buf[a + i] !== buf[b + i]) return false;
  }
  return true;
}

let nA = 0;
let nB = 0;
let bareA = false;
let bareB = false;

/** Reads the old text, a JSON string whose first byte is at pos. Returns its closing quote's place, or -1. */
function scanOld(pos) {
  let n = 0;
  bareA = false;
  for (;;) {
    const kind = hashLine(pos);
    if (kind < 0) return -1;
    if (kind === 0) break;
    if (n + 2 >= idsA.length) growA();
    idsA[n] = hId;
    startA[n] = pos;
    idPos[hId] = n;
    n++;
    pos = hEnd;
    if (kind === 2) {
      bareA = true;
      break;
    }
  }
  startA[n] = pos;
  nA = n;
  return pos;
}

/** Reads the new text the same way, trying first the old line each line most likely still is. */
function scanNew(pos) {
  const len = gLen;
  const guessable = bareA ? nA - 1 : nA;
  let m = 0;
  let x = 0;
  bareB = false;
  for (;;) {
    if (m + 2 >= idsB.length) growB();
    if (x < guessable) {
      const sa = startA[x];
      const la = startA[x + 1] - sa;
      if (pos + la <= len && sameBytes(sa, pos, la)) {
        idsB[m] = idsA[x];
        startB[m] = pos;
        m++;
        pos += la;
        x++;
        continue;
      }
    }
    const kind = hashLine(pos);
    if (kind < 0) return -1;
    if (kind === 0) break;
    const id = hId;
    idsB[m] = id;
    startB[m] = pos;
    m++;
    pos = hEnd;
    if (kind === 2) {
      bareB = true;
      break;
    }
    // Where the old text goes on from, if this line is one of its lines: just past a skipped line, else past any.
    const p = idPos[id];
    if (p >= 0) x = x + 1 < nA && idsA[x + 1] === id ? x + 2 : p + 1;
  }
  startB[m] = pos;
  nB = m;
  return pos;
}

// ---------------------------------------------------------------- what can still be kept, and a real script's length

let gA = idsA; // the trimmed texts as integers, each followed by a value no line has
let gB = idsB;
let gN = 0;
let gM = 0;

let cntA = new Int32Array(0);
let cntB = new Int32Array(0);
let posA = new Int32Array(0);
let posB = new Int32Array(0);
// Two numbers for every line x, about the lines from x on: [2x] the longest chain among lines unique to both texts,
// [2x + 1] how many other shared lines.
let keepA = new Int32Array(0);
let keepB = new Int32Array(0);
let tails = new Int32Array(0);
let tailAt = new Int32Array(0);
let prev = new Int32Array(0);
let chainI = new Int32Array(0);
let dpRow = new Int32Array(0);
/** Edits to turn A[a0..a1) into B[b0..b1), exactly when the piece is small, else an upper bound. */
function lowerBound(v, len) {
  const t = tails;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Edits to turn A[a0..a1) into B[b0..b1), exactly when the piece is small, else an upper bound. */
function gapCost(a0, a1, b0, b1) {
  const A = gA;
  const B = gB;
  while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) {
    a0++;
    b0++;
  }
  while (a0 < a1 && b0 < b1 && A[a1 - 1] === B[b1 - 1]) {
    a1--;
    b1--;
  }
  const la = a1 - a0;
  const lb = b1 - b0;
  if (la === 0 || lb === 0) return la + lb;
  if (la * lb > 40000) return la + lb;
  // Longest common subsequence by rows.
  if (dpRow.length < lb + 1) dpRow = new Int32Array(lb + 64);
  const row = dpRow;
  row.fill(0, 0, lb + 1);
  for (let i = 0; i < la; i++) {
    const v = A[a0 + i];
    let diag = 0;
    for (let j = 1; j <= lb; j++) {
      const up = row[j];
      if (v === B[b0 + j - 1]) row[j] = diag + 1;
      else if (row[j - 1] > up) row[j] = row[j - 1];
      diag = up;
    }
  }
  return la + lb - 2 * row[lb];
}

/** Fills keepA and keepB for the trimmed texts; returns the length of a real edit script (an upper bound). */
function prepare() {
  const A = gA;
  const B = gB;
  const n = gN;
  const m = gM;
  const idCount = nextId;
  if (cntA.length < idCount + 1) {
    cntA = new Int32Array(idCount + 1024);
    cntB = new Int32Array(idCount + 1024);
    posA = new Int32Array(idCount + 1024);
    posB = new Int32Array(idCount + 1024);
  } else {
    cntA.fill(0, 0, idCount + 1);
    cntB.fill(0, 0, idCount + 1);
  }
  for (let i = 0; i < n; i++) {
    const id = A[i];
    cntA[id]++;
    posA[id] = i;
  }
  for (let j = 0; j < m; j++) {
    const id = B[j];
    cntB[id]++;
    posB[id] = j;
  }
  if (keepA.length < 2 * n + 2) keepA = new Int32Array(2 * n + 2048);
  if (keepB.length < 2 * m + 2) keepB = new Int32Array(2 * m + 2048);
  const most = (n < m ? n : m) + 1;
  if (tails.length < most) {
    tails = new Int32Array(most + 1024);
    tailAt = new Int32Array(most + 1024);
  }
  if (prev.length < n + 1) {
    prev = new Int32Array(n + 1024);
    chainI = new Int32Array(n + 1024);
  }

  // Old text, last line first: the longest chain among the unique lines from x on, and the other shared lines.
  let len = 0;
  let other = 0;
  keepA[2 * n] = 0;
  keepA[2 * n + 1] = 0;
  for (let i = n - 1; i >= 0; i--) {
    const id = A[i];
    const cb = cntB[id];
    if (cb === 1 && cntA[id] === 1) {
      // A chain read backwards falls in the new text's line number: longest strictly rising run of -j.
      const v = 0 - posB[id];
      const at = lowerBound(v, len);
      tails[at] = v;
      tailAt[at] = i;
      prev[i] = at > 0 ? tailAt[at - 1] : -1;
      if (at === len) len++;
    } else if (cb > 0) other++;
    keepA[2 * i] = len;
    keepA[2 * i + 1] = other;
  }
  // The chain itself, first link first (each link's prev is a later line).
  let links = 0;
  for (let i = len > 0 ? tailAt[len - 1] : -1; i >= 0; i = prev[i]) chainI[links++] = i;

  // New text, the same way.
  let lenB = 0;
  other = 0;
  keepB[2 * m] = 0;
  keepB[2 * m + 1] = 0;
  for (let j = m - 1; j >= 0; j--) {
    const id = B[j];
    const ca = cntA[id];
    if (ca === 1 && cntB[id] === 1) {
      const v = 0 - posA[id];
      const at = lowerBound(v, lenB);
      tails[at] = v;
      if (at === lenB) lenB++;
    } else if (ca > 0) other++;
    keepB[2 * j] = lenB;
    keepB[2 * j + 1] = other;
  }

  // A real script: keep every chain link, solve each gap between links.
  let cost = 0;
  let a0 = 0;
  let b0 = 0;
  for (let t = 0; t < links; t++) {
    const i = chainI[t];
    const j = posB[A[i]];
    if (i !== a0 || j !== b0) cost += gapCost(a0, i, b0, j);
    a0 = i + 1;
    b0 = j + 1;
  }
  cost += gapCost(a0, n, b0, m);
  return cost;
}

// ---------------------------------------------------------------- the search

let V = new Int32Array(0);
let choice = new Uint8Array(1 << 21);
let used = 0;
let rowAt = new Int32Array(0);
let rowLo = new Int32Array(0);
let ops = new Uint8Array(0);
let sOff = 0;
let sBound = 0;

/**
 * One row of the search: the furthest point of every diagonal from..to (step 2) with d edits, from the row before.
 * Returns true when a path reached both ends.
 */
function row(d, from, to) {
  const A = gA;
  const B = gB;
  const n = gN;
  const m = gM;
  const KA = keepA;
  const KB = keepB;
  const v = V;
  const ch = choice;
  const off = sOff;
  const total = n + m;
  const budget = sBound - d;
  let u = used;
  for (let k = from; k <= to; k += 2) {
    const at = off + k;
    const l = v[at - 1];
    const r = v[at + 1];
    const xd = l < n ? l + 1 : DEAD;
    const xi = r - k - 1 < m ? r : DEAD;
    // The deletion unless the insertion is strictly further, chosen without a branch (it is a coin toss).
    const ins = (xd - xi) >> 31;
    let px = xd ^ ((xd ^ xi) & ins);
    ch[u++] = ins + 1;
    if (px < 0) {
      v[at] = DEAD;
      continue;
    }
    let py = px - k;
    // A[n] and B[m] hold two different values no line has, so a run of equal lines stops at either end.
    while (A[px] === B[py]) {
      px++;
      py++;
    }
    if (px + py === total) {
      used = u;
      return true;
    }
    // Edits still needed from here are at least the lines left less twice what can still be kept.
    const fx = 2 * px;
    const fy = 2 * py;
    const ua = KA[fx];
    const ub = KB[fy];
    const oa = KA[fx + 1];
    const ob = KB[fy + 1];
    const du = ub - ua;
    const dv = ob - oa;
    const kept = ua + (du & (du >> 31)) + oa + (dv & (dv >> 31));
    const gone = (budget - (total - px - py - 2 * kept)) >> 31; // all ones when it cannot finish in time
    v[at] = (px & ~gone) | (DEAD & gone);
  }
  used = u;
  return false;
}

/**
 * The edit script of the trimmed texts by makefun-diff's rule, as ops[0..D): 1 a deletion, 0 an insertion.
 * Returns D, or -1 if every path was pruned (never, when bound is the length of a real script).
 */
function search(bound) {
  const A = gA;
  const B = gB;
  const n = gN;
  const m = gM;
  const width = 2 * bound + 9;
  const off = bound + 4;
  if (V.length < width) V = new Int32Array(width + 4096);
  V.fill(DEAD, 0, width);
  if (rowAt.length < bound + 2) {
    rowAt = new Int32Array(bound + 1024);
    rowLo = new Int32Array(bound + 1024);
    ops = new Uint8Array(bound + 1024);
  }
  sOff = off;
  sBound = bound;
  used = 0;
  let x = 0;
  while (A[x] === B[x]) x++;
  V[off] = x;
  let D = x >= n && x >= m ? 0 : -1;
  let lo = 0; // the live diagonals of the row before
  let hi = 0;
  for (let d = 1; D < 0; d++) {
    const from = lo - 1;
    const to = hi + 1;
    const need = used + ((to - from) >> 1) + 1;
    if (need > choice.length) {
      const bigger = new Uint8Array(Math.max(choice.length * 2, need));
      bigger.set(choice.subarray(0, used));
      choice = bigger;
    }
    rowAt[d] = used;
    rowLo[d] = from;
    if (row(d, from, to)) {
      D = d;
      break;
    }
    // The live range of this row, found from its two ends.
    const v = V;
    let first = from;
    while (first <= to && v[off + first] < 0) first += 2;
    let last = to;
    while (last >= first && v[off + last] < 0) last -= 2;
    if (first > last) return -1;
    // Diagonals of this row's parity outside its live range may hold older values: the next row reads only these two.
    v[off + first - 2] = DEAD;
    v[off + last + 2] = DEAD;
    lo = first;
    hi = last;
  }
  // Read the script back, last edit first.
  let k = n - m;
  for (let d = D; d > 0; d--) {
    const c = choice[rowAt[d] + ((k - rowLo[d]) >> 1)];
    ops[d - 1] = c;
    k += c === 1 ? -1 : 1;
  }
  return D;
}

// ---------------------------------------------------------------- from the two texts' integers to the change runs

let chg = new Int32Array(0); // the change runs, four numbers each: old line, new line, deletions, insertions
let nChg = 0;
let nDeleted = 0;
let nInserted = 0;

/** The change runs of n old and m new lines (idsA, idsB): makefun-diff's script, walked forward. */
function changes(n, m) {
  let prefix = 0;
  while (prefix < n && prefix < m && idsA[prefix] === idsB[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && idsA[n - 1 - suffix] === idsB[m - 1 - suffix]) suffix++;
  // One slot past each trimmed text holds a value no line has (and not the same one), which ends every run of equal
  // lines without a length test. The lines after the trim are never compared again.
  idsA[n - suffix] = -1;
  idsB[m - suffix] = -2;
  const A = idsA.subarray(prefix, n - suffix + 1);
  const B = idsB.subarray(prefix, m - suffix + 1);
  const an = n - suffix - prefix;
  const bm = m - suffix - prefix;
  gA = A;
  gB = B;
  gN = an;
  gM = bm;

  let D = search(prepare());
  if (D < 0) D = search(an + bm); // with every line as budget nothing is ever pruned

  // Each edit is followed by every line equal in both.
  if (chg.length < 4 * D + 4) chg = new Int32Array(4 * D + 1024);
  const c = chg;
  const o = ops;
  let nc = 0;
  let x = 0;
  let y = 0;
  let deleted = 0;
  let open = false;
  while (A[x] === B[y]) {
    x++;
    y++;
  }
  for (let i = 0; i < D; i++) {
    if (!open) {
      c[nc] = x + prefix;
      c[nc + 1] = y + prefix;
      c[nc + 2] = 0;
      c[nc + 3] = 0;
      open = true;
    }
    if (o[i] === 1) {
      c[nc + 2]++;
      x++;
      deleted++;
    } else {
      c[nc + 3]++;
      y++;
    }
    if (A[x] === B[y]) {
      x++;
      y++;
      while (A[x] === B[y]) {
        x++;
        y++;
      }
      open = false;
      nc += 4;
    }
  }
  if (open) nc += 4;
  nChg = nc;
  nDeleted = deleted;
  nInserted = D - deleted;
}

/** How many hunks the change runs make: runs at most 6 kept lines apart share one. */
function countHunks() {
  const c = chg;
  const nc = nChg;
  let hunks = 0;
  for (let q = 0; q < nc; q += 4) {
    if (q === 0 || c[q] - (c[q - 4] + c[q - 2]) > 6) hunks++;
  }
  return hunks;
}

// ---------------------------------------------------------------- the patch as a string (the drop-in)

/** makefun-diff 1.0.0's patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = input.old;
  const b = input.new;
  tabId.fill(0);
  nextId = 0;
  const n = scanText(a, true);
  const m = scanText(b, false);
  changes(n, m);
  const c = chg;
  const nc = nChg;
  const aBare = a.length > 0 && a.charCodeAt(a.length - 1) !== 10;
  const bBare = b.length > 0 && b.charCodeAt(b.length - 1) !== 10;
  let body = '';
  let hunks = 0;
  let q = 0;
  while (q < nc) {
    let e = q;
    while (e + 4 < nc && c[e + 4] - (c[e] + c[e + 2]) <= 6) e += 4;
    hunks++;
    const firstO = c[q];
    const oldStart = firstO > 3 ? firstO - 3 : 0;
    const newStart = c[q + 1] - (firstO - oldStart);
    const lastEnd = c[e] + c[e + 2];
    const after = n - lastEnd < 3 ? n - lastEnd : 3;
    const oldEnd = lastEnd + after;
    const newEnd = c[e + 1] + c[e + 3] + after;
    body += '@ ' + (oldStart + 1) + ' ' + (oldEnd - oldStart) + ' ' + (newStart + 1) + ' ' + (newEnd - newStart) + '\n';
    let at = oldStart;
    for (; q <= e; q += 4) {
      const o = c[q];
      const p = c[q + 1];
      const dels = c[q + 2];
      const ins = c[q + 3];
      for (; at < o; at++) {
        body += '=' + a.substring(startA[at], startA[at + 1]);
        if (aBare && at === n - 1) body += '\n%\n';
      }
      for (let i = o; i < o + dels; i++) {
        body += '-' + a.substring(startA[i], startA[i + 1]);
        if (aBare && i === n - 1) body += '\n%\n';
      }
      for (let i = p; i < p + ins; i++) {
        body += '+' + b.substring(startB[i], startB[i + 1]);
        if (bBare && i === m - 1) body += '\n%\n';
      }
      at = o + dels;
    }
    for (; at < oldEnd; at++) {
      body += '=' + a.substring(startA[at], startA[at + 1]);
      if (aBare && at === n - 1) body += '\n%\n';
    }
  }
  return 'makefun-diff/1 old=' + n + ' new=' + m + ' hunks=' + hunks + ' deleted=' + nDeleted + ' inserted=' + nInserted + '\n' + body;
}

// ---------------------------------------------------------------- the patch as the bytes of a JSON string

let out = new Uint8Array(1 << 20);
let outAt = 0;

function room(extra) {
  if (outAt + extra <= out.length) return;
  const bigger = new Uint8Array(Math.max(out.length * 2, outAt + extra));
  bigger.set(out.subarray(0, outAt));
  out = bigger;
}

/** Writes the characters of an ASCII string. */
function put(s) {
  const o = out;
  let at = outAt;
  for (let i = 0; i < s.length; i++) o[at++] = s.charCodeAt(i);
  outAt = at;
}

/** Writes a whole number >= 0 in decimal. */
function putNumber(v) {
  const o = out;
  let at = outAt;
  let digits = 1;
  for (let t = v; t >= 10; t = (t / 10) | 0) digits++;
  at += digits;
  outAt = at;
  do {
    o[--at] = 48 + (v % 10);
    v = (v / 10) | 0;
  } while (v > 0);
}

/** Writes op, then the input's bytes from..to: one line as its JSON string holds it, its \n included. */
function putLine(op, from, to) {
  const o = out;
  const buf = gBuf;
  let at = outAt;
  o[at++] = op;
  for (let p = from; p < to; p++) o[at++] = buf[p];
  outAt = at;
}

/** A line that ends its text with no newline is written with one and followed by a line %. */
function putBare() {
  const o = out;
  let at = outAt;
  o[at++] = 0x5c;
  o[at++] = 0x6e;
  o[at++] = 0x25;
  o[at++] = 0x5c;
  o[at++] = 0x6e;
  outAt = at;
}

/** Writes the hunk of change runs q..e (steps of 4) of n old and m new lines. */
function putHunk(q, e, n, m) {
  const c = chg;
  const sa = startA;
  const sb = startB;
  const firstO = c[q];
  const oldStart = firstO > 3 ? firstO - 3 : 0;
  const newStart = c[q + 1] - (firstO - oldStart);
  const lastEnd = c[e] + c[e + 2];
  const after = n - lastEnd < 3 ? n - lastEnd : 3;
  const oldEnd = lastEnd + after;
  const newEnd = c[e + 1] + c[e + 3] + after;
  // Every line of both texts the hunk can show, an op each, the @ line and both texts' % lines.
  room(sa[oldEnd] - sa[oldStart] + (sb[newEnd] - sb[newStart]) + (oldEnd - oldStart) + (newEnd - newStart) + 80);
  put('@ ');
  putNumber(oldStart + 1);
  out[outAt++] = 0x20;
  putNumber(oldEnd - oldStart);
  out[outAt++] = 0x20;
  putNumber(newStart + 1);
  out[outAt++] = 0x20;
  putNumber(newEnd - newStart);
  out[outAt++] = 0x5c;
  out[outAt++] = 0x6e;
  const lastA = bareA ? n - 1 : -1;
  const lastB = bareB ? m - 1 : -1;
  let at = oldStart;
  for (; q <= e; q += 4) {
    const o = c[q];
    const p = c[q + 1];
    const dels = c[q + 2];
    const ins = c[q + 3];
    for (; at < o; at++) {
      putLine(0x3d, sa[at], sa[at + 1]);
      if (at === lastA) putBare();
    }
    for (let i = o; i < o + dels; i++) {
      putLine(0x2d, sa[i], sa[i + 1]);
      if (i === lastA) putBare();
    }
    for (let i = p; i < p + ins; i++) {
      putLine(0x2b, sb[i], sb[i + 1]);
      if (i === lastB) putBare();
    }
    at = o + dels;
  }
  for (; at < oldEnd; at++) {
    putLine(0x3d, sa[at], sa[at + 1]);
    if (at === lastA) putBare();
  }
}

/** Writes one case's answer, a JSON string, from the two texts just read (nA, nB lines). */
function putAnswer() {
  const n = nA;
  const m = nB;
  changes(n, m);
  room(256);
  put('"makefun-diff/1 old=');
  putNumber(n);
  put(' new=');
  putNumber(m);
  put(' hunks=');
  putNumber(countHunks());
  put(' deleted=');
  putNumber(nDeleted);
  put(' inserted=');
  putNumber(nInserted);
  out[outAt++] = 0x5c;
  out[outAt++] = 0x6e;
  const c = chg;
  const nc = nChg;
  let q = 0;
  while (q < nc) {
    let e = q;
    while (e + 4 < nc && c[e + 4] - (c[e] + c[e + 2]) <= 6) e += 4;
    putHunk(q, e, n, m);
    q = e + 4;
  }
  room(8);
  out[outAt++] = 0x22;
}

/** pos past the ASCII string s if the file holds it at pos, else -1. */
function expect(pos, s) {
  const buf = gBuf;
  if (pos + s.length > gLen) return -1;
  for (let i = 0; i < s.length; i++) {
    if (buf[pos + i] !== s.charCodeAt(i)) return -1;
  }
  return pos + s.length;
}

/**
 * The bytes of answers.json for the bytes of a cases.json written the way JSON.stringify writes it
 * ([{"id":"…","input":{"old":"…","new":"…"}},…]), or null for any other file: the caller then parses it and calls run.
 */
export function runFile(bytes) {
  gBuf = bytes;
  gLen = bytes.length;
  gDv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  outAt = 0;
  room(16);
  let pos = expect(0, '[');
  if (pos < 0) return null;
  out[outAt++] = 0x5b;
  let count = 0;
  if (bytes[pos] !== 0x5d) {
    for (;;) {
      pos = expect(pos, '{"id":"');
      if (pos < 0) return null;
      while (pos < gLen && bytes[pos] !== 0x22) {
        if (bytes[pos] === 0x5c) return null;
        pos++;
      }
      pos = expect(pos, '","input":{"old":"');
      if (pos < 0) return null;
      tabId.fill(0);
      nextId = 0;
      pos = scanOld(pos);
      if (pos < 0) return null;
      pos = expect(pos, '","new":"');
      if (pos < 0) return null;
      pos = scanNew(pos);
      if (pos < 0) return null;
      pos = expect(pos, '"}}');
      if (pos < 0) return null;
      if (count++ > 0) out[outAt++] = 0x2c;
      putAnswer();
      if (bytes[pos] === 0x2c) {
        pos++;
        continue;
      }
      break;
    }
  }
  if (bytes[pos] !== 0x5d || pos + 1 !== gLen) return null;
  room(4);
  out[outAt++] = 0x5d;
  return out.subarray(0, outAt);
}

// ---------------------------------------------------------------- a rehearsal

/**
 * Answers a few small made-up files before the real one, so V8 has seen every branch of the code above when it
 * compiles it (code compiled on partial knowledge is thrown away the first time the real file takes a new branch).
 * WARM_ROUNDS is how many times; the made-up files come from a fixed generator, so every run does the same work.
 */
const WARM_ROUNDS = 4;

function rehearsalFile(seed, lines, bare) {
  let s = seed;
  const next = (k) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 9) % k;
  };
  const eol = bare ? '\\r\\n' : '\\n';
  const line = () => (next(4) === 0 ? ['', '}', '  }', 'end'][next(4)] : 'line \\t' + next(100000) + ' \\"q\\" ' + next(7)) + eol;
  let text = '[';
  for (let c = 0; c < 2; c++) {
    const old = [];
    for (let i = 0; i < lines; i++) old.push(line());
    const neu = [];
    for (let i = 0; i < lines; i++) {
      const r = next(60);
      if (r === 0) continue;
      if (r === 1) neu.push(line());
      if (r === 2) {
        neu.push(line());
        continue;
      }
      if (r === 3 && i + 40 < lines) {
        for (let j = 0; j < 6; j++) neu.push(old[i + 30 + j]);
      }
      neu.push(old[i]);
    }
    let a = old.join('');
    let b = neu.join('');
    if (bare && c === 0) a = a.slice(0, a.length - eol.length);
    if (bare && c === 1) b = b.slice(0, b.length - eol.length);
    text += (c ? ',' : '') + '{"id":"w-' + c + '","input":{"old":"' + a + '","new":"' + b + '"}}';
  }
  text += ']';
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

{
  const files = [rehearsalFile(7, 500, false), rehearsalFile(11, 700, true)];
  for (let r = 0; r < WARM_ROUNDS; r++) runFile(files[r & 1]);
}
