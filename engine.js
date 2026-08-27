/* MIRSH/70 engine. Pure business logic: no DOM, no timers, no storage access.
   Loads from a <script> tag (window.Engine) and from node (module.exports). */
(function (factory) {
  var Engine = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof window !== 'undefined') window.Engine = Engine;
})(function () {
  'use strict';

  var SCHEMA_VERSION = 2;
  var RELEASE = '1.0';

  /* ------------------------------------------------------------------ *
   * Settings and document
   * ------------------------------------------------------------------ */

  function defaultSettings() {
    return {
      ranks: [
        { name: "VERD'IKA", cost: 0 },
        { name: 'VERD', cost: 200 },
        { name: "VER'ALOR", cost: 2500 },
        { name: "AL'VERDE", cost: 5000 },
        { name: "ALIIT'ALOR", cost: 10000 },
        { name: "MAND'ALOR", cost: null } // cannot be bought; RANK SET only
      ],
      vaultMinRank: 'VERD',
      vaultDiscountPct: { "VER'ALOR": 5, "AL'VERDE": 10, "ALIIT'ALOR": 10, "MAND'ALOR": 10 },
      recruitRewardHp: 100,
      recruitWeekDays: 7,
      taxMonthlyHp: 200,
      taxNoticeDays: 14,
      afkMaxDays: 60,
      cashPerHp: 250,
      cashMarkupPct: 0,
      cashBuyCapHp: 1000,
      defaultSpawn: 'Mardurak',
      systemName: 'MIRSH/70',
      prompt: 'READY',
      theme: 'GREEN',
      baud: 'OFF',
      crt: false,
      sound: false,
      greenbar: true
    };
  }

  function newDocument() {
    return {
      schemaVersion: SCHEMA_VERSION,
      citizens: [],
      ledger: [],
      jobs: [],
      vault: [],
      recruits: [],
      housing: [],
      positions: [],
      notices: [],
      syslog: [],
      settings: defaultSettings(),
      counters: { CIT: 0, LDG: 0, JOB: 0, VLT: 0, REC: 0, HSE: 0, POS: 0, NOT: 0 },
      lastTaxRun: null,
      lastRentRun: null,
      lastSalaryRun: null
    };
  }

  /* Migrate an older document forward to the current schemaVersion.
     v1 -> v2: notices[], positions[], lastSalaryRun and several settings keys
     were added in v2; fill anything missing with defaults. */
  function migrate(doc) {
    if (!doc || typeof doc !== 'object') return newDocument();
    if (typeof doc.schemaVersion !== 'number') doc.schemaVersion = 1;
    while (doc.schemaVersion < SCHEMA_VERSION) {
      if (doc.schemaVersion === 1) {
        if (!doc.notices) doc.notices = [];
        if (!doc.positions) doc.positions = [];
        if (!doc.housing) doc.housing = [];
        if (!doc.recruits) doc.recruits = [];
        if (!doc.syslog) doc.syslog = [];
        if (doc.lastSalaryRun === undefined) doc.lastSalaryRun = null;
        if (doc.lastRentRun === undefined) doc.lastRentRun = null;
        if (doc.lastTaxRun === undefined) doc.lastTaxRun = null;
        var defs = defaultSettings();
        doc.settings = doc.settings || {};
        for (var k in defs) if (doc.settings[k] === undefined) doc.settings[k] = defs[k];
        doc.counters = doc.counters || {};
        var defc = newDocument().counters;
        for (var c in defc) if (doc.counters[c] === undefined) doc.counters[c] = defc[c];
        doc.schemaVersion = 2;
      } else {
        doc.schemaVersion = SCHEMA_VERSION; // unknown intermediate: stamp current
      }
    }
    return doc;
  }

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function nextId(doc, key) {
    doc.counters[key] = (doc.counters[key] || 0) + 1;
    var width = key === 'LDG' ? 6 : 4;
    return key + '-' + pad(doc.counters[key], width);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Timestamps are ISO UTC to the minute: 2026-08-26T14:02Z */
  function ts(ctx) {
    var d = new Date(ctx.now);
    return d.toISOString().slice(0, 16) + 'Z';
  }

  function localDateParts(iso) {
    var d = new Date(iso);
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2),
      time: pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2)
    };
  }

  function fmtLocal(tsStr) {
    if (!tsStr) return '-';
    var p = localDateParts(tsStr);
    return p.date + ' ' + p.time;
  }

  function todayLocal(ctx) { return localDateParts(ctx.now).date; }

  /* Dates accept YYYY-MM-DD, TODAY, or +N (days from now). Returns YYYY-MM-DD. */
  function parseDate(s, ctx) {
    if (s === undefined || s === null || s === '') return null;
    var t = String(s).trim().toUpperCase();
    if (t === 'TODAY') return todayLocal(ctx);
    var plus = t.match(/^\+(\d+)$/);
    if (plus) return addDays(todayLocal(ctx), parseInt(plus[1], 10));
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      var d = new Date(t + 'T00:00:00');
      if (!isNaN(d.getTime())) return t;
    }
    throw errObj('0010', 'BAD DATE "' + s + '". USE YYYY-MM-DD, TODAY, OR +N.');
  }

  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  function daysBetween(aIso, bIso) {
    return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000;
  }

  /* Amounts are whole HP; commas tolerated on input. */
  function parseAmount(s, what) {
    var t = String(s).replace(/,/g, '').trim();
    if (!/^-?\d+$/.test(t)) throw errObj('0011', 'BAD AMOUNT "' + s + '" FOR ' + (what || 'VALUE') + '. WHOLE HP ONLY.');
    return parseInt(t, 10);
  }

  function parsePositive(s, what) {
    var n = parseAmount(s, what);
    if (n <= 0) throw errObj('0011', 'AMOUNT FOR ' + (what || 'VALUE') + ' MUST BE POSITIVE.');
    return n;
  }

  function fmtHp(n) {
    var neg = n < 0;
    var s = String(Math.abs(n));
    var out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (neg ? '-' : '') + s + out;
  }

  function rpad(s, w) { s = String(s); while (s.length < w) s += ' '; return s.length > w ? s.slice(0, w) : s; }
  function lpad(s, w) { s = String(s); while (s.length < w) s = ' ' + s; return s; }

  /* ------------------------------------------------------------------ *
   * Line printer report layout: 132 columns, page header, end marker
   * ------------------------------------------------------------------ */

  var PAGE_WIDTH = 132;
  var PAGE_BODY_LINES = 58;

  function center(s, w) {
    s = String(s);
    if (s.length >= w) return s.slice(0, w);
    var left = Math.floor((w - s.length) / 2);
    return new Array(left + 1).join(' ') + s;
  }

  function makeReport(doc, ctx, title, bodyLines) {
    var out = [];
    var stampL = fmtLocal(ctx.now);
    var pages = [];
    for (var i = 0; i < bodyLines.length; i += PAGE_BODY_LINES) {
      pages.push(bodyLines.slice(i, i + PAGE_BODY_LINES));
    }
    if (pages.length === 0) pages.push([]);
    pages.forEach(function (page, p) {
      var left = doc.settings.systemName + '  SORRENTO CENTRAL COMPUTING';
      var right = stampL + '  OPERATOR ' + (ctx.operator ? ctx.operator.toUpperCase() : '----') +
        '  PAGE ' + pad(p + 1, 3);
      var mid = title.toUpperCase();
      var midStart = Math.max(left.length + 2, Math.floor((PAGE_WIDTH - mid.length) / 2));
      var header = rpad(left, midStart) + mid;
      header = rpad(header, PAGE_WIDTH - right.length - 1) + ' ' + right;
      out.push(header);
      out.push(new Array(PAGE_WIDTH + 1).join('-'));
      out.push('');
      page.forEach(function (l) { out.push(rpad(l, PAGE_WIDTH)); });
      if (p < pages.length - 1) out.push('');
    });
    out.push('');
    out.push(center('*** END OF REPORT ***', PAGE_WIDTH));
    return { title: title.toUpperCase(), lines: out };
  }

  /* ------------------------------------------------------------------ *
   * Errors, pending confirmations
   * ------------------------------------------------------------------ */

  function errObj(code, msg) {
    return { __err: true, code: code, msg: msg };
  }

  function pendingObj(summary) {
    return { __pending: true, summary: summary };
  }

  /* ------------------------------------------------------------------ *
   * Lookups
   * ------------------------------------------------------------------ */

  function findCitizen(doc, ref) {
    if (ref === undefined || ref === null || ref === '') throw errObj('0004', 'CITIZEN REQUIRED.');
    var t = String(ref).trim();
    var up = t.toUpperCase();
    var i;
    if (/^CIT-\d+$/.test(up)) {
      for (i = 0; i < doc.citizens.length; i++) if (doc.citizens[i].id === up) return doc.citizens[i];
      throw errObj('0005', 'NO CITIZEN ' + up + '.');
    }
    for (i = 0; i < doc.citizens.length; i++) {
      if (doc.citizens[i].ign.toUpperCase() === up) return doc.citizens[i];
    }
    throw errObj('0005', 'UNKNOWN CITIZEN "' + t + '". TYPE CIT LIST.');
  }

  function findById(doc, coll, id, label) {
    var up = String(id).trim().toUpperCase();
    for (var i = 0; i < doc[coll].length; i++) if (doc[coll][i].id === up) return doc[coll][i];
    throw errObj('0005', 'NO ' + label + ' ' + up + '.');
  }

  function balance(doc, citizenId) {
    var b = 0;
    for (var i = 0; i < doc.ledger.length; i++) {
      if (doc.ledger[i].citizenId === citizenId) b += doc.ledger[i].delta;
    }
    return b;
  }

  /* Ranks. Comparison strips apostrophes: VERDIKA matches VERD'IKA.
     Exact match wins over prefix; otherwise a unique prefix is accepted. */
  function normRank(s) { return String(s).toUpperCase().replace(/'/g, ''); }

  function resolveRank(doc, input) {
    var ranks = doc.settings.ranks;
    var want = normRank(input);
    var i;
    for (i = 0; i < ranks.length; i++) if (normRank(ranks[i].name) === want) return ranks[i].name;
    var hits = [];
    for (i = 0; i < ranks.length; i++) if (normRank(ranks[i].name).indexOf(want) === 0) hits.push(ranks[i].name);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw errObj('0003', 'AMBIGUOUS RANK "' + input + '": ' + hits.join(', '));
    throw errObj('0005', 'UNKNOWN RANK "' + input + '". TYPE RANK TABLE.');
  }

  function rankIndex(doc, name) {
    var ranks = doc.settings.ranks;
    for (var i = 0; i < ranks.length; i++) if (ranks[i].name === name) return i;
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * Ledger
   * ------------------------------------------------------------------ */

  var CATEGORIES = ['JOB', 'RECRUIT', 'EVENT', 'POLITICAL', 'DONATION', 'CASHBUY', 'VAULT',
    'RANK', 'TAX', 'RENT', 'SALARY', 'SUBCLAIM', 'ADJUST', 'REVERSAL'];

  function resolveCategory(input) {
    var up = String(input).toUpperCase();
    if (CATEGORIES.indexOf(up) >= 0) return up;
    var hits = CATEGORIES.filter(function (c) { return c.indexOf(up) === 0; });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw errObj('0003', 'AMBIGUOUS CATEGORY "' + input + '": ' + hits.join(', '));
    throw errObj('0005', 'UNKNOWN CATEGORY "' + input + '". CATEGORIES: ' + CATEGORIES.join(' '));
  }

  function postLedger(doc, ctx, entry) {
    var line = {
      id: nextId(doc, 'LDG'),
      ts: ts(ctx),
      citizenId: entry.citizenId,
      delta: entry.delta,
      balanceAfter: balance(doc, entry.citizenId) + entry.delta,
      category: entry.category,
      reason: entry.reason || '',
      ref: entry.ref || null,
      operator: ctx.operator,
      reversesId: entry.reversesId || null
    };
    doc.ledger.push(line);
    return line;
  }

  /* Single-line fixed-order rendering, parseable later by a bot. */
  function fmtLedgerLine(doc, l) {
    var cit = null;
    for (var i = 0; i < doc.citizens.length; i++) if (doc.citizens[i].id === l.citizenId) cit = doc.citizens[i];
    var ign = cit ? cit.ign : l.citizenId;
    return l.id + ' ' + l.ts + ' IGN=' + ign +
      ' DELTA=' + (l.delta >= 0 ? '+' : '') + l.delta +
      ' BAL=' + l.balanceAfter +
      ' CAT=' + l.category +
      (l.ref ? ' REF=' + l.ref : '') +
      ' BY=' + (l.operator || '-') +
      ' "' + l.reason + '"';
  }

  function pushSyslog(doc, ctx, line) {
    doc.syslog.push({ ts: ts(ctx), operator: ctx.operator || '-', line: line });
    while (doc.syslog.length > 2000) doc.syslog.shift();
  }

  /* ------------------------------------------------------------------ *
   * Tokenizer / parser
   * ------------------------------------------------------------------ */

  /* Only double quotes group; apostrophes are ordinary characters. */
  function tokenize(line) {
    var toks = [];
    var i = 0, n = line.length;
    while (i < n) {
      while (i < n && /\s/.test(line[i])) i++;
      if (i >= n) break;
      if (line[i] === '"') {
        var j = i + 1, buf = '';
        while (j < n && line[j] !== '"') { buf += line[j]; j++; }
        toks.push({ text: buf, quoted: true });
        i = j + 1;
      } else {
        var k = i, b = '';
        while (k < n && !/\s/.test(line[k])) { b += line[k]; k++; }
        toks.push({ text: b, quoted: false });
        i = k;
      }
    }
    return toks;
  }

  /* Prefix resolution among named candidates (each with .name and .aliases). */
  function resolveName(input, candidates, kind) {
    var up = String(input).toUpperCase();
    var i, j, names;
    for (i = 0; i < candidates.length; i++) {
      names = [candidates[i].name].concat(candidates[i].aliases || []);
      for (j = 0; j < names.length; j++) if (names[j] === up) return candidates[i];
    }
    var hits = [];
    for (i = 0; i < candidates.length; i++) {
      names = [candidates[i].name].concat(candidates[i].aliases || []);
      for (j = 0; j < names.length; j++) {
        if (names[j].indexOf(up) === 0) { hits.push(candidates[i]); break; }
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw errObj('0003', 'AMBIGUOUS ' + kind + ' "' + input + '": ' +
        hits.map(function (h) { return h.name; }).join(', '));
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Command registry
   * ------------------------------------------------------------------ */

  /* Module: { name, aliases, title, desc, menu:true|false, actions: [action] }
     Action: { name, aliases, args: [{name, req, variadic, rest}], flags: [{name, boolean, nargs, value}],
               desc, example, mutates, handler(api) }
     api: { doc, ctx, args, flags, out(line), eff(effect), confirm(summary), spool(title, lines) } */

  var MODULES = [];

  function findModule(nameUp) {
    for (var i = 0; i < MODULES.length; i++) {
      var names = [MODULES[i].name].concat(MODULES[i].aliases || []);
      if (names.indexOf(nameUp) >= 0) return MODULES[i];
    }
    return null;
  }

  function usageOf(mod, act) {
    var parts = [mod.topLevel ? mod.name : mod.name + ' ' + act.name];
    (act.args || []).forEach(function (a) {
      var t = a.variadic ? '<' + a.name + '> <' + a.name + '> ...' : '<' + a.name + '>';
      parts.push(a.req ? t : '[' + t + ']');
    });
    (act.flags || []).forEach(function (f) {
      if (f.boolean) parts.push('[--' + f.name + ']');
      else parts.push('[--' + f.name + ' <' + (f.value || 'value') + '>' + (f.nargs === 2 ? ' [' + (f.value2 || 'n') + ']' : '') + ']');
    });
    return parts.join(' ');
  }

  function parseArgs(toks, act) {
    var args = {}, flags = {}, positionals = [];
    var specs = act.flags || [];
    var i = 0;
    while (i < toks.length) {
      var t = toks[i];
      if (!t.quoted && t.text.slice(0, 2) === '--') {
        var raw = t.text.slice(2), inline = null;
        var eq = raw.indexOf('=');
        if (eq >= 0) { inline = raw.slice(eq + 1); raw = raw.slice(0, eq); }
        if (raw.toUpperCase() === 'YES') { flags.yes = true; i++; continue; }
        var spec = resolveName(raw, specs.map(function (f) { return { name: f.name.toUpperCase(), f: f }; }), 'FLAG');
        if (!spec) throw errObj('0004', 'UNKNOWN FLAG --' + raw + '. TYPE HELP ' + (act.helpPath || act.name) + '.');
        var f = spec.f;
        if (f.boolean) { flags[f.name] = true; i++; continue; }
        if (inline !== null) { flags[f.name] = inline; i++; continue; }
        var vals = [];
        var want = f.nargs === 2 ? 2 : 1;
        var j = i + 1;
        while (j < toks.length && vals.length < want &&
               (toks[j].quoted || toks[j].text.slice(0, 2) !== '--')) {
          vals.push(toks[j].text); j++;
          if (f.nargs !== 2) break;
        }
        if (vals.length === 0) throw errObj('0004', 'FLAG --' + f.name.toUpperCase() + ' NEEDS A VALUE.');
        flags[f.name] = f.nargs === 2 ? vals : vals[0];
        i = i + 1 + vals.length;
      } else {
        positionals.push(t.text);
        i++;
      }
    }
    var specsA = act.args || [];
    var p = 0;
    for (var a = 0; a < specsA.length; a++) {
      var sp = specsA[a];
      if (sp.variadic) {
        args[sp.name] = positionals.slice(p);
        p = positionals.length;
        if (sp.req && args[sp.name].length === 0) {
          throw errObj('0004', 'MISSING <' + sp.name.toUpperCase() + '>. SYNTAX: ' + usageOf(act.__mod, act));
        }
      } else if (p < positionals.length) {
        args[sp.name] = positionals[p]; p++;
      } else if (sp.req) {
        throw errObj('0004', 'MISSING <' + sp.name.toUpperCase() + '>. SYNTAX: ' + usageOf(act.__mod, act));
      }
    }
    if (p < positionals.length) {
      throw errObj('0004', 'UNEXPECTED ARGUMENT "' + positionals[p] + '". SYNTAX: ' + usageOf(act.__mod, act));
    }
    return { args: args, flags: flags };
  }

  function parseLine(doc, line) {
    var toks = tokenize(line);
    if (toks.length === 0) return null;
    var first = toks[0].text;
    if (first === '?') first = 'HELP';
    var mod = resolveName(first, MODULES, 'COMMAND');
    if (!mod) throw errObj('0012', 'UNKNOWN COMMAND "' + first.toUpperCase() + '". TYPE HELP.');
    var act, rest;
    if (mod.topLevel) {
      act = mod.actions[0];
      rest = toks.slice(1);
    } else {
      if (toks.length === 1) return { mod: mod, act: null };
      act = resolveName(toks[1].text, mod.actions, 'ACTION');
      if (!act) {
        throw errObj('0012', 'UNKNOWN ACTION "' + toks[1].text.toUpperCase() + '" FOR ' + mod.name +
          '. TYPE HELP ' + mod.name + '.');
      }
      rest = toks.slice(2);
    }
    var parsed = parseArgs(rest, act);
    return { mod: mod, act: act, args: parsed.args, flags: parsed.flags };
  }

  /* ------------------------------------------------------------------ *
   * Execute
   * ------------------------------------------------------------------ */

  /* ctx: { now: ISO string, operator: string|null, confirmed: bool }
     Returns { doc, lines, spool, pending, effects, status }.
     When pending is set the caller keeps its ORIGINAL doc and, on Y,
     re-executes the same line with ctx.confirmed = true. */
  function execute(doc, line, ctx) {
    var res = { doc: doc, lines: [], spool: null, pending: null, effects: [], status: 'OK' };
    var work = clone(doc);
    var trimmed = String(line || '').trim();
    if (!trimmed) return res;
    try {
      var cmd = parseLine(work, trimmed);
      if (cmd && !cmd.act) {
        moduleHelp(work, cmd.mod, res.lines);
        res.doc = logAndReturn(work, ctx, trimmed, 'OK');
        return res;
      }
      if (cmd.act.mutates && !ctx.operator) throw errObj('0001', 'LOGON REQUIRED. TYPE LOGON <OPERATOR>.');
      var confirmed = !!ctx.confirmed || !!cmd.flags.yes;
      var api = {
        doc: work,
        ctx: ctx,
        args: cmd.args,
        flags: cmd.flags,
        out: function (l) { res.lines.push(l); },
        eff: function (e) { res.effects.push(e); },
        spool: function (report) { res.spool = report; },
        confirm: function (summary) {
          res.lines.push(summary);
          if (!confirmed) throw pendingObj(summary);
          res.lines.push('CONFIRMED.');
        }
      };
      cmd.act.handler(api);
      res.doc = logAndReturn(work, ctx, trimmed, 'OK');
    } catch (e) {
      if (e && e.__pending) {
        res.pending = { summary: e.summary, line: trimmed };
        res.lines.push('CONFIRM? (Y/N)');
        res.status = 'PENDING';
        res.doc = doc; // discard side effects made before the confirmation point
      } else if (e && e.__err) {
        res.lines.push('ERR ' + e.code + ' ' + e.msg);
        res.status = 'ERR ' + e.code;
        res.doc = logAndReturn(clone(doc), ctx, trimmed, res.status + ' ' + e.msg);
      } else {
        var msg = (e && e.message) ? e.message : String(e);
        res.lines.push('ABEND S0C7. DETAILS IN SYSLOG.');
        res.status = 'ABEND';
        var w2 = clone(doc);
        pushSyslog(w2, ctx, 'ABEND: ' + msg + ' | ' + ((e && e.stack) ? String(e.stack).split('\n').slice(0, 4).join(' / ') : ''));
        res.doc = logAndReturn(w2, ctx, trimmed, 'ABEND');
      }
    }
    return res;
  }

  function logAndReturn(doc, ctx, line, status) {
    pushSyslog(doc, ctx, line + ' -> ' + status);
    return doc;
  }

  /* ------------------------------------------------------------------ *
   * HELP
   * ------------------------------------------------------------------ */

  function topHelp(doc, out) {
    out.push('MIRSH/70 COMMAND MODULES');
    MODULES.forEach(function (m) {
      if (m.hidden) return;
      out.push('  ' + rpad(m.name, 10) + rpad(m.title || '', 22) + (m.desc || ''));
    });
    out.push('SYSTEM COMMANDS');
    var sys = MODULES.filter(function (m) { return m.topLevel; }).map(function (m) { return m.name; });
    for (var i = 0; i < sys.length; i += 8) out.push('  ' + sys.slice(i, i + 8).join('  '));
    out.push('TYPE HELP <MODULE> FOR COMMANDS. HELP <MODULE> <ACTION> FOR FULL SYNTAX.');
    out.push('TYPE MENU (OR PRESS ENTER ON AN EMPTY LINE) FOR NUMBERED MENUS.');
  }

  function moduleHelp(doc, mod, out) {
    out.push(mod.name + ' - ' + (mod.desc || mod.title || ''));
    mod.actions.forEach(function (a) {
      out.push('  ' + usageOf(mod, a));
      out.push('      ' + (a.desc || ''));
    });
  }

  function actionHelp(doc, mod, act, out) {
    out.push('SYNTAX: ' + usageOf(mod, act));
    out.push(act.desc || '');
    (act.flags || []).forEach(function (f) {
      out.push('  --' + rpad(f.name.toUpperCase(), 12) + (f.help || (f.boolean ? 'FLAG' : 'VALUE')));
    });
    if (act.example) out.push('EXAMPLE: ' + act.example);
  }

  /* ------------------------------------------------------------------ *
   * Seed data (Appendix A)
   * ------------------------------------------------------------------ */

  var SEED_VAULT = [
    ['NETHERITE', 'Nether Boss Weapon', 1, 640],
    ['MYTHICS', 'Staff "Dusk of Nox"', 1, 500],
    ['MYTHICS', 'Ullarh Greatsword + Mending', 1, 550],
    ['MYTHICS', "Ruhruc's Blessing Sword + Mending + Halo Aura", 1, 1500],
    ['RARE', 'Nether Star', 1, 250],
    ['RARE', 'Maxed Trident', 2, 600],
    ['DIAMOND', 'Custom Maxed Helmet', 1, null],
    ['ANIMALS', 'Horse Spawn Egg', 2, null],
    ['ANIMALS', 'Panda Spawn Egg', 1, null],
    ['ANIMALS', 'Sniffer Spawn Egg', 1, null],
    ['ANIMALS', 'Wolf Spawn Egg', 1, null],
    ['ANIMALS', 'Rabbit Spawn Egg', 2, null],
    ['ANIMALS', 'Cat Spawn Egg', 2, null],
    ['ANIMALS', 'Chicken Spawn Egg', 2, null],
    ['ANIMALS', 'Strider Spawn Egg', 2, null],
    ['ANIMALS', 'Parrot Spawn Egg', 1, null],
    ['ANIMALS', 'Portable Cat Spawn Egg', 1, null]
  ];

  var SEED_DEMOLITION = [
    ['-2809/115/-8901', 80, 'Floating dirt, deepslate, and stone.'],
    ['-2859/97/-8925', 150, 'Deepslate boxes and squares.'],
    ['-2738/114/-8875', 215, 'The entire bee farm and the floating dripstone farm.'],
    ['-3017/76/-9082', 120, 'Deepslate boxes and squares.'],
    ['-2846/76/-9116', 310, 'The unfinished bee farm, surrounding structures, and moss.'],
    ['-2702/117/-8793', 280, 'The temporary housing unit and the units beside it. Personal items, pets, decor, art, and barrels stay untouched. Touching them forfeits the reward and draws a fine.'],
    ['-2816/123/-8797', 145, 'The deepslate castle and its walls.'],
    ['-2803/118/-8844', 40, 'The house.'],
    ['-2908/115/-8834', 80, 'The unidentified structure. All of it.'],
    ['-2703/117/-8879', 420, 'The library. Leave the water elevator and the redstone up to the island alone.']
  ];

  var SEED_ONGOING = [
    ['ECONOMY', 'Material Collection', 0, 'Paid per delivery with JOB PAY --amount.'],
    ['POLITICS', 'Conquest', 630, ''],
    ['POLITICS', 'Conquest', 540, ''],
    ['POLITICS', 'Conquest', 920, ''],
    ['LORE', 'Lore Creation', 1000, ''],
    ['LORE', 'Lore Creation', 1000, '']
  ];

  function seedDocument(doc, ctx) {
    var now = ts(ctx);
    SEED_VAULT.forEach(function (v) {
      doc.vault.push({
        id: nextId(doc, 'VLT'), name: v[1], category: v[0], qty: v[2], price: v[3],
        notes: '', addedBy: ctx.operator, addedAt: now
      });
    });
    SEED_DEMOLITION.forEach(function (j) {
      doc.jobs.push({
        id: nextId(doc, 'JOB'), title: 'Demolition', category: 'BUILDING',
        coords: j[0], spawn: doc.settings.defaultSpawn,
        description: 'Clear the marked structure at these coordinates. ' + j[2],
        reward: j[1], deadline: null, status: 'OPEN',
        claimedBy: null, claimedAt: null, submittedAt: null, submitNote: null,
        paidAt: null, paidLedgerId: null, postedBy: ctx.operator, postedAt: now
      });
    });
    SEED_ONGOING.forEach(function (j) {
      doc.jobs.push({
        id: nextId(doc, 'JOB'), title: j[1], category: j[0],
        coords: null, spawn: null, description: j[3],
        reward: j[2], deadline: null, status: 'OPEN',
        claimedBy: null, claimedAt: null, submittedAt: null, submitNote: null,
        paidAt: null, paidLedgerId: null, postedBy: ctx.operator, postedAt: now
      });
    });
    doc.jobs.push({
      id: nextId(doc, 'JOB'), title: 'Schematic: high-yield scute farm for the grind farm',
      category: 'BUILDING', coords: null, spawn: null,
      description: 'Schematic only is acceptable. Must be high yield and foolproof.',
      reward: 350, deadline: null, status: 'ARCHIVED',
      claimedBy: null, claimedAt: null, submittedAt: null, submitNote: null,
      paidAt: null, paidLedgerId: null, postedBy: ctx.operator, postedAt: now
    });
    return doc;
  }

  function docHasData(doc) {
    return doc.citizens.length > 0 || doc.ledger.length > 0 || doc.jobs.length > 0 ||
      doc.vault.length > 0 || doc.recruits.length > 0 || doc.housing.length > 0 ||
      doc.positions.length > 0 || doc.notices.length > 0;
  }

  /* ------------------------------------------------------------------ *
   * Import / export
   * ------------------------------------------------------------------ */

  var COLLECTIONS = ['citizens', 'ledger', 'jobs', 'vault', 'recruits', 'housing', 'positions', 'notices'];

  function validateImport(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      return { ok: false, error: 'NOT VALID JSON.' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'NOT A MIRSH DOCUMENT.' };
    }
    for (var i = 0; i < COLLECTIONS.length; i++) {
      var c = COLLECTIONS[i];
      if (parsed[c] !== undefined && !Array.isArray(parsed[c])) {
        return { ok: false, error: 'FIELD "' + c + '" IS NOT A LIST.' };
      }
    }
    if (parsed.citizens === undefined && parsed.ledger === undefined && parsed.settings === undefined) {
      return { ok: false, error: 'NOT A MIRSH DOCUMENT. NO KNOWN FIELDS.' };
    }
    var doc = migrate(clone(parsed));
    return {
      ok: true,
      doc: doc,
      counts: {
        citizens: doc.citizens.length,
        ledger: doc.ledger.length,
        jobs: doc.jobs.length,
        vault: doc.vault.length
      }
    };
  }

  /* IMPORT --merge: add records with unknown ids, leave existing records alone. */
  function mergeImport(doc, incoming) {
    var added = {};
    COLLECTIONS.forEach(function (c) {
      added[c] = 0;
      var have = {};
      doc[c].forEach(function (r) { have[r.id] = true; });
      (incoming[c] || []).forEach(function (r) {
        if (r && r.id && !have[r.id]) {
          doc[c].push(clone(r));
          added[c]++;
          var m = String(r.id).match(/^([A-Z]+)-(\d+)$/);
          if (m && doc.counters[m[1]] !== undefined) {
            doc.counters[m[1]] = Math.max(doc.counters[m[1]], parseInt(m[2], 10));
          }
        }
      });
    });
    return added;
  }

  /* ------------------------------------------------------------------ *
   * Settings (SET)
   * ------------------------------------------------------------------ */

  var BOOL_KEYS = ['crt', 'sound', 'greenbar'];
  var DISPLAY_KEYS = ['theme', 'baud', 'crt', 'sound', 'greenbar'];

  function settingsLines(doc) {
    var s = doc.settings;
    var out = [];
    out.push(rpad('RANKS', 18) + s.ranks.map(function (r) {
      return r.name + ' ' + (r.cost === null ? 'N/A' : r.cost);
    }).join(' / '));
    out.push(rpad('VAULTMINRANK', 18) + s.vaultMinRank);
    out.push(rpad('VAULTDISCOUNTPCT', 18) + Object.keys(s.vaultDiscountPct).map(function (k) {
      return k + ' ' + s.vaultDiscountPct[k];
    }).join(' / '));
    ['recruitRewardHp', 'recruitWeekDays', 'taxMonthlyHp', 'taxNoticeDays', 'afkMaxDays',
      'cashPerHp', 'cashMarkupPct', 'cashBuyCapHp', 'defaultSpawn', 'systemName', 'prompt',
      'theme', 'baud'].forEach(function (k) {
        out.push(rpad(k.toUpperCase(), 18) + s[k]);
      });
    BOOL_KEYS.forEach(function (k) {
      out.push(rpad(k.toUpperCase(), 18) + (s[k] ? 'ON' : 'OFF'));
    });
    return out;
  }

  function setSetting(api, keyRaw, valueRaw) {
    var doc = api.doc;
    var s = doc.settings;
    var key = String(keyRaw).toUpperCase();
    var dot = key.indexOf('.');
    if (dot >= 0) {
      var head = key.slice(0, dot), sub = key.slice(dot + 1);
      if (head === 'RANKS') {
        var rn = resolveRank(doc, sub);
        var idx = rankIndex(doc, rn);
        if (s.ranks[idx].cost === null) throw errObj('0009', rn + ' CANNOT BE PRICED.');
        s.ranks[idx].cost = parseAmount(valueRaw, 'RANK COST');
        api.out('SET RANKS.' + rn + ' = ' + s.ranks[idx].cost);
        return;
      }
      if (head === 'VAULTDISCOUNTPCT') {
        var rn2 = resolveRank(doc, sub);
        s.vaultDiscountPct[rn2] = parseAmount(valueRaw, 'DISCOUNT PCT');
        api.out('SET VAULTDISCOUNTPCT.' + rn2 + ' = ' + s.vaultDiscountPct[rn2]);
        return;
      }
      throw errObj('0005', 'UNKNOWN SETTING "' + keyRaw + '". TYPE SET.');
    }
    var known = Object.keys(s).filter(function (k) { return k !== 'ranks' && k !== 'vaultDiscountPct'; });
    var match = null;
    for (var i = 0; i < known.length; i++) if (known[i].toUpperCase() === key) match = known[i];
    if (!match) throw errObj('0005', 'UNKNOWN SETTING "' + keyRaw + '". TYPE SET.');
    var v;
    if (BOOL_KEYS.indexOf(match) >= 0) {
      var up = String(valueRaw).toUpperCase();
      if (up !== 'ON' && up !== 'OFF') throw errObj('0004', 'SET ' + key + ' ON|OFF.');
      v = up === 'ON';
    } else if (match === 'theme') {
      v = String(valueRaw).toUpperCase();
      if (['GREEN', 'AMBER', 'PAPER'].indexOf(v) < 0) throw errObj('0004', 'THEME GREEN|AMBER|PAPER.');
    } else if (match === 'baud') {
      v = String(valueRaw).toUpperCase();
      if (['300', '1200', '9600', 'OFF'].indexOf(v) < 0) throw errObj('0004', 'BAUD 300|1200|9600|OFF.');
    } else if (typeof s[match] === 'number') {
      v = parseAmount(valueRaw, key);
    } else {
      v = String(valueRaw);
    }
    s[match] = v;
    api.out('SET ' + match.toUpperCase() + ' = ' + (typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : v));
    if (DISPLAY_KEYS.indexOf(match) >= 0) api.eff({ type: 'display', key: match, value: v });
  }

  /* ------------------------------------------------------------------ *
   * System module (top-level commands)
   * ------------------------------------------------------------------ */

  function topLevel(name, aliases, spec) {
    spec.__topName = name;
    var act = {
      name: name, args: spec.args || [], flags: spec.flags || [],
      desc: spec.desc || '', example: spec.example, mutates: !!spec.mutates,
      handler: spec.handler
    };
    var mod = {
      name: name, aliases: aliases || [], title: spec.title || '', desc: spec.desc || '',
      topLevel: true, hidden: spec.hidden !== false, menu: false, actions: [act]
    };
    act.__mod = mod;
    MODULES.push(mod);
    return mod;
  }

  function registerModule(mod) {
    mod.actions.forEach(function (a) { a.__mod = mod; a.helpPath = mod.name + ' ' + a.name; });
    MODULES.push(mod);
    return mod;
  }

  topLevel('LOGON', [], {
    desc: 'SET THE OPERATOR. REQUIRED BEFORE ANY COMMAND THAT CHANGES DATA.',
    args: [{ name: 'operator', req: true }],
    example: 'LOGON max',
    handler: function (api) {
      var op = api.args.operator;
      if (!/^[A-Za-z0-9_.'-]{1,24}$/.test(op)) throw errObj('0004', 'OPERATOR NAME: LETTERS, DIGITS, _ . - ONLY, MAX 24.');
      api.eff({ type: 'logon', operator: op });
      api.out("SU CUY'GAR, " + op.toUpperCase() + '.');
    }
  });

  topLevel('LOGOFF', [], {
    desc: 'CLEAR THE OPERATOR.',
    handler: function (api) {
      if (!api.ctx.operator) throw errObj('0009', 'NO OPERATOR LOGGED ON.');
      api.eff({ type: 'logoff' });
      api.out("RET'.");
    }
  });

  topLevel('WHOAMI', [], {
    desc: 'SHOW THE CURRENT OPERATOR.',
    handler: function (api) {
      api.out(api.ctx.operator ? 'OPERATOR ' + api.ctx.operator.toUpperCase() : 'NO OPERATOR. TYPE LOGON <OPERATOR>.');
    }
  });

  topLevel('HELP', [], {
    desc: 'HELP. HELP <MODULE>. HELP <MODULE> <ACTION>.',
    args: [{ name: 'module', req: false }, { name: 'action', req: false }],
    handler: function (api) {
      var lines = [];
      if (!api.args.module) { topHelp(api.doc, lines); }
      else {
        var mod = resolveName(api.args.module, MODULES, 'COMMAND');
        if (!mod) throw errObj('0012', 'UNKNOWN COMMAND "' + api.args.module.toUpperCase() + '". TYPE HELP.');
        if (!api.args.action || mod.topLevel) {
          if (mod.topLevel) actionHelp(api.doc, mod, mod.actions[0], lines);
          else moduleHelp(api.doc, mod, lines);
        } else {
          var act = resolveName(api.args.action, mod.actions, 'ACTION');
          if (!act) throw errObj('0012', 'UNKNOWN ACTION "' + api.args.action.toUpperCase() + '" FOR ' + mod.name + '.');
          actionHelp(api.doc, mod, act, lines);
        }
      }
      lines.forEach(api.out);
    }
  });

  topLevel('MENU', [], {
    desc: 'NUMBERED MENUS. ENTER ON AN EMPTY LINE DOES THE SAME.',
    handler: function (api) { api.eff({ type: 'menu' }); }
  });

  topLevel('CLS', [], {
    desc: 'CLEAR THE SCREEN. CTRL+L DOES THE SAME.',
    handler: function (api) { api.eff({ type: 'cls' }); }
  });

  topLevel('THEME', [], {
    desc: 'THEME GREEN|AMBER|PAPER. PHOSPHOR SELECTION, PERSISTED.',
    args: [{ name: 'theme', req: false }],
    example: 'THEME AMBER',
    handler: function (api) {
      if (!api.args.theme) { api.out('THEME ' + api.doc.settings.theme + '. OPTIONS: GREEN AMBER PAPER.'); return; }
      setSetting(api, 'theme', api.args.theme);
    }
  });

  topLevel('BAUD', [], {
    desc: 'OUTPUT PACING. BAUD 300|1200|9600|OFF. ANY KEY FINISHES PACED OUTPUT.',
    args: [{ name: 'rate', req: false }],
    example: 'BAUD 1200',
    handler: function (api) {
      if (!api.args.rate) { api.out('BAUD ' + api.doc.settings.baud + '. OPTIONS: 300 1200 9600 OFF.'); return; }
      setSetting(api, 'baud', api.args.rate);
    }
  });

  topLevel('SET', [], {
    desc: 'SET LISTS ALL SETTINGS. SET <KEY> <VALUE> CHANGES ONE. NESTED: SET RANKS.VERD 200.',
    args: [{ name: 'key', req: false }, { name: 'value', req: false }],
    example: 'SET TAXMONTHLYHP 200',
    handler: function (api) {
      if (!api.args.key) { settingsLines(api.doc).forEach(api.out); return; }
      if (api.args.value === undefined) throw errObj('0004', 'SET <KEY> <VALUE>.');
      var key = String(api.args.key).toUpperCase();
      var display = DISPLAY_KEYS.map(function (k) { return k.toUpperCase(); }).indexOf(key.split('.')[0]) >= 0;
      if (!display && !api.ctx.operator) throw errObj('0001', 'LOGON REQUIRED. TYPE LOGON <OPERATOR>.');
      setSetting(api, api.args.key, api.args.value);
    }
  });

  topLevel('DATE', [], {
    desc: 'SYSTEM DATE AND TIME.',
    handler: function (api) {
      api.out(ts(api.ctx) + '  (LOCAL ' + fmtLocal(api.ctx.now) + ')');
    }
  });

  topLevel('VERSION', [], {
    desc: 'SYSTEM VERSION.',
    handler: function (api) {
      api.out(api.doc.settings.systemName + '  REL ' + RELEASE + '  SCHEMA ' + api.doc.schemaVersion);
    }
  });

  topLevel('SNAPSHOT', [], {
    desc: 'SNAPSHOT STORES THE DOCUMENT (LAST 5 KEPT). SNAPSHOT LIST SHOWS THEM.',
    args: [{ name: 'sub', req: false }],
    example: 'SNAPSHOT LIST',
    handler: function (api) {
      var sub = (api.args.sub || '').toUpperCase();
      if (sub === '' || 'SNAPSHOT'.indexOf(sub) === 0) { api.eff({ type: 'snapshot' }); return; }
      if ('LIST'.indexOf(sub) === 0) { api.eff({ type: 'snapshot-list' }); return; }
      throw errObj('0004', 'SNAPSHOT OR SNAPSHOT LIST.');
    }
  });

  topLevel('RESTORE', [], {
    desc: 'RESTORE <N> LOADS SNAPSHOT N AFTER CONFIRMATION.',
    args: [{ name: 'n', req: true }],
    mutates: true,
    example: 'RESTORE 1',
    handler: function (api) {
      var n = parseAmount(api.args.n, 'SNAPSHOT NUMBER');
      api.eff({ type: 'restore', n: n });
    }
  });

  topLevel('EXPORT', [], {
    desc: 'WRITE THE FULL DOCUMENT TO A COPY BOX AND DOWNLOAD A BACKUP FILE.',
    handler: function (api) {
      var d = new Date(api.ctx.now);
      var name = 'mirsh-backup-' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
        '-' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + '.json';
      api.eff({ type: 'export', filename: name });
      api.out('EXPORT SPOOLED TO ' + name.toUpperCase());
    }
  });

  topLevel('IMPORT', [], {
    desc: 'IMPORT A DOCUMENT FROM PASTED JSON OR A FILE. --MERGE ADDS UNKNOWN IDS ONLY.',
    flags: [{ name: 'merge', boolean: true, help: 'ADD RECORDS WITH UNKNOWN IDS, LEAVE EXISTING ALONE' }],
    mutates: true,
    example: 'IMPORT --merge',
    handler: function (api) {
      api.eff({ type: 'import', merge: !!api.flags.merge });
      api.out('PASTE JSON OR CHOOSE A FILE IN THE IMPORT BOX.');
    }
  });

  topLevel('SPOOL', [], {
    desc: 'SHOW OR HIDE THE LINE PRINTER SPOOL PANE.',
    handler: function (api) { api.eff({ type: 'spool-toggle' }); }
  });

  topLevel('SEED', [], {
    desc: 'LOAD THE STARTER DATASET (VAULT AND JOBS). REFUSES IF DATA EXISTS UNLESS --FORCE.',
    flags: [{ name: 'force', boolean: true, help: 'SEED EVEN IF DATA EXISTS' }],
    mutates: true,
    example: 'SEED',
    handler: function (api) {
      if (docHasData(api.doc) && !api.flags.force) {
        throw errObj('0009', 'DATASET NOT EMPTY. SEED --FORCE TO ADD SEED RECORDS ANYWAY.');
      }
      seedDocument(api.doc, api.ctx);
      api.out('SEED LOADED: ' + SEED_VAULT.length + ' VAULT ITEMS, ' +
        (SEED_DEMOLITION.length + SEED_ONGOING.length + 1) + ' JOBS.');
    }
  });

  topLevel('SELFTEST', [], {
    desc: 'RUN THE ENGINE TEST SUITE IN THE BROWSER.',
    handler: function (api) { api.eff({ type: 'selftest' }); }
  });

  topLevel('SYSLOG', [], {
    desc: 'SYSLOG [N] PRINTS THE LAST N SYSTEM LOG LINES (DEFAULT 20).',
    args: [{ name: 'n', req: false }],
    example: 'SYSLOG 50',
    handler: function (api) {
      var n = api.args.n ? parsePositive(api.args.n, 'COUNT') : 20;
      var rows = api.doc.syslog.slice(-n);
      if (rows.length === 0) { api.out('SYSLOG EMPTY.'); return; }
      rows.forEach(function (r) {
        api.out(r.ts + ' ' + rpad(r.operator || '-', 12) + ' ' + r.line);
      });
    }
  });

  /* ------------------------------------------------------------------ *
   * CITIZENS (CIT)
   * ------------------------------------------------------------------ */

  var STATUSES = ['ACTIVE', 'AFK', 'DEPARTED'];

  function resolveStatus(input) {
    var up = String(input).toUpperCase();
    if (STATUSES.indexOf(up) >= 0) return up;
    var hits = STATUSES.filter(function (s) { return s.indexOf(up) === 0; });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw errObj('0003', 'AMBIGUOUS STATUS "' + input + '": ' + hits.join(', '));
    throw errObj('0005', 'UNKNOWN STATUS "' + input + '". USE ACTIVE, AFK, OR DEPARTED.');
  }

  function citizenLabel(c) { return c.id + ' ' + c.ign; }

  function refreshAfk(doc, ctx, c) {
    /* Reading a citizen never mutates; BATCH AFK does the real expiry. */
    return c.status === 'AFK' && c.afkUntil && c.afkUntil < todayLocal(ctx);
  }

  registerModule({
    name: 'CIT', aliases: ['CITIZEN', 'CITIZENS'], title: 'CITIZENS', desc: 'CITIZEN REGISTRY',
    menu: true,
    actions: [
      {
        name: 'ADD',
        desc: 'REGISTER A CITIZEN. DUPLICATE IGN IS AN ERROR.',
        args: [{ name: 'ign', req: true }],
        flags: [
          { name: 'discord', help: 'DISCORD HANDLE' },
          { name: 'clan', help: 'CLAN NAME' },
          { name: 'rank', help: "RANK (DEFAULT VERD'IKA)" },
          { name: 'joined', help: 'JOIN DATE (DEFAULT TODAY)' },
          { name: 'notes', help: 'FREE NOTES' }
        ],
        menuFields: [
          { label: 'IGN', kind: 'arg', required: true, def: '' },
          { label: 'DISCORD', kind: 'flag', flag: 'discord', def: '' },
          { label: 'CLAN', kind: 'flag', flag: 'clan', def: '' },
          { label: 'RANK', kind: 'flag', flag: 'rank', def: "VERD'IKA" },
          { label: 'JOINED', kind: 'flag', flag: 'joined', def: 'TODAY' },
          { label: 'NOTES', kind: 'flag', flag: 'notes', def: '' }
        ],
        example: 'CIT ADD philly_9859 --clan Vizsla --joined TODAY',
        mutates: true,
        handler: function (api) {
          var ign = String(api.args.ign).trim();
          if (!/^[A-Za-z0-9_.-]{1,24}$/.test(ign)) throw errObj('0004', 'IGN: LETTERS, DIGITS, _ . - ONLY, MAX 24.');
          var exists = api.doc.citizens.some(function (c) { return c.ign.toUpperCase() === ign.toUpperCase(); });
          if (exists) throw errObj('0006', 'DUPLICATE IGN "' + ign + '".');
          var rank = api.flags.rank ? resolveRank(api.doc, api.flags.rank) : api.doc.settings.ranks[0].name;
          var joined = api.flags.joined ? parseDate(api.flags.joined, api.ctx) : todayLocal(api.ctx);
          var c = {
            id: nextId(api.doc, 'CIT'), ign: ign,
            discord: api.flags.discord || '', clan: api.flags.clan || '',
            rank: rank, joinedAt: joined, status: 'ACTIVE',
            afkFrom: null, afkUntil: null, cooldownUntil: null,
            housingId: null, positionId: null, notes: api.flags.notes || '',
            createdAt: ts(api.ctx), createdBy: api.ctx.operator
          };
          api.doc.citizens.push(c);
          api.out(c.id + ' ADDED: ' + c.ign + '  RANK ' + c.rank + '  JOINED ' + c.joinedAt +
            (c.clan ? '  CLAN ' + c.clan : ''));
        }
      },
      {
        name: 'LIST',
        desc: 'LIST CITIZENS. FILTER BY RANK, CLAN, STATUS. SORT BY IGN, RANK, BALANCE, JOINED.',
        flags: [
          { name: 'rank', help: 'FILTER BY RANK' },
          { name: 'clan', help: 'FILTER BY CLAN' },
          { name: 'status', help: 'FILTER BY STATUS' },
          { name: 'sort', help: 'IGN | RANK | BALANCE | JOINED (DEFAULT IGN)' }
        ],
        example: 'CIT LIST --status ACTIVE --sort balance',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.citizens.slice();
          if (api.flags.rank) {
            var r = resolveRank(doc, api.flags.rank);
            rows = rows.filter(function (c) { return c.rank === r; });
          }
          if (api.flags.clan) {
            var cl = String(api.flags.clan).toUpperCase();
            rows = rows.filter(function (c) { return (c.clan || '').toUpperCase() === cl; });
          }
          if (api.flags.status) {
            var st = resolveStatus(api.flags.status);
            rows = rows.filter(function (c) { return c.status === st; });
          }
          var sort = (api.flags.sort || 'IGN').toUpperCase();
          var sorts = ['IGN', 'RANK', 'BALANCE', 'JOINED'];
          var hits = sorts.filter(function (s) { return s.indexOf(sort) === 0; });
          if (hits.length !== 1) throw errObj('0004', 'SORT BY IGN, RANK, BALANCE, OR JOINED.');
          sort = hits[0];
          rows.sort(function (a, b) {
            if (sort === 'IGN') return a.ign.toUpperCase() < b.ign.toUpperCase() ? -1 : 1;
            if (sort === 'RANK') return rankIndex(doc, b.rank) - rankIndex(doc, a.rank);
            if (sort === 'BALANCE') return balance(doc, b.id) - balance(doc, a.id);
            return a.joinedAt < b.joinedAt ? -1 : 1;
          });
          if (rows.length === 0) { api.out('NO CITIZENS MATCH.'); return; }
          api.out(rpad('ID', 9) + rpad('IGN', 18) + rpad('RANK', 12) + rpad('CLAN', 12) +
            rpad('STATUS', 9) + lpad('BAL', 8) + '  JOINED');
          rows.forEach(function (c) {
            api.out(rpad(c.id, 9) + rpad(c.ign, 18) + rpad(c.rank, 12) + rpad(c.clan || '-', 12) +
              rpad(c.status, 9) + lpad(fmtHp(balance(doc, c.id)), 8) + '  ' + c.joinedAt);
          });
          api.out(rows.length + ' CITIZEN' + (rows.length === 1 ? '' : 'S') + '.');
        }
      },
      {
        name: 'SHOW',
        desc: 'FULL PROFILE: BALANCE, STATUS, HOUSING, POSITION, LEDGER, NOTICES, JOBS, RECRUITS.',
        args: [{ name: 'ign', req: true }],
        example: 'CIT SHOW philly_9859',
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          api.out(c.id + '  ' + c.ign + '  ' + c.rank + '  ' + c.status);
          api.out('BALANCE ' + fmtHp(balance(doc, c.id)) + ' HP');
          api.out('CLAN ' + (c.clan || '-') + '  DISCORD ' + (c.discord || '-') + '  JOINED ' + c.joinedAt);
          if (c.status === 'AFK') {
            api.out('AFK FROM ' + c.afkFrom + ' UNTIL ' + c.afkUntil +
              (refreshAfk(doc, api.ctx, c) ? '  (EXPIRED. RUN BATCH AFK)' : ''));
          }
          if (c.cooldownUntil) api.out('AFK COOLDOWN UNTIL ' + c.cooldownUntil);
          var h = c.housingId ? doc.housing.filter(function (x) { return x.id === c.housingId; })[0] : null;
          var p = c.positionId ? doc.positions.filter(function (x) { return x.id === c.positionId; })[0] : null;
          api.out('HOUSING ' + (h ? h.id + ' ' + h.unit : '-') + '  POSITION ' + (p ? p.id + ' ' + p.title : '-'));
          if (c.notes) api.out('NOTES: ' + c.notes);
          var lines = doc.ledger.filter(function (l) { return l.citizenId === c.id; }).slice(-10);
          if (lines.length) {
            api.out('LAST ' + lines.length + ' LEDGER LINES:');
            lines.forEach(function (l) { api.out('  ' + fmtLedgerLine(doc, l)); });
          } else api.out('NO LEDGER LINES.');
          var open = doc.notices.filter(function (n) { return n.citizenId === c.id && n.status === 'OPEN'; });
          open.forEach(function (n) {
            api.out('OPEN NOTICE ' + n.id + ' DUE ' + n.dueAt + ' OWED ' + fmtHp(n.amountOwed) + ' HP');
          });
          var jobs = doc.jobs.filter(function (j) {
            return j.claimedBy === c.id && (j.status === 'CLAIMED' || j.status === 'SUBMITTED');
          });
          jobs.forEach(function (j) { api.out('JOB ' + j.id + ' ' + j.title + ' (' + j.status + ')'); });
          var recs = doc.recruits.filter(function (r) { return r.recruiterId === c.id; });
          if (recs.length) api.out('RECRUITS LOGGED: ' + recs.length +
            ' (' + recs.filter(function (r) { return !r.paidLedgerId; }).length + ' OPEN)');
        }
      },
      {
        name: 'SET',
        desc: 'CHANGE A PROFILE FIELD: DISCORD, CLAN, NOTES, JOINED.',
        args: [{ name: 'ign', req: true }, { name: 'field', req: true }, { name: 'value', req: true }],
        example: 'CIT SET philly_9859 clan Vizsla',
        mutates: true,
        handler: function (api) {
          var c = findCitizen(api.doc, api.args.ign);
          var fields = ['DISCORD', 'CLAN', 'NOTES', 'JOINED'];
          var up = String(api.args.field).toUpperCase();
          var hits = fields.filter(function (f) { return f.indexOf(up) === 0; });
          if (hits.length !== 1) throw errObj('0004', 'FIELD: DISCORD, CLAN, NOTES, OR JOINED.');
          var f = hits[0];
          if (f === 'JOINED') c.joinedAt = parseDate(api.args.value, api.ctx);
          else c[f.toLowerCase()] = api.args.value;
          api.out(c.id + ' ' + c.ign + ' ' + f + ' SET.');
        }
      },
      {
        name: 'AFK',
        desc: 'START AN AFK PERIOD. PRINTS RETURN AND COOLDOWN END DATES.',
        args: [{ name: 'ign', req: true }, { name: 'days', req: true }],
        example: 'CIT AFK philly_9859 14',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          var days = parsePositive(api.args.days, 'DAYS');
          var max = doc.settings.afkMaxDays;
          if (days > max) throw errObj('0009', 'AFK LIMIT IS ' + max + ' DAYS.');
          if (c.status === 'AFK') throw errObj('0009', c.ign + ' IS ALREADY AFK UNTIL ' + c.afkUntil + '.');
          if (c.status === 'DEPARTED') throw errObj('0009', c.ign + ' HAS DEPARTED.');
          var today = todayLocal(api.ctx);
          if (c.cooldownUntil && c.cooldownUntil > today) {
            throw errObj('0009', 'AFK COOLDOWN RUNS UNTIL ' + c.cooldownUntil + '.');
          }
          c.status = 'AFK';
          c.afkFrom = today;
          c.afkUntil = addDays(today, days);
          c.cooldownUntil = null;
          api.out(c.ign + ' AFK ' + days + ' DAYS. RETURN ' + c.afkUntil +
            '. COOLDOWN ENDS ' + addDays(c.afkUntil, days) + '.');
        }
      },
      {
        name: 'RETURN',
        desc: 'END AFK EARLY. COOLDOWN EQUALS THE DAYS ACTUALLY AWAY.',
        args: [{ name: 'ign', req: true }],
        example: 'CIT RETURN philly_9859',
        mutates: true,
        handler: function (api) {
          var c = findCitizen(api.doc, api.args.ign);
          if (c.status !== 'AFK') throw errObj('0009', c.ign + ' IS NOT AFK.');
          var today = todayLocal(api.ctx);
          var taken = Math.max(1, Math.round(daysBetween(c.afkFrom + 'T00:00:00', today + 'T00:00:00')));
          c.status = 'ACTIVE';
          c.afkFrom = null;
          c.afkUntil = null;
          c.cooldownUntil = addDays(today, taken);
          api.out(c.ign + ' RETURNED AFTER ' + taken + ' DAY' + (taken === 1 ? '' : 'S') +
            '. COOLDOWN ENDS ' + c.cooldownUntil + '.');
        }
      },
      {
        name: 'DEPART',
        desc: 'MARK DEPARTED. RELEASES HOUSING, VACATES POSITION, RETURNS CLAIMED JOBS TO OPEN.',
        args: [{ name: 'ign', req: true }],
        example: 'CIT DEPART philly_9859',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          if (c.status === 'DEPARTED') throw errObj('0009', c.ign + ' HAS ALREADY DEPARTED.');
          api.confirm('DEPART ' + c.ign + ': RELEASE HOUSING, VACATE POSITION, REOPEN CLAIMED JOBS.');
          c.status = 'DEPARTED';
          c.afkFrom = null; c.afkUntil = null;
          doc.housing.forEach(function (h) {
            if (h.occupantId === c.id) { h.occupantId = null; api.out('HOUSING ' + h.id + ' ' + h.unit + ' RELEASED.'); }
          });
          c.housingId = null;
          doc.positions.forEach(function (p) {
            if (p.holderId === c.id) { p.holderId = null; api.out('POSITION ' + p.id + ' ' + p.title + ' VACATED.'); }
          });
          c.positionId = null;
          doc.jobs.forEach(function (j) {
            if (j.claimedBy === c.id && (j.status === 'CLAIMED' || j.status === 'SUBMITTED')) {
              j.status = 'OPEN';
              j.claimedBy = null; j.claimedAt = null; j.submittedAt = null; j.submitNote = null;
              api.out('JOB ' + j.id + ' RETURNED TO OPEN.');
            }
          });
          api.out(c.id + ' ' + c.ign + ' DEPARTED. BALANCE ' + fmtHp(balance(doc, c.id)) + ' HP REMAINS ON LEDGER.');
        }
      },
      {
        name: 'FIND',
        desc: 'SEARCH IGN, DISCORD, CLAN, AND NOTES.',
        args: [{ name: 'text', req: true }],
        example: 'CIT FIND vizsla',
        handler: function (api) {
          var t = String(api.args.text).toUpperCase();
          var rows = api.doc.citizens.filter(function (c) {
            return [c.ign, c.discord, c.clan, c.notes].some(function (v) {
              return v && String(v).toUpperCase().indexOf(t) >= 0;
            });
          });
          if (rows.length === 0) { api.out('NO MATCH FOR "' + api.args.text + '".'); return; }
          rows.forEach(function (c) {
            api.out(rpad(c.id, 9) + rpad(c.ign, 18) + rpad(c.rank, 12) + rpad(c.status, 9) +
              (c.clan ? ' CLAN ' + c.clan : '') + (c.discord ? ' DISCORD ' + c.discord : ''));
          });
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * LEDGER (HP)
   * ------------------------------------------------------------------ */

  var VAULT_CATEGORIES = ['ARTIFACTS', 'NETHERITE', 'MYTHICS', 'RARE', 'DIAMOND', 'ANIMALS', 'OTHER'];

  function resolveVaultCategory(input) {
    var up = String(input).toUpperCase();
    if (VAULT_CATEGORIES.indexOf(up) >= 0) return up;
    var hits = VAULT_CATEGORIES.filter(function (c) { return c.indexOf(up) === 0; });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw errObj('0003', 'AMBIGUOUS CATEGORY "' + input + '": ' + hits.join(', '));
    throw errObj('0005', 'UNKNOWN VAULT CATEGORY "' + input + '". CATEGORIES: ' + VAULT_CATEGORIES.join(' '));
  }

  function requireActiveIsh(c) {
    if (c.status === 'DEPARTED') throw errObj('0009', c.ign + ' HAS DEPARTED.');
  }

  function cashWindow(doc, ctx, citizenId) {
    var cutoff = new Date(new Date(ctx.now).getTime() - 7 * 86400000);
    var bought = 0;
    doc.ledger.forEach(function (l) {
      if (l.citizenId === citizenId && l.category === 'CASHBUY' && l.delta > 0 &&
          new Date(l.ts) > cutoff) bought += l.delta;
    });
    return bought;
  }

  registerModule({
    name: 'HP', aliases: ['LEDGER'], title: 'LEDGER', desc: 'HONOR POINTS LEDGER',
    menu: true,
    actions: [
      {
        name: 'BAL',
        desc: 'BALANCE FOR ONE CITIZEN.',
        args: [{ name: 'ign', req: true }],
        example: 'HP BAL philly_9859',
        handler: function (api) {
          var c = findCitizen(api.doc, api.args.ign);
          api.out(c.ign + '  ' + c.rank + '  BALANCE ' + fmtHp(balance(api.doc, c.id)) + ' HP');
        }
      },
      {
        name: 'CREDIT',
        desc: 'ADD HP. DEFAULT CATEGORY ADJUST.',
        args: [{ name: 'ign', req: true }, { name: 'amount', req: true }, { name: 'reason', req: true }],
        flags: [{ name: 'cat', help: 'LEDGER CATEGORY' }, { name: 'ref', help: 'CROSS-REFERENCE ID' }],
        example: 'HP CREDIT philly_9859 100 "Event prize" --cat EVENT',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var amt = parsePositive(api.args.amount, 'AMOUNT');
          var cat = api.flags.cat ? resolveCategory(api.flags.cat) : 'ADJUST';
          var bal = balance(doc, c.id);
          api.confirm('CREDIT ' + fmtHp(amt) + ' HP TO ' + c.ign + ' (' + fmtHp(bal) + ' -> ' +
            fmtHp(bal + amt) + ') CAT=' + cat + '.');
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: amt, category: cat,
            reason: api.args.reason, ref: api.flags.ref ? String(api.flags.ref).toUpperCase() : null
          });
          api.out(fmtLedgerLine(doc, l));
        }
      },
      {
        name: 'DEBIT',
        desc: 'REMOVE HP. MAY TAKE A BALANCE NEGATIVE (PRINTS A WARNING).',
        args: [{ name: 'ign', req: true }, { name: 'amount', req: true }, { name: 'reason', req: true }],
        flags: [{ name: 'cat', help: 'LEDGER CATEGORY' }, { name: 'ref', help: 'CROSS-REFERENCE ID' }],
        example: 'HP DEBIT philly_9859 50 "North subclaim" --cat SUBCLAIM',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          var amt = parsePositive(api.args.amount, 'AMOUNT');
          var cat = api.flags.cat ? resolveCategory(api.flags.cat) : 'ADJUST';
          var bal = balance(doc, c.id);
          api.confirm('DEBIT ' + fmtHp(amt) + ' HP FROM ' + c.ign + ' (' + fmtHp(bal) + ' -> ' +
            fmtHp(bal - amt) + ') CAT=' + cat + '.');
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: -amt, category: cat,
            reason: api.args.reason, ref: api.flags.ref ? String(api.flags.ref).toUpperCase() : null
          });
          api.out(fmtLedgerLine(doc, l));
          if (l.balanceAfter < 0) api.out('WARNING: BALANCE NEGATIVE (' + fmtHp(l.balanceAfter) + ' HP).');
        }
      },
      {
        name: 'EVENT',
        desc: 'ONE CREDIT PER NAME, ONE CONFIRMATION. CAT=EVENT.',
        args: [{ name: 'amount', req: true }, { name: 'reason', req: true },
               { name: 'igns', req: true, variadic: true }],
        example: 'HP EVENT 50 "Siege of Sorrento" philly_9859 al5aja rex_22',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var amt = parsePositive(api.args.amount, 'AMOUNT');
          var cits = api.args.igns.map(function (i) { return findCitizen(doc, i); });
          cits.forEach(requireActiveIsh);
          var seen = {};
          cits.forEach(function (c) {
            if (seen[c.id]) throw errObj('0004', c.ign + ' LISTED TWICE.');
            seen[c.id] = true;
          });
          api.confirm('EVENT: CREDIT ' + fmtHp(amt) + ' HP EACH TO ' + cits.length + ' CITIZENS (' +
            cits.map(function (c) { return c.ign; }).join(', ') + ').');
          cits.forEach(function (c) {
            var l = postLedger(doc, api.ctx, {
              citizenId: c.id, delta: amt, category: 'EVENT', reason: api.args.reason
            });
            api.out(fmtLedgerLine(doc, l));
          });
        }
      },
      {
        name: 'DONATE',
        desc: 'CREDIT A DONOR (CAT=DONATION). --VAULT ALSO ADDS THE ITEM TO THE VAULT.',
        args: [{ name: 'ign', req: true }, { name: 'hp', req: true }, { name: 'what', req: true }],
        flags: [
          { name: 'vault', nargs: 2, value: 'price', value2: 'qty', help: 'ADD TO VAULT: PRICE (OR UNPRICED) AND OPTIONAL QTY' },
          { name: 'cat', help: 'VAULT CATEGORY (WITH --VAULT ONLY)' }
        ],
        example: 'HP DONATE philly_9859 300 "Maxed Trident" --vault 600 1 --cat RARE',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var amt = parsePositive(api.args.hp, 'HP');
          var withVault = api.flags.vault !== undefined;
          if (api.flags.cat && !withVault) throw errObj('0004', '--CAT NEEDS --VAULT.');
          var price = null, qty = 1, vcat = 'OTHER';
          if (withVault) {
            var v = api.flags.vault;
            var priceRaw = Array.isArray(v) ? v[0] : v;
            if (String(priceRaw).toUpperCase() === 'UNPRICED') price = null;
            else price = parsePositive(priceRaw, 'PRICE');
            if (Array.isArray(v) && v.length > 1) qty = parsePositive(v[1], 'QTY');
            if (api.flags.cat) vcat = resolveVaultCategory(api.flags.cat);
          }
          var bal = balance(doc, c.id);
          api.confirm('DONATION: CREDIT ' + fmtHp(amt) + ' HP TO ' + c.ign + ' (' + fmtHp(bal) + ' -> ' +
            fmtHp(bal + amt) + ') FOR "' + api.args.what + '"' +
            (withVault ? '. ADD TO VAULT: ' + qty + ' X ' + api.args.what + ' AT ' +
              (price === null ? 'UNPRICED' : fmtHp(price) + ' HP') + ' (' + vcat + ')' : '') + '.');
          var vltId = null;
          if (withVault) {
            vltId = nextId(doc, 'VLT');
          }
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: amt, category: 'DONATION',
            reason: 'Donated: ' + api.args.what, ref: vltId
          });
          api.out(fmtLedgerLine(doc, l));
          if (withVault) {
            doc.vault.push({
              id: vltId, name: api.args.what, category: vcat, qty: qty, price: price,
              notes: 'Donated by ' + c.ign + ' (' + l.id + ')',
              addedBy: api.ctx.operator, addedAt: ts(api.ctx)
            });
            api.out(vltId + ' ADDED TO VAULT: ' + qty + ' X ' + api.args.what + ' AT ' +
              (price === null ? 'UNPRICED' : fmtHp(price) + ' HP') + '.');
          }
        }
      },
      {
        name: 'BUY',
        desc: 'CONVERT SW CASH TO HP AT CASHPERHP. WEEKLY CAP ENFORCED. NO CONVERSION BACK.',
        args: [{ name: 'ign', req: true }, { name: 'swcash', req: true }],
        example: 'HP BUY philly_9859 100000',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, s = doc.settings, c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var cash = parsePositive(api.args.swcash, 'SW CASH');
          var rate = s.cashPerHp * (1 + s.cashMarkupPct / 100);
          var afford = Math.floor(cash / rate);
          var bought = cashWindow(doc, api.ctx, c.id);
          var capLeft = Math.max(0, s.cashBuyCapHp - bought);
          if (capLeft <= 0) {
            throw errObj('0015', 'CASH BUY CAP REACHED. ' + fmtHp(bought) + ' OF ' +
              fmtHp(s.cashBuyCapHp) + ' HP BOUGHT IN THE LAST 7 DAYS.');
          }
          if (afford <= 0) throw errObj('0011', 'CASH BELOW RATE. ' + fmtHp(Math.ceil(rate)) + ' SW PER 1 HP.');
          var hpOut = Math.min(afford, capLeft);
          var usedCash = Math.ceil(hpOut * rate);
          var unused = cash - usedCash;
          api.confirm('CASH BUY: ' + c.ign + ' PAYS ' + fmtHp(usedCash) + ' SW FOR ' + fmtHp(hpOut) +
            ' HP AT ' + rate + ' SW/HP' + (hpOut < afford ? ' (CAPPED)' : '') + '.');
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: hpOut, category: 'CASHBUY',
            reason: 'Cash buy ' + usedCash + ' SW at ' + rate + ' SW/HP'
          });
          api.out(fmtLedgerLine(doc, l));
          api.out('CASH IN ' + fmtHp(cash) + ' SW. HP OUT ' + fmtHp(hpOut) +
            '. UNUSED CASH ' + fmtHp(unused) + ' SW. CAP REMAINING ' + fmtHp(capLeft - hpOut) + ' HP.');
        }
      },
      {
        name: 'LOG',
        desc: 'LEDGER LINES, OLDEST FIRST. DEFAULT LAST 20.',
        args: [{ name: 'ign', req: false }],
        flags: [
          { name: 'n', help: 'LINE COUNT (DEFAULT 20)' },
          { name: 'cat', help: 'FILTER BY CATEGORY' },
          { name: 'since', help: 'ON OR AFTER DATE' }
        ],
        example: 'HP LOG philly_9859 --n 30 --cat JOB',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.ledger.slice();
          if (api.args.ign) {
            var c = findCitizen(doc, api.args.ign);
            rows = rows.filter(function (l) { return l.citizenId === c.id; });
          }
          if (api.flags.cat) {
            var cat = resolveCategory(api.flags.cat);
            rows = rows.filter(function (l) { return l.category === cat; });
          }
          if (api.flags.since) {
            var since = parseDate(api.flags.since, api.ctx);
            rows = rows.filter(function (l) { return l.ts.slice(0, 10) >= since; });
          }
          var n = api.flags.n ? parsePositive(api.flags.n, 'COUNT') : 20;
          rows = rows.slice(-n);
          if (rows.length === 0) { api.out('NO LEDGER LINES MATCH.'); return; }
          rows.forEach(function (l) { api.out(fmtLedgerLine(doc, l)); });
          api.out(rows.length + ' LINE' + (rows.length === 1 ? '' : 'S') + '.');
        }
      },
      {
        name: 'REVERSE',
        desc: 'POST A COMPENSATING LINE (CAT=REVERSAL). NEVER DELETES. NO DOUBLE REVERSALS.',
        args: [{ name: 'ledgerId', req: true }, { name: 'reason', req: true }],
        example: 'HP REVERSE LDG-000123 "Posted to the wrong citizen"',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var orig = findById(doc, 'ledger', api.args.ledgerId, 'LEDGER LINE');
          if (orig.category === 'REVERSAL') throw errObj('0009', orig.id + ' IS A REVERSAL. IT CANNOT BE REVERSED.');
          var already = doc.ledger.filter(function (l) { return l.reversesId === orig.id; })[0];
          if (already) throw errObj('0009', orig.id + ' WAS ALREADY REVERSED BY ' + already.id + '.');
          var c = findCitizen(doc, orig.citizenId);
          api.confirm('REVERSE ' + orig.id + ': POST ' + (orig.delta > 0 ? '-' : '+') + fmtHp(Math.abs(orig.delta)) +
            ' HP TO ' + c.ign + '.');
          var l = postLedger(doc, api.ctx, {
            citizenId: orig.citizenId, delta: -orig.delta, category: 'REVERSAL',
            reason: api.args.reason, ref: orig.id, reversesId: orig.id
          });
          api.out(fmtLedgerLine(doc, l));
        }
      },
      {
        name: 'TOP',
        desc: 'HIGHEST BALANCES. DEFAULT 10.',
        args: [{ name: 'n', req: false }],
        example: 'HP TOP 5',
        handler: function (api) { topBottom(api, false); }
      },
      {
        name: 'BOTTOM',
        desc: 'LOWEST BALANCES. DEFAULT 10.',
        args: [{ name: 'n', req: false }],
        example: 'HP BOTTOM 5',
        handler: function (api) { topBottom(api, true); }
      }
    ]
  });

  function topBottom(api, ascending) {
    var doc = api.doc;
    var n = api.args.n ? parsePositive(api.args.n, 'COUNT') : 10;
    var rows = doc.citizens.map(function (c) { return { c: c, bal: balance(doc, c.id) }; });
    rows.sort(function (a, b) { return ascending ? a.bal - b.bal : b.bal - a.bal; });
    rows = rows.slice(0, n);
    if (rows.length === 0) { api.out('NO CITIZENS.'); return; }
    rows.forEach(function (r, i) {
      api.out(lpad(i + 1, 3) + '  ' + rpad(r.c.ign, 18) + rpad(r.c.rank, 12) +
        rpad(r.c.status, 9) + lpad(fmtHp(r.bal), 9) + ' HP');
    });
  }

  /* ------------------------------------------------------------------ *
   * JOBS (JOB)
   * ------------------------------------------------------------------ */

  var JOB_CATEGORIES = ['BUILDING', 'ECONOMY', 'PVP', 'LORE', 'POLITICS', 'RECRUITMENT', 'OTHER'];
  var JOB_STATUSES = ['OPEN', 'CLAIMED', 'SUBMITTED', 'PAID', 'ARCHIVED'];

  function resolveListed(input, list, label) {
    var up = String(input).toUpperCase();
    if (list.indexOf(up) >= 0) return up;
    var hits = list.filter(function (c) { return c.indexOf(up) === 0; });
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw errObj('0003', 'AMBIGUOUS ' + label + ' "' + input + '": ' + hits.join(', '));
    throw errObj('0005', 'UNKNOWN ' + label + ' "' + input + '". OPTIONS: ' + list.join(' '));
  }

  function jobLine(doc, j) {
    var who = '';
    if (j.claimedBy) {
      var c = doc.citizens.filter(function (x) { return x.id === j.claimedBy; })[0];
      who = c ? c.ign : j.claimedBy;
    }
    return rpad(j.id, 9) + rpad(j.status, 10) + rpad(j.category, 12) + lpad(fmtHp(j.reward), 7) +
      '  ' + rpad(j.title.slice(0, 28), 29) + (j.deadline ? 'DUE ' + j.deadline + ' ' : '') +
      (who ? 'BY ' + who : '');
  }

  registerModule({
    name: 'JOB', aliases: ['JOBS'], title: 'JOBS', desc: 'JOBS BOARD',
    menu: true,
    actions: [
      {
        name: 'POST',
        desc: 'POST A JOB TO THE BOARD.',
        args: [{ name: 'title', req: true }, { name: 'description', req: false }],
        flags: [
          { name: 'cat', help: 'BUILDING ECONOMY PVP LORE POLITICS RECRUITMENT OTHER' },
          { name: 'reward', help: 'REWARD IN HP (0 FOR PAY-PER-DELIVERY)' },
          { name: 'coords', help: 'X/Y/Z' },
          { name: 'spawn', help: 'SPAWN NAME (DEFAULT SETTINGS DEFAULTSPAWN WHEN COORDS GIVEN)' },
          { name: 'deadline', help: 'DUE DATE' }
        ],
        menuFields: [
          { label: 'TITLE', kind: 'arg', required: true, def: '' },
          { label: 'CATEGORY', kind: 'flag', flag: 'cat', required: true, def: 'BUILDING' },
          { label: 'REWARD HP', kind: 'flag', flag: 'reward', required: true, def: '' },
          { label: 'COORDS X/Y/Z', kind: 'flag', flag: 'coords', def: '' },
          { label: 'SPAWN', kind: 'flag', flag: 'spawn', def: '' },
          { label: 'DEADLINE', kind: 'flag', flag: 'deadline', def: '' },
          { label: 'DESCRIPTION', kind: 'arg', def: '' }
        ],
        example: 'JOB POST "Demolition" --cat BUILDING --reward 80 --coords -2809/115/-8901 "Clear the marked structure."',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          if (!api.flags.cat) throw errObj('0004', '--CAT IS REQUIRED. ' + JOB_CATEGORIES.join(' '));
          if (api.flags.reward === undefined) throw errObj('0004', '--REWARD IS REQUIRED (0 IS ALLOWED).');
          var cat = resolveListed(api.flags.cat, JOB_CATEGORIES, 'CATEGORY');
          var reward = parseAmount(api.flags.reward, 'REWARD');
          if (reward < 0) throw errObj('0011', 'REWARD CANNOT BE NEGATIVE.');
          var j = {
            id: nextId(doc, 'JOB'), title: api.args.title, category: cat,
            coords: api.flags.coords || null,
            spawn: api.flags.spawn || (api.flags.coords ? doc.settings.defaultSpawn : null),
            description: api.args.description || '',
            reward: reward,
            deadline: api.flags.deadline ? parseDate(api.flags.deadline, api.ctx) : null,
            status: 'OPEN', claimedBy: null, claimedAt: null,
            submittedAt: null, submitNote: null, paidAt: null, paidLedgerId: null,
            postedBy: api.ctx.operator, postedAt: ts(api.ctx)
          };
          doc.jobs.push(j);
          api.out(j.id + ' POSTED: ' + j.title + '  ' + j.category + '  REWARD ' + fmtHp(j.reward) + ' HP' +
            (j.deadline ? '  DUE ' + j.deadline : ''));
        }
      },
      {
        name: 'LIST',
        desc: 'LIST JOBS. DEFAULT SHOWS OPEN, CLAIMED, SUBMITTED.',
        flags: [
          { name: 'cat', help: 'FILTER BY CATEGORY' },
          { name: 'status', help: 'FILTER BY STATUS' },
          { name: 'claimed', help: 'FILTER BY CLAIMANT IGN' }
        ],
        example: 'JOB LIST --cat BUILDING',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.jobs.slice();
          if (api.flags.status) {
            var st = resolveListed(api.flags.status, JOB_STATUSES, 'STATUS');
            rows = rows.filter(function (j) { return j.status === st; });
          } else {
            rows = rows.filter(function (j) {
              return j.status === 'OPEN' || j.status === 'CLAIMED' || j.status === 'SUBMITTED';
            });
          }
          if (api.flags.cat) {
            var cat = resolveListed(api.flags.cat, JOB_CATEGORIES, 'CATEGORY');
            rows = rows.filter(function (j) { return j.category === cat; });
          }
          if (api.flags.claimed) {
            var c = findCitizen(doc, api.flags.claimed);
            rows = rows.filter(function (j) { return j.claimedBy === c.id; });
          }
          if (rows.length === 0) { api.out('NO JOBS MATCH.'); return; }
          rows.forEach(function (j) { api.out(jobLine(doc, j)); });
          api.out(rows.length + ' JOB' + (rows.length === 1 ? '' : 'S') + '.');
        }
      },
      {
        name: 'SHOW',
        desc: 'FULL JOB DETAIL.',
        args: [{ name: 'id', req: true }],
        example: 'JOB SHOW JOB-0003',
        handler: function (api) {
          var doc = api.doc, j = findById(doc, 'jobs', api.args.id, 'JOB');
          api.out(j.id + '  ' + j.status + '  ' + j.category + '  REWARD ' + fmtHp(j.reward) + ' HP');
          api.out(j.title);
          if (j.coords) api.out('COORDS ' + j.coords + (j.spawn ? '  SPAWN ' + j.spawn : ''));
          else if (j.spawn) api.out('SPAWN ' + j.spawn);
          if (j.deadline) api.out('DEADLINE ' + j.deadline);
          if (j.description) api.out(j.description);
          if (j.claimedBy) {
            var c = doc.citizens.filter(function (x) { return x.id === j.claimedBy; })[0];
            api.out('CLAIMED BY ' + (c ? c.ign : j.claimedBy) + ' AT ' + fmtLocal(j.claimedAt));
          }
          if (j.submittedAt) api.out('SUBMITTED ' + fmtLocal(j.submittedAt) +
            (j.submitNote ? '  NOTE: ' + j.submitNote : ''));
          if (j.paidAt) api.out('PAID ' + fmtLocal(j.paidAt) + '  ' + j.paidLedgerId);
          api.out('POSTED BY ' + (j.postedBy || '-') + ' AT ' + fmtLocal(j.postedAt));
        }
      },
      {
        name: 'CLAIM',
        desc: 'CLAIM AN OPEN JOB FOR A CITIZEN.',
        args: [{ name: 'id', req: true }, { name: 'ign', req: true }],
        example: 'JOB CLAIM JOB-0003 philly_9859',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, j = findById(doc, 'jobs', api.args.id, 'JOB');
          var c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          if (j.status !== 'OPEN') throw errObj('0009', j.id + ' IS ' + j.status + ', NOT OPEN.');
          j.status = 'CLAIMED';
          j.claimedBy = c.id;
          j.claimedAt = ts(api.ctx);
          api.out(j.id + ' CLAIMED BY ' + c.ign + '.' + (j.deadline ? ' DUE ' + j.deadline + '.' : ''));
        }
      },
      {
        name: 'UNCLAIM',
        desc: 'RETURN A CLAIMED OR SUBMITTED JOB TO OPEN.',
        args: [{ name: 'id', req: true }],
        example: 'JOB UNCLAIM JOB-0003',
        mutates: true,
        handler: function (api) {
          var j = findById(api.doc, 'jobs', api.args.id, 'JOB');
          if (j.status !== 'CLAIMED' && j.status !== 'SUBMITTED') {
            throw errObj('0009', j.id + ' IS ' + j.status + '. NOTHING TO UNCLAIM.');
          }
          j.status = 'OPEN';
          j.claimedBy = null; j.claimedAt = null; j.submittedAt = null; j.submitNote = null;
          api.out(j.id + ' RETURNED TO OPEN.');
        }
      },
      {
        name: 'SUBMIT',
        desc: 'MARK A CLAIMED JOB SUBMITTED FOR OFFICER REVIEW.',
        args: [{ name: 'id', req: true }],
        flags: [{ name: 'note', help: 'SUBMISSION NOTE' }],
        example: 'JOB SUBMIT JOB-0003 --note "Screenshots in discord"',
        mutates: true,
        handler: function (api) {
          var j = findById(api.doc, 'jobs', api.args.id, 'JOB');
          if (j.status !== 'CLAIMED') throw errObj('0009', j.id + ' IS ' + j.status + ', NOT CLAIMED.');
          j.status = 'SUBMITTED';
          j.submittedAt = ts(api.ctx);
          j.submitNote = api.flags.note || null;
          api.out(j.id + ' SUBMITTED FOR REVIEW.');
        }
      },
      {
        name: 'PAY',
        desc: 'PAY THE CLAIMANT AND MARK PAID. --AMOUNT OVERRIDES THE POSTED REWARD.',
        args: [{ name: 'id', req: true }],
        flags: [{ name: 'amount', help: 'OVERRIDE REWARD (FOR ONGOING JOBS)' }],
        example: 'JOB PAY JOB-0011 --amount 120',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, j = findById(doc, 'jobs', api.args.id, 'JOB');
          if (j.status === 'PAID') throw errObj('0009', j.id + ' WAS ALREADY PAID (' + j.paidLedgerId + ').');
          if (!j.claimedBy || (j.status !== 'CLAIMED' && j.status !== 'SUBMITTED')) {
            throw errObj('0009', j.id + ' IS ' + j.status + ' AND UNCLAIMED. CLAIM IT FIRST.');
          }
          var c = findCitizen(doc, j.claimedBy);
          var amount = api.flags.amount !== undefined ? parsePositive(api.flags.amount, 'AMOUNT') : j.reward;
          if (amount <= 0) throw errObj('0011', 'POSTED REWARD IS 0. USE --AMOUNT.');
          var bal = balance(doc, c.id);
          api.confirm('PAY ' + j.id + ' "' + j.title + '": CREDIT ' + fmtHp(amount) + ' HP TO ' + c.ign +
            ' (' + fmtHp(bal) + ' -> ' + fmtHp(bal + amount) + ').');
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: amount, category: 'JOB',
            reason: 'Job payout: ' + j.title, ref: j.id
          });
          j.status = 'PAID';
          j.paidAt = ts(api.ctx);
          j.paidLedgerId = l.id;
          api.out(fmtLedgerLine(doc, l));
          api.out(j.id + ' MARKED PAID.');
        }
      },
      {
        name: 'EDIT',
        desc: 'EDIT A FIELD: TITLE, CATEGORY, COORDS, SPAWN, DESCRIPTION, REWARD, DEADLINE.',
        args: [{ name: 'id', req: true }, { name: 'field', req: true }, { name: 'value', req: true }],
        example: 'JOB EDIT JOB-0003 reward 250',
        mutates: true,
        handler: function (api) {
          var j = findById(api.doc, 'jobs', api.args.id, 'JOB');
          var f = resolveListed(api.args.field,
            ['TITLE', 'CATEGORY', 'COORDS', 'SPAWN', 'DESCRIPTION', 'REWARD', 'DEADLINE'], 'FIELD');
          var v = api.args.value;
          if (f === 'CATEGORY') j.category = resolveListed(v, JOB_CATEGORIES, 'CATEGORY');
          else if (f === 'REWARD') {
            var amt = parseAmount(v, 'REWARD');
            if (amt < 0) throw errObj('0011', 'REWARD CANNOT BE NEGATIVE.');
            j.reward = amt;
          }
          else if (f === 'DEADLINE') j.deadline = String(v).toUpperCase() === 'NONE' ? null : parseDate(v, api.ctx);
          else j[f.toLowerCase()] = v;
          api.out(j.id + ' ' + f + ' SET.');
        }
      },
      {
        name: 'ARCHIVE',
        desc: 'ARCHIVE A JOB. CLAIMED OR SUBMITTED JOBS MUST BE UNCLAIMED FIRST.',
        args: [{ name: 'id', req: true }],
        example: 'JOB ARCHIVE JOB-0003',
        mutates: true,
        handler: function (api) {
          var j = findById(api.doc, 'jobs', api.args.id, 'JOB');
          if (j.status === 'CLAIMED' || j.status === 'SUBMITTED') {
            throw errObj('0009', j.id + ' IS ' + j.status + '. UNCLAIM IT FIRST.');
          }
          if (j.status === 'ARCHIVED') throw errObj('0009', j.id + ' IS ALREADY ARCHIVED.');
          j.status = 'ARCHIVED';
          api.out(j.id + ' ARCHIVED.');
        }
      },
      {
        name: 'REOPEN',
        desc: 'RETURN AN ARCHIVED OR PAID JOB TO OPEN (CLEARS CLAIM AND PAYMENT MARKS).',
        args: [{ name: 'id', req: true }],
        example: 'JOB REOPEN JOB-0011',
        mutates: true,
        handler: function (api) {
          var j = findById(api.doc, 'jobs', api.args.id, 'JOB');
          if (j.status !== 'ARCHIVED' && j.status !== 'PAID') {
            throw errObj('0009', j.id + ' IS ' + j.status + '. ONLY ARCHIVED OR PAID JOBS REOPEN.');
          }
          j.status = 'OPEN';
          j.claimedBy = null; j.claimedAt = null; j.submittedAt = null; j.submitNote = null;
          j.paidAt = null; j.paidLedgerId = null;
          api.out(j.id + ' REOPENED.');
        }
      },
      {
        name: 'DUE',
        desc: 'JOBS WITH A DEADLINE INSIDE THE WINDOW, SOONEST FIRST. DEFAULT 7 DAYS.',
        args: [{ name: 'days', req: false }],
        example: 'JOB DUE 14',
        handler: function (api) {
          var doc = api.doc;
          var days = api.args.days ? parsePositive(api.args.days, 'DAYS') : 7;
          var limit = addDays(todayLocal(api.ctx), days);
          var rows = doc.jobs.filter(function (j) {
            return j.deadline && j.deadline <= limit &&
              (j.status === 'OPEN' || j.status === 'CLAIMED' || j.status === 'SUBMITTED');
          });
          rows.sort(function (a, b) { return a.deadline < b.deadline ? -1 : 1; });
          if (rows.length === 0) { api.out('NO DEADLINES INSIDE ' + days + ' DAYS.'); return; }
          rows.forEach(function (j) { api.out(jobLine(doc, j)); });
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * VAULT
   * ------------------------------------------------------------------ */

  function vaultDiscountPct(doc, rankName) {
    var pct = doc.settings.vaultDiscountPct[rankName];
    return typeof pct === 'number' ? pct : 0;
  }

  function vaultQuote(doc, c, v, qty) {
    if (v.price === null) throw errObj('0009', v.id + ' ' + v.name + ' IS UNPRICED. PRICE IT FIRST: VAULT SET ' + v.id + ' PRICE <HP>.');
    var minIdx = rankIndex(doc, resolveRank(doc, doc.settings.vaultMinRank));
    var eligible = rankIndex(doc, c.rank) >= minIdx;
    var pct = vaultDiscountPct(doc, c.rank);
    var unit = Math.floor(v.price * (100 - pct) / 100);
    return { eligible: eligible, pct: pct, unit: unit, total: unit * qty, minRank: doc.settings.vaultMinRank };
  }

  registerModule({
    name: 'VAULT', aliases: [], title: 'VAULT', desc: 'NATION VAULT AND REDEMPTIONS',
    menu: true,
    actions: [
      {
        name: 'LIST',
        desc: 'LIST VAULT ITEMS. --INSTOCK HIDES EMPTY STOCK.',
        flags: [
          { name: 'cat', help: 'FILTER BY CATEGORY' },
          { name: 'instock', boolean: true, help: 'ONLY QTY > 0' }
        ],
        example: 'VAULT LIST --cat MYTHICS --instock',
        handler: function (api) {
          var rows = api.doc.vault.slice();
          if (api.flags.cat) {
            var cat = resolveVaultCategory(api.flags.cat);
            rows = rows.filter(function (v) { return v.category === cat; });
          }
          if (api.flags.instock) rows = rows.filter(function (v) { return v.qty > 0; });
          if (rows.length === 0) { api.out('NO VAULT ITEMS MATCH.'); return; }
          rows.forEach(function (v) {
            api.out(rpad(v.id, 9) + rpad(v.category, 11) + lpad(v.qty, 4) + '  ' +
              lpad(v.price === null ? 'UNPRICED' : fmtHp(v.price) + ' HP', 12) + '  ' + v.name);
          });
          api.out(rows.length + ' ITEM' + (rows.length === 1 ? '' : 'S') + '.');
        }
      },
      {
        name: 'SHOW',
        desc: 'FULL ITEM DETAIL.',
        args: [{ name: 'id', req: true }],
        example: 'VAULT SHOW VLT-0004',
        handler: function (api) {
          var v = findById(api.doc, 'vault', api.args.id, 'VAULT ITEM');
          api.out(v.id + '  ' + v.category + '  QTY ' + v.qty + '  ' +
            (v.price === null ? 'UNPRICED' : fmtHp(v.price) + ' HP'));
          api.out(v.name);
          if (v.notes) api.out('NOTES: ' + v.notes);
          api.out('ADDED BY ' + (v.addedBy || '-') + ' AT ' + fmtLocal(v.addedAt));
        }
      },
      {
        name: 'ADD',
        desc: 'ADD AN ITEM. PRICE IN HP OR THE WORD UNPRICED.',
        args: [{ name: 'name', req: true }, { name: 'price', req: true }, { name: 'qty', req: false }],
        flags: [
          { name: 'cat', help: 'ARTIFACTS NETHERITE MYTHICS RARE DIAMOND ANIMALS OTHER (DEFAULT OTHER)' },
          { name: 'notes', help: 'FREE NOTES' }
        ],
        example: 'VAULT ADD "Nether Star" 250 1 --cat RARE',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var price = String(api.args.price).toUpperCase() === 'UNPRICED' ? null
            : parsePositive(api.args.price, 'PRICE');
          var qty = api.args.qty !== undefined ? parsePositive(api.args.qty, 'QTY') : 1;
          var v = {
            id: nextId(doc, 'VLT'), name: api.args.name,
            category: api.flags.cat ? resolveVaultCategory(api.flags.cat) : 'OTHER',
            qty: qty, price: price, notes: api.flags.notes || '',
            addedBy: api.ctx.operator, addedAt: ts(api.ctx)
          };
          doc.vault.push(v);
          api.out(v.id + ' ADDED: ' + qty + ' X ' + v.name + ' AT ' +
            (price === null ? 'UNPRICED' : fmtHp(price) + ' HP') + ' (' + v.category + ').');
        }
      },
      {
        name: 'SET',
        desc: 'EDIT A FIELD: NAME, CATEGORY, QTY, PRICE (OR UNPRICED), NOTES.',
        args: [{ name: 'id', req: true }, { name: 'field', req: true }, { name: 'value', req: true }],
        example: 'VAULT SET VLT-0007 PRICE 400',
        mutates: true,
        handler: function (api) {
          var v = findById(api.doc, 'vault', api.args.id, 'VAULT ITEM');
          var f = resolveListed(api.args.field, ['NAME', 'CATEGORY', 'QTY', 'PRICE', 'NOTES'], 'FIELD');
          var val = api.args.value;
          if (f === 'CATEGORY') v.category = resolveVaultCategory(val);
          else if (f === 'QTY') {
            var q = parseAmount(val, 'QTY');
            if (q < 0) throw errObj('0011', 'QTY CANNOT BE NEGATIVE.');
            v.qty = q;
          }
          else if (f === 'PRICE') v.price = String(val).toUpperCase() === 'UNPRICED' ? null : parsePositive(val, 'PRICE');
          else v[f.toLowerCase()] = val;
          api.out(v.id + ' ' + f + ' SET.');
        }
      },
      {
        name: 'REMOVE',
        desc: 'REMOVE AN ITEM FROM THE VAULT.',
        args: [{ name: 'id', req: true }],
        example: 'VAULT REMOVE VLT-0007',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, v = findById(doc, 'vault', api.args.id, 'VAULT ITEM');
          api.confirm('REMOVE ' + v.id + ' "' + v.name + '" (QTY ' + v.qty + ') FROM THE VAULT.');
          doc.vault = doc.vault.filter(function (x) { return x.id !== v.id; });
          api.out(v.id + ' REMOVED.');
        }
      },
      {
        name: 'PRICE',
        desc: 'QUOTE AN ITEM FOR A CITIZEN. NO PURCHASE.',
        args: [{ name: 'ign', req: true }, { name: 'id', req: true }],
        example: 'VAULT PRICE philly_9859 VLT-0004',
        handler: function (api) {
          var doc = api.doc;
          var c = findCitizen(doc, api.args.ign);
          var v = findById(doc, 'vault', api.args.id, 'VAULT ITEM');
          var q = vaultQuote(doc, c, v, 1);
          api.out(v.id + ' ' + v.name + ': LIST ' + fmtHp(v.price) + ' HP. DISCOUNT ' + q.pct +
            ' PCT (' + c.rank + '). PRICE FOR ' + c.ign + ': ' + fmtHp(q.unit) + ' HP.');
          if (!q.eligible) api.out('NOTE: ' + c.ign + ' IS BELOW ' + q.minRank + '. REDEMPTION WOULD REFUSE.');
        }
      },
      {
        name: 'REDEEM',
        desc: 'SELL AN ITEM TO A CITIZEN: RANK CHECK, DISCOUNT, STOCK, BALANCE, DEBIT.',
        args: [{ name: 'ign', req: true }, { name: 'id', req: true }, { name: 'qty', req: false }],
        example: 'VAULT REDEEM philly_9859 VLT-0004 1',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var v = findById(doc, 'vault', api.args.id, 'VAULT ITEM');
          var qty = api.args.qty !== undefined ? parsePositive(api.args.qty, 'QTY') : 1;
          var q = vaultQuote(doc, c, v, qty);
          if (!q.eligible) throw errObj('0009', 'VAULT REQUIRES RANK ' + q.minRank + '. ' + c.ign + ' IS ' + c.rank + '.');
          if (v.qty < qty) throw errObj('0009', 'STOCK ' + v.qty + ', ASKED ' + qty + '.');
          var bal = balance(doc, c.id);
          if (bal < q.total) {
            throw errObj('0008', 'INSUFFICIENT BALANCE. PRICE ' + fmtHp(q.total) + ' HP, BALANCE ' + fmtHp(bal) + ' HP.');
          }
          api.confirm('REDEEM ' + qty + ' X ' + v.name + ' TO ' + c.ign + ' FOR ' + fmtHp(q.total) +
            ' HP (LIST ' + fmtHp(v.price * qty) + ', DISCOUNT ' + q.pct + ' PCT).');
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: -q.total, category: 'VAULT',
            reason: 'Vault: ' + qty + ' x ' + v.name, ref: v.id
          });
          v.qty -= qty;
          api.out(fmtLedgerLine(doc, l));
          api.out('LIST ' + fmtHp(v.price * qty) + ' HP. DISCOUNT ' + q.pct + ' PCT. CHARGED ' +
            fmtHp(q.total) + ' HP. STOCK NOW ' + v.qty + '.');
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * RANKS (RANK)
   * ------------------------------------------------------------------ */

  registerModule({
    name: 'RANK', aliases: ['RANKS'], title: 'RANKS', desc: 'RANK LADDER AND PURCHASES',
    menu: true,
    actions: [
      {
        name: 'TABLE',
        desc: 'LADDER, STEP COSTS, CUMULATIVE COSTS FROM VERD\'IKA.',
        example: 'RANK TABLE',
        handler: function (api) {
          var ranks = api.doc.settings.ranks;
          var cum = 0;
          api.out(rpad('RANK', 14) + lpad('STEP', 9) + lpad('FROM ENTRY', 12));
          ranks.forEach(function (r) {
            if (r.cost === null) {
              api.out(rpad(r.name, 14) + lpad('N/A', 9) + lpad('RANK SET', 12));
            } else {
              cum += r.cost;
              api.out(rpad(r.name, 14) + lpad(fmtHp(r.cost), 9) + lpad(fmtHp(cum), 12));
            }
          });
        }
      },
      {
        name: 'BUY',
        desc: 'BUY THE NEXT RANK, OR A TARGET FURTHER UP (BUNDLE OF THE STEPS).',
        args: [{ name: 'ign', req: true }, { name: 'targetRank', req: false }],
        example: "RANK BUY philly_9859 AL'VERDE",
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var ranks = doc.settings.ranks;
          var cur = rankIndex(doc, c.rank);
          if (cur < 0) throw errObj('0009', c.ign + ' HAS UNKNOWN RANK "' + c.rank + '". FIX WITH RANK SET.');
          var target;
          if (api.args.targetRank) {
            target = rankIndex(doc, resolveRank(doc, api.args.targetRank));
          } else {
            target = cur + 1;
            if (target >= ranks.length || ranks[target].cost === null) {
              throw errObj('0009', c.ign + ' IS AT THE TOP OF THE PURCHASABLE LADDER.');
            }
          }
          if (target <= cur) throw errObj('0009', c.ign + ' IS ALREADY ' + c.rank + '.');
          if (ranks[target].cost === null) {
            throw errObj('0009', ranks[target].name + ' CANNOT BE BOUGHT. IT IS ASSIGNED WITH RANK SET.');
          }
          var cost = 0;
          for (var i = cur + 1; i <= target; i++) {
            if (ranks[i].cost === null) throw errObj('0009', ranks[i].name + ' CANNOT BE BOUGHT.');
            cost += ranks[i].cost;
          }
          var bal = balance(doc, c.id);
          if (bal < cost) {
            throw errObj('0008', 'INSUFFICIENT BALANCE. ' + ranks[target].name + ' COSTS ' + fmtHp(cost) +
              ' HP FROM ' + c.rank + ', BALANCE ' + fmtHp(bal) + ' HP.');
          }
          api.confirm('RANK BUY: ' + c.ign + ' ' + c.rank + ' -> ' + ranks[target].name + ' FOR ' +
            fmtHp(cost) + ' HP (' + fmtHp(bal) + ' -> ' + fmtHp(bal - cost) + ').');
          var l = postLedger(doc, api.ctx, {
            citizenId: c.id, delta: -cost, category: 'RANK',
            reason: 'Rank purchase ' + c.rank + ' -> ' + ranks[target].name
          });
          c.rank = ranks[target].name;
          api.out(fmtLedgerLine(doc, l));
          api.out(c.ign + ' IS NOW ' + c.rank + '.');
        }
      },
      {
        name: 'SET',
        desc: 'ASSIGN A RANK MANUALLY. NO HP MOVEMENT. LOGGED TO SYSLOG.',
        args: [{ name: 'ign', req: true }, { name: 'rank', req: true }, { name: 'reason', req: true }],
        example: 'RANK SET philly_9859 MAND\'ALOR "Election of 2026"',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          var rank = resolveRank(doc, api.args.rank);
          if (c.rank === rank) throw errObj('0009', c.ign + ' IS ALREADY ' + rank + '.');
          api.confirm('RANK SET: ' + c.ign + ' ' + c.rank + ' -> ' + rank + '. NO HP MOVEMENT.');
          var was = c.rank;
          c.rank = rank;
          pushSyslog(doc, api.ctx, 'RANK SET ' + c.ign + ' ' + was + ' -> ' + rank + ': ' + api.args.reason);
          api.out(c.ign + ' IS NOW ' + rank + '. (WAS ' + was + '.)');
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * RECRUITS (REC)
   * ------------------------------------------------------------------ */

  var REC_STEPS = ['DISCORD', 'INGAME', 'WEEK', 'EARNED'];

  function recStepsLine(r) {
    return REC_STEPS.map(function (s) {
      return s + (r.steps[s].done ? '[X]' : '[ ]');
    }).join(' ');
  }

  function hpEarned(doc, citizenId) {
    var sum = 0;
    doc.ledger.forEach(function (l) {
      if (l.citizenId === citizenId && l.delta > 0 && l.category !== 'CASHBUY') sum += l.delta;
    });
    return sum;
  }

  registerModule({
    name: 'REC', aliases: ['RECRUIT', 'RECRUITS'], title: 'RECRUITS', desc: 'RECRUITMENT VERIFICATION',
    menu: true,
    actions: [
      {
        name: 'LOG',
        desc: 'OPEN A VERIFICATION RECORD. ONE OPEN RECORD PER RECRUIT.',
        args: [{ name: 'recruiterIgn', req: true }, { name: 'recruitIgn', req: true }],
        example: 'REC LOG philly_9859 al5aja',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var recruiter = findCitizen(doc, api.args.recruiterIgn);
          var recruit = findCitizen(doc, api.args.recruitIgn);
          if (recruiter.id === recruit.id) throw errObj('0004', 'RECRUITER AND RECRUIT ARE THE SAME CITIZEN.');
          var open = doc.recruits.filter(function (r) {
            return r.recruitId === recruit.id && !r.paidLedgerId;
          })[0];
          if (open) throw errObj('0009', 'OPEN RECORD ' + open.id + ' ALREADY COVERS ' + recruit.ign + '.');
          var steps = {};
          REC_STEPS.forEach(function (s) { steps[s] = { done: false, doneAt: null, doneBy: null }; });
          var r = {
            id: nextId(doc, 'REC'),
            recruiterId: recruiter.id, recruitId: recruit.id,
            loggedAt: ts(api.ctx), loggedBy: api.ctx.operator,
            steps: steps, paidLedgerId: null
          };
          doc.recruits.push(r);
          api.out(r.id + ' OPENED: ' + recruiter.ign + ' RECRUITED ' + recruit.ign +
            '. STEPS: DISCORD INGAME WEEK EARNED.');
        }
      },
      {
        name: 'CHECK',
        desc: 'MARK A STEP DONE (OR --UNDO). WEEK WAITS OUT RECRUITWEEKDAYS. EARNED SHOWS THE NUMBERS.',
        args: [{ name: 'id', req: true }, { name: 'step', req: true }],
        flags: [{ name: 'undo', boolean: true, help: 'UNMARK THE STEP' }],
        example: 'REC CHECK REC-0007 WEEK',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, r = findById(doc, 'recruits', api.args.id, 'RECRUIT RECORD');
          if (r.paidLedgerId) throw errObj('0009', r.id + ' WAS ALREADY PAID. STEPS ARE CLOSED.');
          var step = resolveListed(api.args.step, REC_STEPS, 'STEP');
          var recruit = findCitizen(doc, r.recruitId);
          if (api.flags.undo) {
            if (!r.steps[step].done) throw errObj('0009', step + ' IS NOT MARKED.');
            r.steps[step] = { done: false, doneAt: null, doneBy: null };
            api.out(r.id + ' ' + step + ' UNMARKED. ' + recStepsLine(r));
            return;
          }
          if (r.steps[step].done) throw errObj('0009', step + ' IS ALREADY MARKED.');
          if (step === 'WEEK') {
            var gate = addDays(recruit.joinedAt, doc.settings.recruitWeekDays);
            var today = todayLocal(api.ctx);
            if (today < gate) {
              throw errObj('0009', 'WEEK OPENS ' + gate + '. ' + recruit.ign + ' JOINED ' + recruit.joinedAt + '.');
            }
          }
          if (step === 'EARNED') {
            api.out(recruit.ign + ' HAS EARNED ' + fmtHp(hpEarned(doc, recruit.id)) +
              ' HP TOTAL (CASH BUYS EXCLUDED). RANK ' + recruit.rank + '. OFFICER DECIDES.');
          }
          r.steps[step] = { done: true, doneAt: ts(api.ctx), doneBy: api.ctx.operator };
          api.out(r.id + ' ' + step + ' MARKED. ' + recStepsLine(r));
          var allDone = REC_STEPS.every(function (s) { return r.steps[s].done; });
          if (allDone) api.out('ALL STEPS DONE. REC PAY ' + r.id + ' PAYS THE RECRUITER.');
        }
      },
      {
        name: 'LIST',
        desc: 'LIST VERIFICATION RECORDS. --OPEN SHOWS UNPAID ONLY.',
        flags: [{ name: 'open', boolean: true, help: 'UNPAID RECORDS ONLY' }],
        example: 'REC LIST --open',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.recruits.slice();
          if (api.flags.open) rows = rows.filter(function (r) { return !r.paidLedgerId; });
          if (rows.length === 0) { api.out('NO RECRUIT RECORDS' + (api.flags.open ? ' OPEN' : '') + '.'); return; }
          rows.forEach(function (r) {
            var recruiter = doc.citizens.filter(function (c) { return c.id === r.recruiterId; })[0];
            var recruit = doc.citizens.filter(function (c) { return c.id === r.recruitId; })[0];
            api.out(rpad(r.id, 9) + rpad(recruiter ? recruiter.ign : r.recruiterId, 18) + '-> ' +
              rpad(recruit ? recruit.ign : r.recruitId, 18) + recStepsLine(r) +
              (r.paidLedgerId ? '  PAID ' + r.paidLedgerId : ''));
          });
        }
      },
      {
        name: 'PAY',
        desc: 'PAY THE RECRUITER ONCE ALL FOUR STEPS ARE DONE.',
        args: [{ name: 'id', req: true }],
        example: 'REC PAY REC-0007',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, r = findById(doc, 'recruits', api.args.id, 'RECRUIT RECORD');
          if (r.paidLedgerId) throw errObj('0009', r.id + ' WAS ALREADY PAID (' + r.paidLedgerId + ').');
          var missing = REC_STEPS.filter(function (s) { return !r.steps[s].done; });
          if (missing.length) throw errObj('0009', 'STEPS OUTSTANDING: ' + missing.join(' ') + '.');
          var recruiter = findCitizen(doc, r.recruiterId);
          var recruit = findCitizen(doc, r.recruitId);
          var amt = doc.settings.recruitRewardHp;
          var bal = balance(doc, recruiter.id);
          api.confirm('REC PAY ' + r.id + ': CREDIT ' + fmtHp(amt) + ' HP TO ' + recruiter.ign +
            ' FOR RECRUITING ' + recruit.ign + ' (' + fmtHp(bal) + ' -> ' + fmtHp(bal + amt) + ').');
          var l = postLedger(doc, api.ctx, {
            citizenId: recruiter.id, delta: amt, category: 'RECRUIT',
            reason: 'Verified recruit ' + recruit.ign, ref: r.id
          });
          r.paidLedgerId = l.id;
          api.out(fmtLedgerLine(doc, l));
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * HOUSING AND POSITIONS (HOUSE, POS)
   * ------------------------------------------------------------------ */

  registerModule({
    name: 'HOUSE', aliases: ['HOUSING'], title: 'HOUSING', desc: 'HOUSING UNITS AND ASSIGNMENT',
    menu: true,
    actions: [
      {
        name: 'ADD',
        desc: 'ADD A UNIT. --RENT FOR MONTHLY RENT, --PRICE FOR A ONE-TIME PURCHASE.',
        args: [{ name: 'unit', req: true }, { name: 'tier', req: true }],
        flags: [
          { name: 'rent', help: 'MONTHLY RENT IN HP (MODE RENT)' },
          { name: 'price', help: 'ONE-TIME PRICE IN HP (MODE OWNED)' }
        ],
        example: 'HOUSE ADD "Barracks Row 3" 1 --rent 50',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var hasRent = api.flags.rent !== undefined, hasPrice = api.flags.price !== undefined;
          if (hasRent === hasPrice) throw errObj('0004', 'GIVE EXACTLY ONE OF --RENT OR --PRICE.');
          var h = {
            id: nextId(doc, 'HSE'), unit: api.args.unit, tier: api.args.tier,
            mode: hasRent ? 'RENT' : 'OWNED',
            amount: parsePositive(hasRent ? api.flags.rent : api.flags.price, hasRent ? 'RENT' : 'PRICE'),
            occupantId: null
          };
          doc.housing.push(h);
          api.out(h.id + ' ADDED: ' + h.unit + '  TIER ' + h.tier + '  ' + h.mode + ' ' +
            fmtHp(h.amount) + ' HP' + (hasRent ? '/MONTH' : ' ONCE') + '.');
        }
      },
      {
        name: 'LIST',
        desc: 'LIST HOUSING UNITS AND OCCUPANTS.',
        example: 'HOUSE LIST',
        handler: function (api) {
          var doc = api.doc;
          if (doc.housing.length === 0) { api.out('NO HOUSING UNITS.'); return; }
          doc.housing.forEach(function (h) {
            var occ = h.occupantId ? doc.citizens.filter(function (c) { return c.id === h.occupantId; })[0] : null;
            api.out(rpad(h.id, 9) + rpad(h.unit.slice(0, 24), 25) + rpad('TIER ' + h.tier, 9) +
              rpad(h.mode, 7) + lpad(fmtHp(h.amount), 7) + ' HP  ' + (occ ? occ.ign : 'VACANT'));
          });
        }
      },
      {
        name: 'ASSIGN',
        desc: 'ASSIGN A UNIT. A PRICED (OWNED) UNIT DEBITS THE PRICE ONCE, CAT=RENT.',
        args: [{ name: 'ign', req: true }, { name: 'id', req: true }],
        example: 'HOUSE ASSIGN philly_9859 HSE-0001',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var h = findById(doc, 'housing', api.args.id, 'HOUSING UNIT');
          if (h.occupantId) throw errObj('0009', h.id + ' IS OCCUPIED.');
          if (c.housingId) throw errObj('0009', c.ign + ' ALREADY HOLDS ' + c.housingId + '. RELEASE IT FIRST.');
          if (h.mode === 'OWNED') {
            var bal = balance(doc, c.id);
            api.confirm('ASSIGN ' + h.id + ' ' + h.unit + ' TO ' + c.ign + ': DEBIT PRICE ' +
              fmtHp(h.amount) + ' HP ONCE (' + fmtHp(bal) + ' -> ' + fmtHp(bal - h.amount) + ').');
            var l = postLedger(doc, api.ctx, {
              citizenId: c.id, delta: -h.amount, category: 'RENT',
              reason: 'Housing purchase: ' + h.unit, ref: h.id
            });
            api.out(fmtLedgerLine(doc, l));
            if (l.balanceAfter < 0) api.out('WARNING: BALANCE NEGATIVE (' + fmtHp(l.balanceAfter) + ' HP).');
          }
          h.occupantId = c.id;
          c.housingId = h.id;
          api.out(h.id + ' ' + h.unit + ' ASSIGNED TO ' + c.ign +
            (h.mode === 'RENT' ? '. RENT ' + fmtHp(h.amount) + ' HP/MONTH VIA BATCH RENT.' : '.'));
        }
      },
      {
        name: 'RELEASE',
        desc: 'VACATE A UNIT.',
        args: [{ name: 'id', req: true }],
        example: 'HOUSE RELEASE HSE-0001',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, h = findById(doc, 'housing', api.args.id, 'HOUSING UNIT');
          if (!h.occupantId) throw errObj('0009', h.id + ' IS ALREADY VACANT.');
          var c = doc.citizens.filter(function (x) { return x.id === h.occupantId; })[0];
          if (c) c.housingId = null;
          h.occupantId = null;
          api.out(h.id + ' ' + h.unit + ' RELEASED.');
        }
      }
    ]
  });

  registerModule({
    name: 'POS', aliases: ['POSITION', 'POSITIONS'], title: 'POSITIONS', desc: 'SALARIED POSITIONS',
    menu: true,
    actions: [
      {
        name: 'ADD',
        desc: 'CREATE A POSITION WITH A WEEKLY SALARY.',
        args: [{ name: 'title', req: true }, { name: 'weeklyHp', req: true }],
        example: 'POS ADD "Gate Captain" 75',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var p = {
            id: nextId(doc, 'POS'), title: api.args.title,
            weekly: parsePositive(api.args.weeklyHp, 'WEEKLY HP'), holderId: null
          };
          doc.positions.push(p);
          api.out(p.id + ' ADDED: ' + p.title + '  ' + fmtHp(p.weekly) + ' HP/WEEK.');
        }
      },
      {
        name: 'LIST',
        desc: 'LIST POSITIONS AND HOLDERS.',
        example: 'POS LIST',
        handler: function (api) {
          var doc = api.doc;
          if (doc.positions.length === 0) { api.out('NO POSITIONS.'); return; }
          doc.positions.forEach(function (p) {
            var holder = p.holderId ? doc.citizens.filter(function (c) { return c.id === p.holderId; })[0] : null;
            api.out(rpad(p.id, 9) + rpad(p.title.slice(0, 28), 29) + lpad(fmtHp(p.weekly), 7) +
              ' HP/WK  ' + (holder ? holder.ign : 'VACANT'));
          });
        }
      },
      {
        name: 'ASSIGN',
        desc: 'APPOINT A CITIZEN TO A POSITION.',
        args: [{ name: 'ign', req: true }, { name: 'id', req: true }],
        example: 'POS ASSIGN philly_9859 POS-0001',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var c = findCitizen(doc, api.args.ign);
          requireActiveIsh(c);
          var p = findById(doc, 'positions', api.args.id, 'POSITION');
          if (p.holderId) throw errObj('0009', p.id + ' IS HELD.');
          if (c.positionId) throw errObj('0009', c.ign + ' ALREADY HOLDS ' + c.positionId + '. VACATE IT FIRST.');
          p.holderId = c.id;
          c.positionId = p.id;
          api.out(p.id + ' ' + p.title + ' ASSIGNED TO ' + c.ign + '. PAID VIA BATCH SALARY.');
        }
      },
      {
        name: 'VACATE',
        desc: 'VACATE A POSITION.',
        args: [{ name: 'id', req: true }],
        example: 'POS VACATE POS-0001',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, p = findById(doc, 'positions', api.args.id, 'POSITION');
          if (!p.holderId) throw errObj('0009', p.id + ' IS ALREADY VACANT.');
          var c = doc.citizens.filter(function (x) { return x.id === p.holderId; })[0];
          if (c) c.positionId = null;
          p.holderId = null;
          api.out(p.id + ' ' + p.title + ' VACATED.');
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * BATCH JOBS AND NOTICES (BATCH, NOTICE)
   * ------------------------------------------------------------------ */

  function monthKey(ctx) { return todayLocal(ctx).slice(0, 7); }

  function isoWeekKey(ctx) {
    var p = localDateParts(ctx.now);
    var d = new Date(p.date + 'T00:00:00');
    // ISO 8601: week 1 contains the first Thursday of the year
    var target = new Date(d.getTime());
    target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
    var week1 = new Date(target.getFullYear(), 0, 4);
    var week = 1 + Math.round(((target - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
    return target.getFullYear() + '-W' + pad(week, 2);
  }

  function checkPeriod(doc, key, last, label, force) {
    if (doc[last] === key && !force) {
      throw errObj('0014', label + ' ALREADY RAN FOR ' + key + '. USE --FORCE TO RUN AGAIN.');
    }
  }

  function batchReport(api, name, lines) {
    pushSyslog(api.doc, api.ctx, 'BATCH ' + name + ' RUN: ' + lines[lines.length - 1]);
    api.spool(makeReport(api.doc, api.ctx, 'BATCH ' + name, lines));
  }

  registerModule({
    name: 'BATCH', aliases: [], title: 'BATCH', desc: 'MONTHLY TAX, RENT, WEEKLY SALARY, AFK EXPIRY',
    menu: true,
    actions: [
      {
        name: 'TAX',
        desc: 'MONTHLY TAX FROM EVERY ACTIVE CITIZEN. AFK AND DEPARTED SKIP. NOTICES FOR NEGATIVES.',
        flags: [
          { name: 'dry-run', boolean: true, help: 'PREVIEW ONLY' },
          { name: 'force', boolean: true, help: 'RUN AGAIN IN THE SAME MONTH' }
        ],
        example: 'BATCH TAX --dry-run',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, s = doc.settings;
          var period = monthKey(api.ctx);
          checkPeriod(doc, period, 'lastTaxRun', 'BATCH TAX', api.flags.force);
          var charged = [], skipped = [];
          doc.citizens.forEach(function (c) {
            if (c.status === 'ACTIVE') charged.push(c);
            else skipped.push(c);
          });
          api.out('BATCH TAX ' + period + ': ' + fmtHp(s.taxMonthlyHp) + ' HP PER ACTIVE CITIZEN.');
          api.out(rpad('IGN', 18) + lpad('BAL', 9) + lpad('AFTER', 9) + '  NOTE');
          var notices = 0;
          charged.forEach(function (c) {
            var bal = balance(doc, c.id);
            var after = bal - s.taxMonthlyHp;
            api.out(rpad(c.ign, 18) + lpad(fmtHp(bal), 9) + lpad(fmtHp(after), 9) +
              (after < 0 ? '  NOTICE' : ''));
            if (after < 0) notices++;
          });
          skipped.forEach(function (c) {
            api.out(rpad(c.ign, 18) + rpad('', 18) + '  SKIPPED: ' + c.status +
              (c.status === 'AFK' ? ' UNTIL ' + c.afkUntil : ''));
          });
          var total = charged.length * s.taxMonthlyHp;
          api.out('CHARGE ' + charged.length + ', SKIP ' + skipped.length + ', NOTICES ' + notices +
            ', COLLECT ' + fmtHp(total) + ' HP.');
          if (api.flags['dry-run']) { api.out('DRY RUN. NOTHING POSTED.'); return; }
          if (charged.length === 0) { api.out('NO ACTIVE CITIZENS. NOTHING TO DO.'); return; }
          api.confirm('BATCH TAX ' + period + ': DEBIT ' + fmtHp(s.taxMonthlyHp) + ' HP FROM ' +
            charged.length + ' CITIZENS (' + fmtHp(total) + ' HP TOTAL).');
          var report = ['BATCH TAX ' + period + '  RATE ' + fmtHp(s.taxMonthlyHp) + ' HP', ''];
          var issued = 0;
          charged.forEach(function (c) {
            var l = postLedger(doc, api.ctx, {
              citizenId: c.id, delta: -s.taxMonthlyHp, category: 'TAX',
              reason: 'Monthly tax ' + period
            });
            var line = rpad(c.ign, 20) + lpad(fmtHp(-s.taxMonthlyHp), 9) + lpad(fmtHp(l.balanceAfter), 10);
            if (l.balanceAfter < 0) {
              var existing = doc.notices.filter(function (n) {
                return n.citizenId === c.id && n.status === 'OPEN';
              })[0];
              if (existing) {
                line += '  OPEN NOTICE ' + existing.id + ' STANDS';
              } else {
                var n = {
                  id: nextId(doc, 'NOT'), citizenId: c.id, issuedAt: ts(api.ctx),
                  dueAt: addDays(todayLocal(api.ctx), s.taxNoticeDays),
                  amountOwed: -l.balanceAfter, status: 'OPEN',
                  resolvedAt: null, resolvedBy: null, note: 'Tax ' + period + ' left balance negative'
                };
                doc.notices.push(n);
                issued++;
                line += '  NOTICE ' + n.id + ' DUE ' + n.dueAt;
              }
            }
            report.push(line);
          });
          skipped.forEach(function (c) {
            report.push(rpad(c.ign, 20) + '  SKIPPED: ' + c.status +
              (c.status === 'AFK' ? ' UNTIL ' + c.afkUntil : ''));
          });
          doc.lastTaxRun = period;
          report.push('');
          report.push('CHARGED ' + charged.length + '  SKIPPED ' + skipped.length +
            '  NOTICES ISSUED ' + issued + '  HP COLLECTED ' + fmtHp(total));
          batchReport(api, 'TAX', report);
          api.out('TAX POSTED. ' + issued + ' NOTICE' + (issued === 1 ? '' : 'S') +
            ' ISSUED. REPORT SPOOLED.');
        }
      },
      {
        name: 'RENT',
        desc: 'MONTHLY RENT FOR OCCUPIED RENT HOUSING.',
        flags: [
          { name: 'dry-run', boolean: true, help: 'PREVIEW ONLY' },
          { name: 'force', boolean: true, help: 'RUN AGAIN IN THE SAME MONTH' }
        ],
        example: 'BATCH RENT',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var period = monthKey(api.ctx);
          checkPeriod(doc, period, 'lastRentRun', 'BATCH RENT', api.flags.force);
          var due = doc.housing.filter(function (h) { return h.mode === 'RENT' && h.occupantId; });
          api.out('BATCH RENT ' + period + ':');
          var total = 0;
          due.forEach(function (h) {
            var c = findCitizen(doc, h.occupantId);
            total += h.amount;
            api.out(rpad(h.id, 9) + rpad(h.unit.slice(0, 22), 23) + rpad(c.ign, 18) +
              lpad(fmtHp(h.amount), 7) + ' HP');
          });
          api.out(due.length + ' UNIT' + (due.length === 1 ? '' : 'S') + ', ' + fmtHp(total) + ' HP.');
          if (api.flags['dry-run']) { api.out('DRY RUN. NOTHING POSTED.'); return; }
          if (due.length === 0) { api.out('NO OCCUPIED RENT UNITS. NOTHING TO DO.'); return; }
          api.confirm('BATCH RENT ' + period + ': DEBIT ' + fmtHp(total) + ' HP ACROSS ' + due.length + ' UNITS.');
          var report = ['BATCH RENT ' + period, ''];
          due.forEach(function (h) {
            var c = findCitizen(doc, h.occupantId);
            var l = postLedger(doc, api.ctx, {
              citizenId: c.id, delta: -h.amount, category: 'RENT',
              reason: 'Rent ' + period + ': ' + h.unit, ref: h.id
            });
            report.push(rpad(h.unit.slice(0, 24), 25) + rpad(c.ign, 20) + lpad(fmtHp(-h.amount), 8) +
              lpad(fmtHp(l.balanceAfter), 10) + (l.balanceAfter < 0 ? '  NEGATIVE' : ''));
          });
          doc.lastRentRun = period;
          report.push('');
          report.push('UNITS ' + due.length + '  HP COLLECTED ' + fmtHp(total));
          batchReport(api, 'RENT', report);
          api.out('RENT POSTED. REPORT SPOOLED.');
        }
      },
      {
        name: 'SALARY',
        desc: 'WEEKLY PAY FOR FILLED POSITIONS. ONE RUN PER ISO WEEK.',
        flags: [
          { name: 'dry-run', boolean: true, help: 'PREVIEW ONLY' },
          { name: 'force', boolean: true, help: 'RUN AGAIN IN THE SAME WEEK' }
        ],
        example: 'BATCH SALARY',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var period = isoWeekKey(api.ctx);
          checkPeriod(doc, period, 'lastSalaryRun', 'BATCH SALARY', api.flags.force);
          var due = doc.positions.filter(function (p) { return p.holderId; });
          api.out('BATCH SALARY ' + period + ':');
          var total = 0;
          due.forEach(function (p) {
            var c = findCitizen(doc, p.holderId);
            total += p.weekly;
            api.out(rpad(p.id, 9) + rpad(p.title.slice(0, 26), 27) + rpad(c.ign, 18) +
              lpad(fmtHp(p.weekly), 7) + ' HP');
          });
          api.out(due.length + ' POSITION' + (due.length === 1 ? '' : 'S') + ', ' + fmtHp(total) + ' HP.');
          if (api.flags['dry-run']) { api.out('DRY RUN. NOTHING POSTED.'); return; }
          if (due.length === 0) { api.out('NO FILLED POSITIONS. NOTHING TO DO.'); return; }
          api.confirm('BATCH SALARY ' + period + ': CREDIT ' + fmtHp(total) + ' HP ACROSS ' +
            due.length + ' POSITIONS.');
          var report = ['BATCH SALARY ' + period, ''];
          due.forEach(function (p) {
            var c = findCitizen(doc, p.holderId);
            var l = postLedger(doc, api.ctx, {
              citizenId: c.id, delta: p.weekly, category: 'SALARY',
              reason: 'Salary ' + period + ': ' + p.title, ref: p.id
            });
            report.push(rpad(p.title.slice(0, 26), 27) + rpad(c.ign, 20) + lpad('+' + fmtHp(p.weekly), 8) +
              lpad(fmtHp(l.balanceAfter), 10));
          });
          doc.lastSalaryRun = period;
          report.push('');
          report.push('POSITIONS ' + due.length + '  HP PAID ' + fmtHp(total));
          batchReport(api, 'SALARY', report);
          api.out('SALARY POSTED. REPORT SPOOLED.');
        }
      },
      {
        name: 'AFK',
        desc: 'EXPIRE AFK PERIODS PAST THEIR DATE, START COOLDOWNS. SAFE ANY TIME.',
        example: 'BATCH AFK',
        mutates: true,
        handler: function (api) {
          var doc = api.doc;
          var today = todayLocal(api.ctx);
          var due = doc.citizens.filter(function (c) {
            return c.status === 'AFK' && c.afkUntil && c.afkUntil <= today;
          });
          if (due.length === 0) { api.out('NO AFK PERIODS TO EXPIRE.'); return; }
          due.forEach(function (c) {
            api.out(rpad(c.ign, 18) + 'AFK ' + c.afkFrom + ' TO ' + c.afkUntil);
          });
          api.confirm('BATCH AFK: RETURN ' + due.length + ' CITIZEN' + (due.length === 1 ? '' : 'S') +
            ' TO ACTIVE AND START COOLDOWNS.');
          var report = ['BATCH AFK ' + today, ''];
          due.forEach(function (c) {
            var taken = Math.max(1, Math.round(daysBetween(c.afkFrom + 'T00:00:00', c.afkUntil + 'T00:00:00')));
            c.status = 'ACTIVE';
            c.cooldownUntil = addDays(c.afkUntil, taken);
            report.push(rpad(c.ign, 20) + 'RETURNED. COOLDOWN UNTIL ' + c.cooldownUntil);
            api.out(c.ign + ' RETURNED TO ACTIVE. COOLDOWN ENDS ' + c.cooldownUntil + '.');
            c.afkFrom = null;
            c.afkUntil = null;
          });
          report.push('');
          report.push('RETURNED ' + due.length);
          batchReport(api, 'AFK', report);
        }
      }
    ]
  });

  registerModule({
    name: 'NOTICE', aliases: ['NOTICES'], title: 'NOTICES', desc: 'DELINQUENCY NOTICES AND ENFORCEMENT',
    menu: true,
    actions: [
      {
        name: 'LIST',
        desc: 'LIST NOTICES. --OPEN SHOWS OPEN ONLY.',
        flags: [{ name: 'open', boolean: true, help: 'OPEN NOTICES ONLY' }],
        example: 'NOTICE LIST --open',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.notices.slice();
          if (api.flags.open) rows = rows.filter(function (n) { return n.status === 'OPEN'; });
          if (rows.length === 0) { api.out('NO NOTICES' + (api.flags.open ? ' OPEN' : '') + '.'); return; }
          rows.forEach(function (n) {
            var c = doc.citizens.filter(function (x) { return x.id === n.citizenId; })[0];
            api.out(rpad(n.id, 9) + rpad(c ? c.ign : n.citizenId, 18) + rpad(n.status, 10) +
              'OWED ' + lpad(fmtHp(n.amountOwed), 7) + ' HP  DUE ' + n.dueAt);
          });
        }
      },
      {
        name: 'SHOW',
        desc: 'FULL NOTICE DETAIL.',
        args: [{ name: 'id', req: true }],
        example: 'NOTICE SHOW NOT-0001',
        handler: function (api) {
          var doc = api.doc, n = findById(doc, 'notices', api.args.id, 'NOTICE');
          var c = doc.citizens.filter(function (x) { return x.id === n.citizenId; })[0];
          api.out(n.id + '  ' + (c ? c.ign : n.citizenId) + '  ' + n.status);
          api.out('ISSUED ' + fmtLocal(n.issuedAt) + '  DUE ' + n.dueAt + '  OWED ' + fmtHp(n.amountOwed) + ' HP');
          if (c) api.out('CURRENT BALANCE ' + fmtHp(balance(doc, c.id)) + ' HP  RANK ' + c.rank);
          if (n.note) api.out('NOTE: ' + n.note);
          if (n.resolvedAt) api.out(n.status + ' ' + fmtLocal(n.resolvedAt) + ' BY ' + (n.resolvedBy || '-'));
        }
      },
      {
        name: 'RESOLVE',
        desc: 'CLOSE A NOTICE: BALANCE RECOVERED OR OPERATOR DISCRETION.',
        args: [{ name: 'id', req: true }, { name: 'note', req: false }],
        example: 'NOTICE RESOLVE NOT-0001 "Paid via job JOB-0009"',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, n = findById(doc, 'notices', api.args.id, 'NOTICE');
          if (n.status !== 'OPEN') throw errObj('0009', n.id + ' IS ' + n.status + ', NOT OPEN.');
          n.status = 'RESOLVED';
          n.resolvedAt = ts(api.ctx);
          n.resolvedBy = api.ctx.operator;
          if (api.args.note) n.note = api.args.note;
          api.out(n.id + ' RESOLVED.');
        }
      },
      {
        name: 'ENFORCE',
        desc: 'AFTER THE DUE DATE: DEMOTE ONE RANK, OR FLAG EXPEL FOR VERD\'IKA. NEVER AUTOMATIC.',
        args: [{ name: 'id', req: true }],
        example: 'NOTICE ENFORCE NOT-0001',
        mutates: true,
        handler: function (api) {
          var doc = api.doc, n = findById(doc, 'notices', api.args.id, 'NOTICE');
          if (n.status !== 'OPEN') throw errObj('0009', n.id + ' IS ' + n.status + ', NOT OPEN.');
          var today = todayLocal(api.ctx);
          if (today < n.dueAt) throw errObj('0009', n.id + ' IS NOT DUE UNTIL ' + n.dueAt + '.');
          var c = findCitizen(doc, n.citizenId);
          var idx = rankIndex(doc, c.rank);
          if (idx <= 0) {
            api.confirm('ENFORCE ' + n.id + ': ' + c.ign + ' IS ' + c.rank + '. FLAG EXPEL.');
            n.status = 'ENFORCED';
            n.resolvedAt = ts(api.ctx);
            n.resolvedBy = api.ctx.operator;
            n.note = 'EXPEL FLAGGED';
            pushSyslog(doc, api.ctx, 'NOTICE ENFORCE ' + n.id + ' ' + c.ign + ': EXPEL FLAGGED');
            api.out('EXPEL FLAGGED FOR ' + c.ign + '. EXPULSION ITSELF IS CIT DEPART ' + c.ign + ', RUN BY THE OPERATOR.');
          } else {
            var to = doc.settings.ranks[idx - 1].name;
            api.confirm('ENFORCE ' + n.id + ': DEMOTE ' + c.ign + ' ' + c.rank + ' -> ' + to + '. NO HP MOVEMENT.');
            var was = c.rank;
            c.rank = to;
            n.status = 'ENFORCED';
            n.resolvedAt = ts(api.ctx);
            n.resolvedBy = api.ctx.operator;
            n.note = 'DEMOTED ' + was + ' -> ' + to;
            pushSyslog(doc, api.ctx, 'NOTICE ENFORCE ' + n.id + ' ' + c.ign + ': DEMOTED ' + was + ' -> ' + to);
            api.out(c.ign + ' DEMOTED TO ' + to + '. (WAS ' + was + '.)');
          }
        }
      }
    ]
  });

  /* ------------------------------------------------------------------ *
   * REPORTS AND LINE PRINTER (PRINT, REPORTS)
   * ------------------------------------------------------------------ */

  function citizenById(doc, id) {
    return doc.citizens.filter(function (c) { return c.id === id; })[0] || null;
  }

  function ignOf(doc, id) {
    var c = citizenById(doc, id);
    return c ? c.ign : (id || '-');
  }

  function rosterRow(doc, c) {
    return rpad(c.id, 10) + rpad(c.ign, 20) + rpad(c.rank, 13) + rpad(c.clan || '-', 14) +
      rpad(c.status, 10) + lpad(fmtHp(balance(doc, c.id)), 9) + '  ' + rpad(c.joinedAt, 12) +
      rpad(c.discord || '-', 20);
  }

  var ROSTER_HEAD = rpad('ID', 10) + rpad('IGN', 20) + rpad('RANK', 13) + rpad('CLAN', 14) +
    rpad('STATUS', 10) + lpad('BAL HP', 9) + '  ' + rpad('JOINED', 12) + rpad('DISCORD', 20);

  registerModule({
    name: 'PRINT', aliases: [], title: 'REPORTS', desc: 'LINE PRINTER REPORTS (RENDER TO THE SPOOL PANE)',
    menu: true,
    actions: [
      {
        name: 'ROSTER',
        desc: 'FULL CITIZEN ROSTER. --BY RANK OR --BY CLAN GROUPS IT.',
        flags: [{ name: 'by', help: 'RANK | CLAN' }],
        example: 'PRINT ROSTER --by rank',
        handler: function (api) {
          var doc = api.doc;
          var body = [];
          var rows = doc.citizens.slice().sort(function (a, b) {
            return a.ign.toUpperCase() < b.ign.toUpperCase() ? -1 : 1;
          });
          if (api.flags.by) {
            var by = resolveListed(api.flags.by, ['RANK', 'CLAN'], 'GROUPING');
            var groups = {};
            var order = [];
            rows.forEach(function (c) {
              var k = by === 'RANK' ? c.rank : (c.clan || 'NO CLAN');
              if (!groups[k]) { groups[k] = []; order.push(k); }
              groups[k].push(c);
            });
            if (by === 'RANK') {
              order = doc.settings.ranks.map(function (r) { return r.name; }).reverse()
                .filter(function (k) { return groups[k]; });
              Object.keys(groups).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
            } else order.sort();
            order.forEach(function (k) {
              body.push('--- ' + k + ' (' + groups[k].length + ') ---');
              body.push(ROSTER_HEAD);
              groups[k].forEach(function (c) { body.push(rosterRow(doc, c)); });
              body.push('');
            });
          } else {
            body.push(ROSTER_HEAD);
            rows.forEach(function (c) { body.push(rosterRow(doc, c)); });
          }
          body.push('');
          body.push('TOTAL CITIZENS ' + rows.length);
          api.spool(makeReport(doc, api.ctx, 'ROSTER', body));
          api.out('ROSTER SPOOLED. ' + rows.length + ' CITIZENS.');
        }
      },
      {
        name: 'BALANCES',
        desc: 'EVERY BALANCE, HIGHEST FIRST, WITH THE TOTAL IN CIRCULATION.',
        example: 'PRINT BALANCES',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.citizens.map(function (c) { return { c: c, bal: balance(doc, c.id) }; });
          rows.sort(function (a, b) { return b.bal - a.bal; });
          var body = [rpad('ID', 10) + rpad('IGN', 20) + rpad('RANK', 13) + rpad('STATUS', 10) + lpad('BAL HP', 10)];
          var total = 0;
          rows.forEach(function (r) {
            total += r.bal;
            body.push(rpad(r.c.id, 10) + rpad(r.c.ign, 20) + rpad(r.c.rank, 13) + rpad(r.c.status, 10) +
              lpad(fmtHp(r.bal), 10));
          });
          body.push('');
          body.push(rpad('TOTAL IN CIRCULATION', 53) + lpad(fmtHp(total), 10));
          api.spool(makeReport(doc, api.ctx, 'BALANCES', body));
          api.out('BALANCES SPOOLED. ' + rows.length + ' CITIZENS, ' + fmtHp(total) + ' HP IN CIRCULATION.');
        }
      },
      {
        name: 'DELINQUENT',
        desc: 'NEGATIVE BALANCES, OPEN NOTICES, DAYS UNTIL ENFORCEMENT.',
        example: 'PRINT DELINQUENT',
        handler: function (api) {
          var doc = api.doc;
          var today = todayLocal(api.ctx);
          var body = ['NEGATIVE BALANCES', rpad('IGN', 20) + rpad('RANK', 13) + lpad('BAL HP', 10)];
          var neg = doc.citizens.map(function (c) { return { c: c, bal: balance(doc, c.id) }; })
            .filter(function (r) { return r.bal < 0; })
            .sort(function (a, b) { return a.bal - b.bal; });
          if (neg.length === 0) body.push('NONE');
          neg.forEach(function (r) {
            body.push(rpad(r.c.ign, 20) + rpad(r.c.rank, 13) + lpad(fmtHp(r.bal), 10));
          });
          body.push('');
          body.push('OPEN NOTICES');
          body.push(rpad('ID', 10) + rpad('IGN', 20) + lpad('OWED HP', 9) + '  ' + rpad('DUE', 12) + 'DAYS TO ENFORCEMENT');
          var open = doc.notices.filter(function (n) { return n.status === 'OPEN'; });
          if (open.length === 0) body.push('NONE');
          open.forEach(function (n) {
            var days = Math.ceil(daysBetween(today + 'T00:00:00', n.dueAt + 'T00:00:00'));
            body.push(rpad(n.id, 10) + rpad(ignOf(doc, n.citizenId), 20) + lpad(fmtHp(n.amountOwed), 9) +
              '  ' + rpad(n.dueAt, 12) + (days > 0 ? String(days) : 'ENFORCEABLE NOW'));
          });
          api.spool(makeReport(doc, api.ctx, 'DELINQUENT', body));
          api.out('DELINQUENT SPOOLED. ' + neg.length + ' NEGATIVE, ' + open.length + ' OPEN NOTICES.');
        }
      },
      {
        name: 'JOBS',
        desc: 'JOBS BOARD. DEFAULT OPEN+CLAIMED+SUBMITTED; --STATUS FILTERS.',
        flags: [{ name: 'status', help: 'FILTER BY STATUS' }],
        example: 'PRINT JOBS --status OPEN',
        handler: function (api) {
          var doc = api.doc;
          var rows = doc.jobs.slice();
          if (api.flags.status) {
            var st = resolveListed(api.flags.status, JOB_STATUSES, 'STATUS');
            rows = rows.filter(function (j) { return j.status === st; });
          } else {
            rows = rows.filter(function (j) {
              return j.status === 'OPEN' || j.status === 'CLAIMED' || j.status === 'SUBMITTED';
            });
          }
          var body = [rpad('ID', 10) + rpad('STATUS', 11) + rpad('CATEGORY', 13) + lpad('REWARD', 8) +
            '  ' + rpad('TITLE', 30) + rpad('COORDS', 18) + rpad('DEADLINE', 12) + 'CLAIMED BY'];
          rows.forEach(function (j) {
            body.push(rpad(j.id, 10) + rpad(j.status, 11) + rpad(j.category, 13) + lpad(fmtHp(j.reward), 8) +
              '  ' + rpad(j.title.slice(0, 28), 30) + rpad(j.coords || '-', 18) +
              rpad(j.deadline || '-', 12) + (j.claimedBy ? ignOf(doc, j.claimedBy) : '-'));
            if (j.description) body.push('          ' + j.description.slice(0, PAGE_WIDTH - 10));
          });
          body.push('');
          body.push('TOTAL ' + rows.length);
          api.spool(makeReport(doc, api.ctx, 'JOBS', body));
          api.out('JOBS SPOOLED. ' + rows.length + ' JOBS.');
        }
      },
      {
        name: 'VAULT',
        desc: 'FULL VAULT INVENTORY.',
        example: 'PRINT VAULT',
        handler: function (api) {
          var doc = api.doc;
          var body = [rpad('ID', 10) + rpad('CATEGORY', 12) + lpad('QTY', 4) + lpad('PRICE HP', 12) + '  NAME'];
          doc.vault.forEach(function (v) {
            body.push(rpad(v.id, 10) + rpad(v.category, 12) + lpad(v.qty, 4) +
              lpad(v.price === null ? 'UNPRICED' : fmtHp(v.price), 12) + '  ' + v.name);
          });
          body.push('');
          body.push('TOTAL ITEMS ' + doc.vault.length);
          api.spool(makeReport(doc, api.ctx, 'VAULT', body));
          api.out('VAULT SPOOLED. ' + doc.vault.length + ' ITEMS.');
        }
      },
      {
        name: 'STATEMENT',
        desc: 'ONE CITIZEN, ONE MONTH: OPENING BALANCE, EVERY LINE, CLOSING BALANCE.',
        args: [{ name: 'ign', req: true }, { name: 'month', req: false }],
        example: 'PRINT STATEMENT philly_9859 2026-08',
        handler: function (api) {
          var doc = api.doc, c = findCitizen(doc, api.args.ign);
          var month = api.args.month || monthKey(api.ctx);
          if (!/^\d{4}-\d{2}$/.test(month)) throw errObj('0010', 'MONTH IS YYYY-MM.');
          var opening = 0, closing = 0;
          var lines = [];
          doc.ledger.forEach(function (l) {
            if (l.citizenId !== c.id) return;
            var m = l.ts.slice(0, 7);
            if (m < month) opening += l.delta;
            if (m <= month) closing += l.delta;
            if (m === month) lines.push(l);
          });
          var body = ['STATEMENT FOR ' + c.ign + ' (' + c.id + ')  RANK ' + c.rank + '  MONTH ' + month, ''];
          body.push(rpad('OPENING BALANCE', 30) + lpad(fmtHp(opening), 10));
          body.push('');
          body.push(rpad('LINE', 12) + rpad('DATE-TIME', 18) + lpad('DELTA', 8) + lpad('BALANCE', 9) +
            '  ' + rpad('CATEGORY', 10) + rpad('REF', 12) + rpad('BY', 12) + 'REASON');
          if (lines.length === 0) body.push('NO MOVEMENT.');
          lines.forEach(function (l) {
            body.push(rpad(l.id, 12) + rpad(l.ts, 18) + lpad((l.delta >= 0 ? '+' : '') + fmtHp(l.delta), 8) +
              lpad(fmtHp(l.balanceAfter), 9) + '  ' + rpad(l.category, 10) + rpad(l.ref || '-', 12) +
              rpad(l.operator || '-', 12) + l.reason);
          });
          body.push('');
          body.push(rpad('CLOSING BALANCE', 30) + lpad(fmtHp(closing), 10));
          api.spool(makeReport(doc, api.ctx, 'STATEMENT ' + c.ign + ' ' + month, body));
          api.out('STATEMENT SPOOLED: ' + c.ign + ' ' + month + '. ' + lines.length + ' LINES.');
        }
      },
      {
        name: 'TREASURY',
        desc: 'HP ISSUED AND BURNED BY CATEGORY FOR A MONTH, NET, AND CASH BOUGHT.',
        args: [{ name: 'month', req: false }],
        example: 'PRINT TREASURY 2026-08',
        handler: function (api) {
          var doc = api.doc;
          var month = api.args.month || monthKey(api.ctx);
          if (!/^\d{4}-\d{2}$/.test(month)) throw errObj('0010', 'MONTH IS YYYY-MM.');
          var issued = {}, burned = {};
          var totIssued = 0, totBurned = 0, circulation = 0, cashHp = 0, cashSw = 0;
          doc.ledger.forEach(function (l) {
            var m = l.ts.slice(0, 7);
            if (m <= month) circulation += l.delta;
            if (m !== month) return;
            if (l.delta >= 0) { issued[l.category] = (issued[l.category] || 0) + l.delta; totIssued += l.delta; }
            else { burned[l.category] = (burned[l.category] || 0) - l.delta; totBurned -= l.delta; }
            if (l.category === 'CASHBUY' && l.delta > 0) {
              cashHp += l.delta;
              var m2 = String(l.reason).match(/Cash buy (\d+) SW/);
              cashSw += m2 ? parseInt(m2[1], 10) : l.delta * doc.settings.cashPerHp;
            }
          });
          var body = ['TREASURY ' + month, ''];
          body.push(rpad('CATEGORY', 12) + lpad('ISSUED HP', 12) + lpad('BURNED HP', 12) + lpad('NET HP', 12));
          CATEGORIES.forEach(function (cat) {
            var i = issued[cat] || 0, b = burned[cat] || 0;
            if (i === 0 && b === 0) return;
            body.push(rpad(cat, 12) + lpad(fmtHp(i), 12) + lpad(fmtHp(b), 12) + lpad(fmtHp(i - b), 12));
          });
          body.push(rpad('TOTAL', 12) + lpad(fmtHp(totIssued), 12) + lpad(fmtHp(totBurned), 12) +
            lpad(fmtHp(totIssued - totBurned), 12));
          body.push('');
          body.push(rpad('CASH BOUGHT THIS MONTH', 30) + lpad(fmtHp(cashHp), 10) + ' HP FOR ' +
            fmtHp(cashSw) + ' SW');
          body.push(rpad('HP IN CIRCULATION AT MONTH END', 34) + lpad(fmtHp(circulation), 10));
          api.spool(makeReport(doc, api.ctx, 'TREASURY ' + month, body));
          api.out('TREASURY SPOOLED: ' + month + '. NET ' + fmtHp(totIssued - totBurned) + ' HP.');
        }
      },
      {
        name: 'AFK',
        desc: 'WHO IS AWAY AND UNTIL WHEN; WHO IS IN COOLDOWN.',
        example: 'PRINT AFK',
        handler: function (api) {
          var doc = api.doc;
          var today = todayLocal(api.ctx);
          var body = ['AWAY', rpad('IGN', 20) + rpad('FROM', 12) + rpad('UNTIL', 12) + 'NOTE'];
          var away = doc.citizens.filter(function (c) { return c.status === 'AFK'; });
          if (away.length === 0) body.push('NONE');
          away.forEach(function (c) {
            body.push(rpad(c.ign, 20) + rpad(c.afkFrom || '-', 12) + rpad(c.afkUntil || '-', 12) +
              (c.afkUntil && c.afkUntil <= today ? 'EXPIRED. RUN BATCH AFK.' : ''));
          });
          body.push('');
          body.push('IN COOLDOWN');
          body.push(rpad('IGN', 20) + 'UNTIL');
          var cooling = doc.citizens.filter(function (c) {
            return c.status !== 'AFK' && c.cooldownUntil && c.cooldownUntil > today;
          });
          if (cooling.length === 0) body.push('NONE');
          cooling.forEach(function (c) { body.push(rpad(c.ign, 20) + c.cooldownUntil); });
          api.spool(makeReport(doc, api.ctx, 'AFK', body));
          api.out('AFK SPOOLED. ' + away.length + ' AWAY, ' + cooling.length + ' IN COOLDOWN.');
        }
      },
      {
        name: 'RECRUITS',
        desc: 'OPEN VERIFICATIONS AND WHICH STEPS ARE OUTSTANDING.',
        example: 'PRINT RECRUITS',
        handler: function (api) {
          var doc = api.doc;
          var open = doc.recruits.filter(function (r) { return !r.paidLedgerId; });
          var body = [rpad('ID', 10) + rpad('RECRUITER', 20) + rpad('RECRUIT', 20) +
            rpad('LOGGED', 18) + 'STEPS OUTSTANDING'];
          if (open.length === 0) body.push('NONE');
          open.forEach(function (r) {
            var missing = REC_STEPS.filter(function (s) { return !r.steps[s].done; });
            body.push(rpad(r.id, 10) + rpad(ignOf(doc, r.recruiterId), 20) + rpad(ignOf(doc, r.recruitId), 20) +
              rpad(r.loggedAt, 18) + (missing.length ? missing.join(' ') : 'NONE. READY FOR REC PAY.'));
          });
          api.spool(makeReport(doc, api.ctx, 'RECRUITS', body));
          api.out('RECRUITS SPOOLED. ' + open.length + ' OPEN.');
        }
      },
      {
        name: 'SYSLOG',
        desc: 'LAST N SYSTEM LOG LINES (DEFAULT 100).',
        args: [{ name: 'n', req: false }],
        example: 'PRINT SYSLOG 200',
        handler: function (api) {
          var doc = api.doc;
          var n = api.args.n ? parsePositive(api.args.n, 'COUNT') : 100;
          var rows = doc.syslog.slice(-n);
          var body = [rpad('TIME', 18) + rpad('OPERATOR', 14) + 'LINE'];
          rows.forEach(function (r) {
            body.push(rpad(r.ts, 18) + rpad(r.operator || '-', 14) + String(r.line).slice(0, PAGE_WIDTH - 32));
          });
          api.spool(makeReport(doc, api.ctx, 'SYSLOG', body));
          api.out('SYSLOG SPOOLED. ' + rows.length + ' LINES.');
        }
      }
    ]
  });

  topLevel('REPORTS', [], {
    desc: 'LIST THE LINE PRINTER REPORTS.',
    handler: function (api) {
      var mod = findModule('PRINT');
      api.out('REPORTS (PRINT <REPORT> [ARGS] RENDERS TO THE SPOOL PANE):');
      mod.actions.forEach(function (a) {
        api.out('  ' + rpad(a.name, 12) + a.desc);
      });
      api.out('SPOOL SHOWS OR HIDES THE PANE. SET GREENBAR ON|OFF STRIPES THE PAPER.');
    }
  });

  /* ------------------------------------------------------------------ *
   * Completion and menu support for the UI
   * ------------------------------------------------------------------ */

  function completions(doc, text) {
    var toks = text.split(/\s+/).filter(function (t) { return t.length > 0; });
    var endsSpace = /\s$/.test(text);
    var current = endsSpace ? '' : (toks[toks.length - 1] || '');
    var before = endsSpace ? toks : toks.slice(0, -1);
    var cands = [];
    if (before.length === 0) {
      MODULES.forEach(function (m) { cands.push(m.name); });
    } else if (before.length === 1) {
      var mod = null;
      try { mod = resolveName(before[0], MODULES, 'COMMAND'); } catch (e) { mod = null; }
      if (mod && !mod.topLevel) mod.actions.forEach(function (a) { cands.push(a.name); });
    }
    doc.citizens.forEach(function (c) { cands.push(c.ign); });
    var up = current.toUpperCase();
    var hits = cands.filter(function (c) { return c.toUpperCase().indexOf(up) === 0 && c.toUpperCase() !== up; });
    // de-duplicate, preserve order
    var seen = {}, uniq = [];
    hits.forEach(function (h) { if (!seen[h.toUpperCase()]) { seen[h.toUpperCase()] = true; uniq.push(h); } });
    return { current: current, matches: uniq };
  }

  /* Menu tree consumed by the UI. Fields map to positional args and flags of
     the given command; the UI prompts field by field and builds the line. */
  var SYSTEM_MENU = ['LOGON', 'LOGOFF', 'WHOAMI', 'THEME', 'BAUD', 'SET', 'SNAPSHOT', 'RESTORE',
    'EXPORT', 'IMPORT', 'SEED', 'SPOOL', 'SYSLOG', 'DATE', 'VERSION', 'SELFTEST'];

  function menuSpec(doc) {
    var menus = [];
    MODULES.forEach(function (m) {
      if (!m.menu) return;
      menus.push({
        name: m.name, title: m.title || m.name,
        actions: m.actions.map(function (a) {
          return {
            name: a.name,
            desc: a.desc || '',
            command: m.name + ' ' + a.name,
            fields: (a.menuFields || defaultMenuFields(a))
          };
        })
      });
    });
    menus.push({
      name: 'SYSTEM', title: 'SYSTEM',
      actions: SYSTEM_MENU.map(function (n) {
        var m = findModule(n);
        var a = m.actions[0];
        return {
          name: n, desc: a.desc || '', command: n,
          fields: a.menuFields || defaultMenuFields(a)
        };
      })
    });
    return menus;
  }

  function defaultMenuFields(a) {
    var fields = [];
    (a.args || []).forEach(function (arg) {
      fields.push({ label: arg.name.toUpperCase(), kind: 'arg', required: !!arg.req, variadic: !!arg.variadic, def: '' });
    });
    (a.flags || []).forEach(function (f) {
      if (f.name === 'yes') return;
      fields.push({ label: f.name.toUpperCase(), kind: 'flag', flag: f.name, boolean: !!f.boolean, required: false, def: '' });
    });
    return fields;
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    RELEASE: RELEASE,
    STORAGE_KEY: 'mandalor-mirsh-v1',
    newDocument: newDocument,
    defaultSettings: defaultSettings,
    migrate: migrate,
    execute: execute,
    tokenize: tokenize,
    escapeHtml: escapeHtml,
    balance: balance,
    findCitizen: findCitizen,
    resolveRank: resolveRank,
    rankIndex: rankIndex,
    parseDate: parseDate,
    parseAmount: parseAmount,
    fmtLedgerLine: fmtLedgerLine,
    fmtLocal: fmtLocal,
    validateImport: validateImport,
    mergeImport: mergeImport,
    seedDocument: seedDocument,
    docHasData: docHasData,
    completions: completions,
    menuSpec: menuSpec,
    settingsLines: settingsLines,
    ts: ts,
    _internals: {
      MODULES: MODULES,
      registerModule: registerModule,
      topLevel: topLevel,
      errObj: errObj,
      postLedger: postLedger,
      nextId: nextId,
      resolveName: resolveName,
      resolveCategory: resolveCategory,
      parsePositive: parsePositive,
      fmtHp: fmtHp,
      rpad: rpad,
      lpad: lpad,
      addDays: addDays,
      daysBetween: daysBetween,
      parseDateArg: parseDate,
      todayLocal: todayLocal,
      localDateParts: localDateParts,
      findById: findById,
      pushSyslog: pushSyslog,
      CATEGORIES: CATEGORIES
    }
  };
});
