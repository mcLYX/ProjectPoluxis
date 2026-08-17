import type { NoteData, NoteType } from '../types/game';
import { EASING_TYPES } from './easing';

/**
 * 编辑器“高级功能”：放置新音符时自动套用的规则（DSL 版）。
 *
 * 设计要点（按用户约定）：
 *  - 仅“编辑期静态重算”：规则只在“放置新音符”那一刻对新建音符求值，运行期/后续手动编辑完全不涉及。
 *  - 规则只作用于新放置的音符；放置后手动改色 / 改拍都不会再触发规则（用户后续随便改）。
 *  - 规则为“编辑器本地配置”，存于 localStorage，不写入谱面 JSON。
 *
 * DSL 语法（每行一条规则，从上往下依次执行）：
 *   <条件表达式> : <赋值1>, <赋值2>, ...
 * 可用音符属性：beat, x, y, type, color, angle, easing
 * 运算符（类 JS 优先级）： || && == != < > <= >= + - * / %  ! -()   以及字符串字面量 "..." '...'
 * 内置函数：abs sign floor ceil round sqrt fract near min max clamp random
 *           sin cos tan asin acos atan atan2 sinh cosh tanh（弧度）
 *           rad(deg) deg(rad)（角度<->弧度互转，谱面 angle 单位为度）
 * 内置常量：PI(π) TAU(2π) E
 * 例：
 *   beat % 0.5 == 0 : color = "#ff0000"
 *   x < 0 && y < 0 : angle = -(x + y) * 23, easing = "sine-out"
 *   beat % 1 == 0 : x = sin(beat * PI) * 2.0, y = cos(beat * PI) * 1.5
 *
 * 解释器为纯函数、不触碰 React / Three，也不使用 eval（安全）。
 */

const NUMERIC_PROPS = ['beat', 'x', 'y', 'angle'] as const;
const STRING_PROPS = ['type', 'color', 'easing'] as const;
const ALL_PROPS = [...NUMERIC_PROPS, ...STRING_PROPS] as const;

const STORAGE_KEY = 'poluxis-editor-dsl';

export interface DslLineError {
  /** 1-based 行号 */
  line: number;
  message: string;
}

class DslError extends Error {}

