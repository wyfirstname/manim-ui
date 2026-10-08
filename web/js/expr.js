/**
 * 数学表达式解析器 —— 给「自定义函数」输入框用。
 *
 * ── 为什么不能图省事用 eval / new Function ──
 * 输入框里的字符串来自用户（也可能是别人发来的公式）。把它直接交给 JS 引擎执行，
 * 等于把整个页面的控制权交出去 —— `fetch(...)`、`location=...` 都能写进去。
 * 这里自己写词法分析与递归下降，**只认白名单里的常量、变量和函数**，
 * 其他名字一律报错。全程没有字符串拼接出来的代码，也没有 eval。
 *
 * ── 为什么要"闭包树"而不是"语法树 + 求值循环" ──
 * 解析阶段就把节点组合成一组互相调用的箭头函数，之后每次求值只是函数调用，
 * 不用再走 switch 分派。曲线每秒要算 400 个点，这点差别是值得的。
 *
 * ── 用法 ──
 *   const r = compileExpr('a*sin(b*x+c)');
 *   if (r.error) ...            // { code, args }，由界面翻译成人话
 *   r.fn({ x: 2, a: 1, b: 1, c: 0 })   // → 数值
 *
 * 求值上下文固定为 { x, a, b, c }：x 是横坐标，a/b/c 挂在参数面板的滑块上，
 * 于是同一个表达式既能画函数，也能被三个滑块实时改变形状。
 */

/** 表达式长度上限（防止粘贴一整篇文章进来，也保证解析是常数级开销） */
const MAX_LENGTH = 400;

/** 支持的常量（名字统一小写比较） */
const CONSTANTS = {
    pi: Math.PI,
    'π': Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
};

/** 变量白名单：求值上下文里必须有同名字段 */
export const VARIABLES = ['x', 'a', 'b', 'c'];

/** 一元函数 */
const FUNCS1 = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
    exp: Math.exp,
    ln: Math.log,          // 自然对数
    log: Math.log10,       // 与 Desmos / GeoGebra 一致：log 是常用对数
    log2: Math.log2, log10: Math.log10,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    sign: Math.sign, floor: Math.floor, ceil: Math.ceil,
    round: Math.round, trunc: Math.trunc,
};

/** 二元函数（不做变参：min/max 只收两个，够用且错误提示明确） */
const FUNCS2 = {
    min: Math.min, max: Math.max, pow: Math.pow,
    atan2: Math.atan2, hypot: Math.hypot,
    mod: (a, b) => a % b,
};

/** 允许的字符→标准字符（从网页或输入法复制来的公式常带这些） */
const NORMALIZE = {
    '×': '*', '·': '*', '⋅': '*', '÷': '/',
    '−': '-', '–': '-', '—': '-',
    '（': '(', '）': ')', '，': ',',
    '＋': '+', '－': '-', '＊': '*', '／': '/', '＾': '^', '％': '%',
    '²': '^2', '³': '^3',
};

class ExprError extends Error {
    constructor(code, args) {
        super(code);
        this.code = code;
        this.args = args ?? {};
    }
}

const fail = (code, args) => { throw new ExprError(code, args); };

/**
 * 查表必须先过这一关。
 * ⚠️ 不能用 `name in TABLE` —— 那会顺着原型链找到 `constructor` / `__proto__` /
 * `toString` 这些继承来的属性，于是一个叫 `constructor` 的"变量"能拿到
 * Object 构造函数本身。安全测试里专门有这一组样本。
 */
const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

/** 全角/数学符号统一：先做字符替换，再交给词法分析 */
function normalize(src) {
    let out = '';
    for (const ch of src) out += NORMALIZE[ch] ?? ch;
    return out;
}

/**
 * 词法分析。
 * @returns {Array<{t: string, v?: any}>} 末尾一定带一个 { t:'end' }
 */