// ---------------------------------------------------------------------------
// 词法分析
// ---------------------------------------------------------------------------

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'id'; value: string }
  | { type: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // 字符串字面量
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let s = '';
      while (i < n && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < n) {
          const nx = src[i + 1];
          s += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          i += 2;
        } else {
          s += src[i];
          i++;
        }
      }
      if (i >= n) throw new DslError('字符串未闭合');
      i++; // 跳过结束引号
      tokens.push({ type: 'str', value: s });
      continue;
    }
    // 数字
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let num = '';
      while (i < n && /[0-9.]/.test(src[i])) {
        num += src[i];
        i++;
      }
      tokens.push({ type: 'num', value: Number(num) });
      continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) {
        id += src[i];
        i++;
      }
      if (id === 'true' || id === 'false') tokens.push({ type: 'bool', value: id === 'true' });
      else tokens.push({ type: 'id', value: id });
      continue;
    }
    // 多字符运算符
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('+-*/%<>!(),='.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    throw new DslError(`无法识别的字符 "${c}"`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 语法分析（递归下降，类 JS 优先级）
// ---------------------------------------------------------------------------

type DslNode =
  | { op: 'num'; value: number }
  | { op: 'str'; value: string }
  | { op: 'bool'; value: boolean }
  | { op: 'id'; value: string }
  | { op: 'call'; name: string; args: DslNode[] }
  | { op: 'neg' | 'not'; arg: DslNode }
  | {
      op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||';
      left: DslNode;
      right: DslNode;
    };

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  expect(v: string): void {
    const t = this.next();
    if (!t || t.value !== v) throw new DslError(`语法错误：期望 "${v}"`);
  }

  parseAll(): DslNode {
    if (this.tokens.length === 0) throw new DslError('表达式为空');
    const node = this.parseOr();
    if (this.peek()) throw new DslError('表达式语法错误');
    return node;
  }
  private parseOr(): DslNode {
    let left = this.parseAnd();
    while (this.peek()?.value === '||') {
      this.next();
      left = { op: '||', left, right: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): DslNode {
    let left = this.parseEq();
    while (this.peek()?.value === '&&') {
      this.next();
      left = { op: '&&', left, right: this.parseEq() };
    }
    return left;
  }
  private parseEq(): DslNode {
    let left = this.parseCmp();
    while (this.peek()?.value === '==' || this.peek()?.value === '!=') {
      const op = this.next()!.value as '==' | '!=';
      left = { op, left, right: this.parseCmp() };
    }
    return left;
  }
  private parseCmp(): DslNode {
    let left = this.parseAdd();
    while (['<', '>', '<=', '>='].includes(String(this.peek()?.value ?? ''))) {
      const op = this.next()!.value as '<' | '>' | '<=' | '>=';
      left = { op, left, right: this.parseAdd() };
    }
    return left;
  }
  private parseAdd(): DslNode {
    let left = this.parseMul();
    while (this.peek()?.value === '+' || this.peek()?.value === '-') {
      const op = this.next()!.value as '+' | '-';
      left = { op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): DslNode {
    let left = this.parseUnary();
    while (['*', '/', '%'].includes(String(this.peek()?.value ?? ''))) {
      const op = this.next()!.value as '*' | '/' | '%';
      left = { op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): DslNode {
    const v = this.peek()?.value;
    if (v === '-') {
      this.next();
      return { op: 'neg', arg: this.parseUnary() };
    }
    if (v === '!') {
      this.next();
      return { op: 'not', arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): DslNode {
    const t = this.peek();
    if (!t) throw new DslError('表达式不完整');
    if (t.type === 'num') {
      this.next();
      return { op: 'num', value: t.value as number };
    }
    if (t.type === 'str') {
      this.next();
      return { op: 'str', value: t.value as string };
    }
    if (t.type === 'bool') {
      this.next();
      return { op: 'bool', value: t.value as boolean };
    }
    if (t.type === 'id') {
      this.next();
      // 函数调用：name ( args )
      if (this.peek()?.value === '(') {
        this.next(); // 跳过 (
        const args: DslNode[] = [];
        if (this.peek()?.value === ')') {
          this.next();
        } else {
          while (true) {
            args.push(this.parseOr());
            if (this.peek()?.value === ')') { this.next(); break; }
            if (this.peek()?.value === ',') { this.next(); continue; }
            throw new DslError('函数参数需要 , 或 )');
          }
        }
        return { op: 'call', name: t.value, args };
      }
      if (!(ALL_PROPS as readonly string[]).includes(t.value) && !(t.value in CONSTANTS)) {
        throw new DslError(`未知标识符 "${t.value}"（可用：${ALL_PROPS.join(', ')}）`);
      }
      return { op: 'id', value: t.value as string };
    }
    if (t.value === '(') {
      this.next();
      const e = this.parseOr();
      this.expect(')');
      return e;
    }
    throw new DslError(`意外的令牌 "${t.value}"`);
  }
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

// 内置常量（DSL 可用，作为裸标识符引用，如 PI）。三角函数以弧度工作，
// 故提供 PI / TAU(=2π) / E，便于 angle = sin(beat * PI) * 45 这类写法。
const CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  TAU: Math.PI * 2,
  E: Math.E,
};

// 内置函数（DSL 可用）。参数为数组，支持变长参数。
const BUILTINS: Record<string, (args: unknown[]) => unknown> = {
  abs: (a) => Math.abs(Number(a[0])),
  sign: (a) => Math.sign(Number(a[0])),
  floor: (a) => Math.floor(Number(a[0])),
  ceil: (a) => Math.ceil(Number(a[0])),
  round: (a) => Math.round(Number(a[0])),
  sqrt: (a) => Math.sqrt(Number(a[0])),
  // 小数部分 x - floor(x)，把周期量映射到 [0,1)
  fract: (a) => { const x = Number(a[0]); return x - Math.floor(x); },
  // 带容差的相等：near(a, b, tol)，tol 默认 1e-6。解决 1/6 拍吸附等浮点精度问题。
  near: (a) => Math.abs(Number(a[0]) - Number(a[1])) < (a[2] == null ? 1e-6 : Number(a[2])),
  min: (a) => Math.min(...a.map(Number)),
  max: (a) => Math.max(...a.map(Number)),
  clamp: (a) => Math.max(Number(a[1]), Math.min(Number(a[2]), Number(a[0]))),
  // 三角函数（弧度）。atan2(y, x) 用来由 x/y 直接求朝向角，谱面排布很常用。
  sin: (a) => Math.sin(Number(a[0])),
  cos: (a) => Math.cos(Number(a[0])),
  tan: (a) => Math.tan(Number(a[0])),
  asin: (a) => Math.asin(Number(a[0])),
  acos: (a) => Math.acos(Number(a[0])),
  atan: (a) => Math.atan(Number(a[0])),
  atan2: (a) => Math.atan2(Number(a[0]), Number(a[1])),
  sinh: (a) => Math.sinh(Number(a[0])),
  cosh: (a) => Math.cosh(Number(a[0])),
  tanh: (a) => Math.tanh(Number(a[0])),
  // 角度 <-> 弧度 互转，便于直接写角度量（谱面 angle 单位为度）。
  rad: (a) => (Number(a[0]) * Math.PI) / 180,
  deg: (a) => (Number(a[0]) * 180) / Math.PI,
  // [0,1) 均匀随机数。规则仅在放置新音符时逐音符求值，故每个音符得到独立
  // 随机值——适合 x = (random()*2-1)*1.8 这类随机落点/随机朝向排布。
  random: () => Math.random(),
};
const BUILTIN_NAMES = Object.keys(BUILTINS);

// 校验 AST 中引用的函数是否都存在（用于 lint 提前报错）
function checkCalls(node: DslNode): void {
  if (node.op === 'call') {
    if (!BUILTIN_NAMES.includes(node.name)) {
      throw new DslError(`未知函数 "${node.name}()"（可用：${BUILTIN_NAMES.join(', ')}）`);
    }
    node.args.forEach(checkCalls);
  } else if (node.op === 'neg' || node.op === 'not') {
    checkCalls(node.arg);
  } else if (node.op === 'num' || node.op === 'str' || node.op === 'bool' || node.op === 'id') {
    // 叶子节点
  } else {
    checkCalls((node as { left: DslNode; right: DslNode }).left);
    checkCalls((node as { left: DslNode; right: DslNode }).right);
  }
}

type Ctx = Record<string, unknown>;

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isNaN(n)) throw new DslError('此处需要数字');
    return n;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new DslError('此处需要数字');
}

function toBool(v: unknown): boolean {
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'boolean') return v;
  return false;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === typeof b) return a === b;
  if (typeof a === 'number' && typeof b === 'string') return !Number.isNaN(Number(b)) && Number(b) === a;
  if (typeof a === 'string' && typeof b === 'number') return !Number.isNaN(Number(a)) && Number(a) === b;
  return false;
}

function evalNode(node: DslNode, ctx: Ctx): unknown {
  switch (node.op) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;
    case 'id': {
      if (node.value in CONSTANTS) return CONSTANTS[node.value];
      if (!(node.value in ctx)) throw new DslError(`未知标识符 "${node.value}"`);
      return ctx[node.value];
    }
    case 'neg':
      return -toNum(evalNode(node.arg, ctx));
    case 'not':
      return !toBool(evalNode(node.arg, ctx));
    case '+': {
      const a = evalNode(node.left, ctx);
      const b = evalNode(node.right, ctx);
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      return String(a) + String(b);
    }
    case '-':
      return toNum(evalNode(node.left, ctx)) - toNum(evalNode(node.right, ctx));
    case '*':
      return toNum(evalNode(node.left, ctx)) * toNum(evalNode(node.right, ctx));
    case '/':
      return toNum(evalNode(node.left, ctx)) / toNum(evalNode(node.right, ctx));
    case '%':
      return toNum(evalNode(node.left, ctx)) % toNum(evalNode(node.right, ctx));
    case '==':
      return looseEq(evalNode(node.left, ctx), evalNode(node.right, ctx));
    case '!=':
      return !looseEq(evalNode(node.left, ctx), evalNode(node.right, ctx));
    case '<':
      return toNum(evalNode(node.left, ctx)) < toNum(evalNode(node.right, ctx));
    case '>':
      return toNum(evalNode(node.left, ctx)) > toNum(evalNode(node.right, ctx));
    case '<=':
      return toNum(evalNode(node.left, ctx)) <= toNum(evalNode(node.right, ctx));
    case '>=':
      return toNum(evalNode(node.left, ctx)) >= toNum(evalNode(node.right, ctx));
    case '&&':
      return toBool(evalNode(node.left, ctx)) && toBool(evalNode(node.right, ctx));
    case '||':
      return toBool(evalNode(node.left, ctx)) || toBool(evalNode(node.right, ctx));
    case 'call': {
      const fn = BUILTINS[node.name];
      if (!fn) throw new DslError(`未知函数 "${node.name}()"（可用：${BUILTIN_NAMES.join(', ')}）`);
      const args = node.args.map((a) => evalNode(a, ctx));
      return fn(args);
    }
  }
}

// ---------------------------------------------------------------------------
// 单行编译：拆条件 + 动作，校验属性名
// ---------------------------------------------------------------------------

interface CompiledRule {
  cond: DslNode;
  actions: Array<{ name: string; node: DslNode }>;
}

function firstColonOutsideString(line: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === ':') return i;
  }
  return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let inStr: string | null = null;
  for (const ch of s) {
    if (inStr) {
      if (ch === '\\') {
        cur += ch;
        continue;
      }
      if (ch === inStr) inStr = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return trimmed.startsWith('//') || trimmed.startsWith('#');
}

function compileLine(line: string): CompiledRule | null {
  if (isCommentOrBlank(line)) return null;
  const ci = firstColonOutsideString(line);
  if (ci < 0) throw new DslError('缺少 ":" 分隔条件与动作');
  const condSrc = line.slice(0, ci);
  const actSrc = line.slice(ci + 1);

  const cond = new Parser(tokenize(condSrc)).parseAll();
  checkCalls(cond);

  const actions: Array<{ name: string; node: DslNode }> = [];
  if (actSrc.trim() !== '') {
    for (const raw of splitTopLevel(actSrc, ',')) {
      const p = raw.trim();
      if (p === '') continue;
      const ap = new Parser(tokenize(p));
      const t0 = ap.next();
      if (!t0 || t0.type !== 'id') throw new DslError('赋值左侧必须是属性名');
      if (!(ALL_PROPS as readonly string[]).includes(t0.value)) {
        throw new DslError(`未知属性 "${t0.value}"（可用：${ALL_PROPS.join(', ')}）`);
      }
      ap.expect('=');
      const expr = ap.parseAll();
      checkCalls(expr);
      actions.push({ name: t0.value, node: expr });
    }
  }
  if (actions.length === 0) throw new DslError('缺少赋值动作');
  return { cond, actions };
}

function assignProp(ctx: Ctx, name: string, raw: unknown): void {
  if ((NUMERIC_PROPS as readonly string[]).includes(name)) {
    ctx[name] = toNum(raw);
    return;
  }
  // 字符串属性
  const str = String(raw);
  if (name === 'type') {
    if (!['tap', 'touch', 'slide'].includes(str)) {
      throw new DslError(`type 必须为 tap/touch/slide，得到 "${str}"`);
    }
    ctx.type = str as NoteType;
  } else if (name === 'easing') {
    if (!EASING_TYPES.includes(str as any)) {
      throw new DslError(`easing 必须为 ${EASING_TYPES.join('/')}，得到 "${str}"`);
    }
    ctx.easing = str;
  } else {
    // color
    ctx.color = str;
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 对单个“新放置”的音符依次套用 DSL 全部规则（出错行静默跳过）。 */
export function applyDslToNote(note: NoteData, dsl: string): NoteData {
  const ctx: Ctx = {
    beat: note.beat,
    x: note.x,
    y: note.y,
    type: note.type,
    color: note.color,
    angle: note.angle,
    easing: note.easing,
  };
  const lines = dsl.split('\n');
  for (const line of lines) {
    if (isCommentOrBlank(line)) continue;
    try {
      const rule = compileLine(line);
      if (!rule) continue;
      if (toBool(evalNode(rule.cond, ctx))) {
        for (const a of rule.actions) {
          assignProp(ctx, a.name, evalNode(a.node, ctx));
        }
      }
    } catch {
      // 放置时不打断流程：非法行直接跳过（错误会在 lintDsl 中提示）
    }
  }
  return {
    ...note,
    beat: ctx.beat as number,
    x: ctx.x as number,
    y: ctx.y as number,
    type: ctx.type as NoteType,
    color: ctx.color as string | undefined,
    angle: ctx.angle as number | undefined,
    easing: ctx.easing as NoteData['easing'],
  };
}

/** 校验整段 DSL，返回带行号的语法/语义错误（用于 UI 提示）。 */
export function lintDsl(dsl: string): DslLineError[] {
  const errs: DslLineError[] = [];
  const lines = dsl.split('\n');
  lines.forEach((line, idx) => {
    if (isCommentOrBlank(line)) return;
    try {
      compileLine(line);
    } catch (e) {
      errs.push({ line: idx + 1, message: e instanceof Error ? e.message : String(e) });
    }
  });
  return errs;
}

/** 默认留空，编辑器内的灰字占位提示已足够（见 VisualChartEditor 的 placeholder）。 */
function defaultDsl(): string {
  return '';
}

export function loadEditorDsl(): string {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw == null) return defaultDsl();
    return raw;
  } catch {
    return defaultDsl();
  }
}

export function saveEditorDsl(dsl: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, dsl);
    }
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}