function tokenize(src) {
    const s = normalize(src);
    const out = [];
    let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';
    const isNameChar = (c) => /[A-Za-z0-9_]/.test(c);
    const isName = (c) => /[A-Za-z_]/.test(c);

    while (i < s.length) {
        const ch = s[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

        if (isDigit(ch) || (ch === '.' && isDigit(s[i + 1] ?? ''))) {
            let j = i;
            while (j < s.length && isDigit(s[j])) j++;
            if (s[j] === '.') { j++; while (j < s.length && isDigit(s[j])) j++; }
            if (s[j] === 'e' || s[j] === 'E') {          // 科学计数法 1e-3
                let k = j + 1;
                if (s[k] === '+' || s[k] === '-') k++;
                if (isDigit(s[k] ?? '')) {
                    while (k < s.length && isDigit(s[k])) k++;
                    j = k;
                }
            }
            out.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
            i = j;
            continue;
        }

        // π 单独成词：这样 πx、xπ 会被拆成两个名字，走隐式乘法
        if (ch === 'π') { out.push({ t: 'name', v: 'π' }); i++; continue; }

        if (isName(ch)) {
            let j = i;
            while (j < s.length && isNameChar(s[j])) j++;
            out.push({ t: 'name', v: s.slice(i, j) });
            i = j;
            continue;
        }

        if ('+-*/^%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
        // 根号当一元前缀运算符，于是 √x、(√x)+1、√(x^2+1) 都能写
        if (ch === '√') { out.push({ t: 'op', v: '√' }); i++; continue; }
        if (ch === '(') { out.push({ t: 'lparen' }); i++; continue; }
        if (ch === ')') { out.push({ t: 'rparen' }); i++; continue; }
        if (ch === ',') { out.push({ t: 'comma' }); i++; continue; }

        fail('badChar', { ch });
    }
    out.push({ t: 'end' });
    return out;
}

/**
 * 递归下降解析 + 就地编译成闭包。
 * 文法（自上而下，优先级从低到高）：
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/' | '%') unary | 隐式乘法)*
 *   unary  := ('-' | '+' | '√') unary | power
 *   power  := atom ('^' unary)?          —— 右结合，2^3^2 = 2^(3^2)
 *   atom   := 数字 | 常量 | 变量 | 函数调用 | '(' expr ')'
 */
function parse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    const num = (v) => () => v;
    const bin = (f, l, r) => (ctx) => f(l(ctx), r(ctx));

    function parseExpr() {
        let node = parseTerm();
        for (;;) {
            const tok = peek();
            if (tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
                next();
                const rhs = parseTerm();
                node = tok.v === '+' ? bin((p, q) => p + q, node, rhs) : bin((p, q) => p - q, node, rhs);
            } else break;
        }
        return node;
    }

    /** 这个 token 能不能开始一个因子（用于识别隐式乘法：2x、3sin(x)、(x+1)(x-1)） */
    function startsFactor(tok) {
        return tok.t === 'num' || tok.t === 'name' || tok.t === 'lparen';
    }

    function parseTerm() {
        let node = parseUnary();
        for (;;) {
            const tok = peek();
            if (tok.t === 'op' && (tok.v === '*' || tok.v === '/' || tok.v === '%')) {
                next();
                const rhs = parseUnary();
                if (tok.v === '*') node = bin((p, q) => p * q, node, rhs);
                else if (tok.v === '/') node = bin((p, q) => p / q, node, rhs);
                else node = bin((p, q) => p % q, node, rhs);
            } else if (startsFactor(tok)) {
                // 隐式乘法。与显式乘法同级、左结合，所以 1/2x 是 (1/2)·x
                node = bin((p, q) => p * q, node, parseUnary());
            } else break;
        }
        return node;
    }

    function parseUnary() {
        const tok = peek();
        if (tok.t === 'op' && (tok.v === '-' || tok.v === '+')) {
            next();
            const v = parseUnary();
            return tok.v === '-' ? (ctx) => -v(ctx) : v;
        }
        if (tok.t === 'op' && tok.v === '√') {
            next();
            const v = parseUnary();
            return (ctx) => Math.sqrt(v(ctx));
        }
        return parsePower();
    }

    function parsePower() {
        const base = parseAtom();
        const tok = peek();
        if (tok.t === 'op' && tok.v === '^') {
            next();
            // 右结合：指数再走一遍 unary，于是 2^-1、2^3^2 都对
            const exp = parseUnary();
            return bin((p, q) => p ** q, base, exp);
        }
        return base;
    }

    function parseAtom() {
        const tok = next();
        if (tok.t === 'num') return num(tok.v);

        if (tok.t === 'lparen') {
            const inner = parseExpr();
            if (next().t !== 'rparen') fail('paren');
            return inner;
        }

        if (tok.t === 'name') {
            const name = tok.v.toLowerCase();

            // 函数调用：名字后面紧跟左括号
            if (peek().t === 'lparen' && (has(FUNCS1, name) || has(FUNCS2, name))) {
                next();
                const args = [parseExpr()];
                while (peek().t === 'comma') {
                    next();
                    args.push(parseExpr());
                }
                if (next().t !== 'rparen') fail('paren');
                return buildCall(name, args);
            }

            if (has(CONSTANTS, name)) return num(CONSTANTS[name]);
            if (VARIABLES.includes(name)) return (ctx) => ctx[name];
            fail('unknown', { name: tok.v });
        }

        if (tok.t === 'end') fail('unexpectedEnd');
        fail('syntax', { detail: String(tok.v ?? tok.t) });
    }

    function buildCall(name, args) {
        const want = has(FUNCS1, name) ? 1 : 2;
        if (args.length !== want) fail('arity', { name, want, got: args.length });
        if (want === 1) {
            const f = FUNCS1[name];
            const a0 = args[0];
            return (ctx) => f(a0(ctx));
        }
        const f = FUNCS2[name];
        const [a0, a1] = args;
        return (ctx) => f(a0(ctx), a1(ctx));
    }

    const fn = parseExpr();
    if (peek().t !== 'end') fail('syntax', { detail: peek().v ?? peek().t });
    return fn;
}

/**
 * 编译一个表达式。
 * @param {string} src 用户输入
 * @returns {{ fn: ((ctx: object) => number)|null, error: ({code: string, args: object})|null }}
 */
export function compileExpr(src) {
    const text = String(src ?? '').trim();
    if (!text) return { fn: null, error: { code: 'empty', args: {} } };
    if (text.length > MAX_LENGTH) {
        return { fn: null, error: { code: 'length', args: { max: MAX_LENGTH } } };
    }
    try {
        const fn = parse(tokenize(text));
        // 先拿一组"正常"的输入试算，NaN / Infinity 是合法的（渐近线、定义域外），
        // 只用来确认函数真的能被调用而不抛异常
        fn({ x: 0.7, a: 1, b: 1, c: 0 });
        return { fn, error: null };
    } catch (e) {
        if (e instanceof ExprError) return { fn: null, error: { code: e.code, args: e.args } };
        return { fn: null, error: { code: 'syntax', args: { detail: String(e?.message ?? e) } } };
    }
}

/** 供界面展示：把错误码翻成人话（本模块不依赖 i18n，翻译交给调用方） */
export const ERROR_KEYS = [
    'empty', 'length', 'badChar', 'paren', 'unknown', 'arity', 'syntax', 'unexpectedEnd',
];
