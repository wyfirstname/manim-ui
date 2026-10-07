/**
 * 国际化（中 / EN）
 *
 * 语言优先级：localStorage > 浏览器语言 > 中文
 * 用法：
 *   import { t, getLang, setLang, onLangChange } from './i18n.js';
 *   t('btn.export')                  // 取词
 *   t('log.switch', { name: '...' }) // 带插值
 *
 * 静态文本在 HTML 上用 data-i18n 标记，由 app.js 的 applyStaticI18n() 统一填充；
 * 动态生成的控件（滑块/按钮/场景卡）在语言切换时重建。
 */

const STORAGE_KEY = 'manim-ui.lang';

const DICT = {
    zh: {
        'app.name': 'manim-ui',
        'app.tagline': '数学可视化 · 本地运行',
        'app.docTitle': 'manim-ui · 数学可视化',

        'pane.presets': '预设场景',
        'pane.env': '运行环境',
        'pane.params': '参数调节',

        'module.fractal': '分形实验室',
        'module.plot': '函数绘图器',
        'module.field': '向量场流线',
        'module.solid': '三维几何',
        'module.random': '随机过程',

        'hint.canvas': '拖拽平移 · 滚轮缩放 · 双击复位',

        'section.basic': '基本参数',
        'section.view': '视图',
        'section.field': '向量场',
        'section.display': '显示',
        'section.shape': '形状',
        'section.material': '材质',

        'ctrl.steps': '迭代步数',
        'ctrl.re': '实部 c',
        'ctrl.im': '虚部 c',
        'ctrl.zoom': '缩放',

        'ctrl.coeffA': '系数 a',
        'ctrl.coeffB': '系数 b',
        'ctrl.coeffC': '系数 c',
        'ctrl.rectangles': '矩形数',
        'ctrl.upperLimit': '积分上限 b',
        'ctrl.fillOpacity': '填充不透明度',
        'ctrl.xSpan': '横向范围',
        'ctrl.ySpan': '纵向范围',
        'ctrl.keepAspect': '等比例',
        'ctrl.lineWidth': '线宽',

        'ctrl.spin': '旋向',
        'ctrl.strength': '强度',
        'ctrl.sep': '间距',
        'ctrl.arrowScale': '箭头长度',
        'ctrl.arrowDensity': '箭头密度',
        'ctrl.streamSeeds': '流线密度',
        'ctrl.traceLength': '流线长度',
        'ctrl.showArrows': '显示箭头',
        'ctrl.showStreams': '显示流线',

        'ctrl.detail': '细分',
        'ctrl.radius': '半径',
        'ctrl.tube': '管半径',
        'ctrl.width': '带宽',
        'ctrl.twists': '半扭转数',
        'ctrl.reflect': '反光',
        'ctrl.gloss': '高光',
        'ctrl.shadow': '阴影',
        'ctrl.showAxes': '坐标轴',
        'ctrl.wireframe': '网格线',
        'ctrl.spinRate': '自转速度',

        'ctrl.seed': '随机种子',
        'ctrl.samples': '样本数',
        'ctrl.runs': '实验条数',
        'ctrl.prob': '成功概率 p',
        'ctrl.variables': '变量个数 n',
        'ctrl.bins': '直方图柱数',
        'ctrl.walkers': '游走个体',
        'ctrl.walkSteps': '步数',
        'ctrl.stepLength': '步长',
        'ctrl.showBand': '显示收敛带',
        'ctrl.showCircle': '显示典型距离圆',

        'btn.export': '导出 PNG',
        'btn.exporting': '导出中…',
        'btn.reset': '重置视图',
        'btn.play': '▶ 播放',
        'btn.pause': '⏸ 暂停',

        'device.detecting': '检测中…',
        'device.gpu': 'GPU：<b>{name}</b>',
        'device.ready': 'GPU：已就绪',

        'log.init': '初始化 WebGPU…',
        'log.adapter': '适配器：{name}',
        'log.loading': '载入着色器…',
        'log.ready': '就绪',
        'log.switch': '切换到 {name}',
        'log.exported': '已导出 PNG',
        'log.exportFail': '导出失败：{msg}',
        'log.shaderErr': '着色器错误：{msg}',

        'fatal.secure.title': '不在安全上下文中',
        'fatal.secure.body': 'WebGPU 需要 https 或 http://localhost 环境。<br>请通过<b>启动.bat</b> 打开，不要直接双击 HTML 文件。',
        'fatal.secure.detail': '当前页面不是安全上下文',
        'fatal.nogpu.title': '浏览器不支持 WebGPU',
        'fatal.nogpu.body': '当前浏览器没有提供 <code>navigator.gpu</code>。<br>请使用 <b>Edge 113+</b> 或 <b>Chrome 113+</b>，并确认未禁用硬件加速。',
        'fatal.nogpu.detail': 'navigator.gpu 不存在',
        'fatal.noadapter.title': '未找到 GPU 适配器',
        'fatal.noadapter.body': '浏览器支持 WebGPU，但没有可用的 GPU 适配器。<br>请检查显卡驱动是否正常。',
        'fatal.noadapter.detail': 'requestAdapter 返回 null',
        'fatal.init.title': '初始化失败',
        'fatal.shader.title': '着色器编译失败',
        'fatal.start.title': '启动失败',
        'fatal.tip': '提示：本项目必须通过 <code>启动.bat</code> 打开（提供 localhost 环境）。直接双击 HTML 文件会导致 WebGPU 不可用。',

        'preset.mandelbrot.name': '曼德博集合',
        'preset.mandelbrot.hint': '最经典的分形，边界处有无限自相似结构',
        'preset.julia.name': '朱利亚集合',
        'preset.julia.hint': '拖动「实部 / 虚部」看它如何变形',
        'preset.julia2.name': '朱利亚 · 兔形',
        'preset.julia2.hint': 'c = −0.123 + 0.745i，经典兔子',
        'preset.julia3.name': '朱利亚 · 仙人掌',
        'preset.julia3.hint': 'c = 0.285 + 0.01i，细分形结构',
        'preset.zoom.name': '曼德博 · 放大',
        'preset.zoom.hint': '同一集合，无限放大后仍然自相似',
        'preset.newton.name': '牛顿迭代法',
        'preset.newton.hint': '解 z³ − 1 = 0，三个根各有一个吸引域；放大交界处可见自相似结构',

        'preset.trig.name': '正弦与余弦',
        'preset.trig.hint': 'y = a·sin(bx + c) 与 y = a·cos(bx + c)，拖动滑块看振幅、频率、相位',
        'preset.quadratic.name': '二次函数',
        'preset.quadratic.hint': 'y = a·x² + b·x + c，抛物线随系数实时变形',
        'preset.riemann.name': '黎曼和 · 定积分',
        'preset.riemann.hint': 'y = x² 在 [0, 2] 上的黎曼和，矩形越细越逼近定积分',
        'preset.integral.name': '曲线下的面积',
        'preset.integral.hint': 'y = x² 从 0 积到 b 的面积，拖动上限看它怎么长大',

        'preset.vortex.name': '涡旋',
        'preset.vortex.hint': 'F = (−y, x)：流线是一圈圈同心圆，颜色表示速率',
        'preset.attractor.name': '单吸引子',
        'preset.attractor.hint': 'F = −(x, y)：所有流线笔直汇向原点',
        'preset.dipole.name': '偶极子',
        'preset.dipole.hint': '一个源 + 一个汇，流线从源出发绕进汇',
        'preset.dualvortex.name': '双涡',
        'preset.dualvortex.hint': '两个反向旋转的涡旋，中间挤出一条向上的通道',

        'preset.sphere.name': '球面',
        'preset.sphere.hint': '经纬网格现推出来的球面，颜色随高度渐变',
        'preset.torus.name': '环面',
        'preset.torus.hint': '甜甜圈曲面，打开「网格线」看两层经纬',
        'preset.mobius.name': '莫比乌斯带',
        'preset.mobius.hint': '只有一个面、一条边：沿带子走一圈会翻到「背面」',
        'preset.icosa.name': '正二十面体',
        'preset.icosa.hint': '二十个三角面，每个面各自平面着色',

        'preset.lln.name': '大数定律',
        'preset.lln.hint': '经验均值随试验次数收敛到 p，绿带是 ±σ/√n 的收敛范围，拖动 p 换一个真值',
        'preset.clt.name': '中心极限定理',
        'preset.clt.hint': 'n 个均匀随机变量之和标准化后趋于钟形，拖动 n 或点播放看它一步步变成正态分布',
        'preset.walk.name': '随机游走',
        'preset.walk.hint': '每步随机选一个方向，n 步后离原点的典型距离约为 √n · 步长（灰圈）',
    },

    en: {
        'app.name': 'manim-ui',
        'app.tagline': 'Mathematical visualization · runs locally',
        'app.docTitle': 'manim-ui · Mathematical Visualization',

        'pane.presets': 'Presets',
        'pane.env': 'Environment',
        'pane.params': 'Parameters',

        'module.fractal': 'Fractal Lab',
        'module.plot': 'Function Plotter',
        'module.field': 'Vector Field Streamlines',
        'module.solid': '3D Geometry',
        'module.random': 'Stochastic Processes',

        'hint.canvas': 'Drag to pan · scroll to zoom · double-click to reset',

        'section.basic': 'Basic',
        'section.view': 'View',
        'section.field': 'Vector field',
        'section.display': 'Display',
        'section.shape': 'Shape',
        'section.material': 'Material',

        'ctrl.steps': 'Iterations',
        'ctrl.re': 'Real part c',
        'ctrl.im': 'Imaginary part c',
        'ctrl.zoom': 'Zoom',

        'ctrl.coeffA': 'Coefficient a',
        'ctrl.coeffB': 'Coefficient b',
        'ctrl.coeffC': 'Coefficient c',
        'ctrl.rectangles': 'Rectangles',
        'ctrl.upperLimit': 'Upper limit b',
        'ctrl.fillOpacity': 'Fill opacity',
        'ctrl.xSpan': 'X range',
        'ctrl.ySpan': 'Y range',
        'ctrl.keepAspect': 'Equal aspect',
        'ctrl.lineWidth': 'Line width',

        'ctrl.spin': 'Spin',
        'ctrl.strength': 'Strength',
        'ctrl.sep': 'Separation',
        'ctrl.arrowScale': 'Arrow length',
        'ctrl.arrowDensity': 'Arrow density',
        'ctrl.streamSeeds': 'Streamline density',
        'ctrl.traceLength': 'Streamline length',
        'ctrl.showArrows': 'Show arrows',
        'ctrl.showStreams': 'Show streamlines',

        'ctrl.detail': 'Detail',
        'ctrl.radius': 'Radius',
        'ctrl.tube': 'Tube radius',
        'ctrl.width': 'Band width',
        'ctrl.twists': 'Half-twists',
        'ctrl.reflect': 'Reflectiveness',
        'ctrl.gloss': 'Gloss',
        'ctrl.shadow': 'Shadow',
        'ctrl.showAxes': 'Axes',
        'ctrl.wireframe': 'Wireframe',
        'ctrl.spinRate': 'Auto-spin speed',

        'ctrl.seed': 'Random seed',
        'ctrl.samples': 'Samples',
        'ctrl.runs': 'Runs',
        'ctrl.prob': 'Success probability p',
        'ctrl.variables': 'Variables n',
        'ctrl.bins': 'Histogram bins',
        'ctrl.walkers': 'Walkers',
        'ctrl.walkSteps': 'Steps',
        'ctrl.stepLength': 'Step length',
        'ctrl.showBand': 'Show convergence band',
        'ctrl.showCircle': 'Show typical-distance circle',

        'btn.export': 'Export PNG',
        'btn.exporting': 'Exporting…',
        'btn.reset': 'Reset view',
        'btn.play': '▶ Play',
        'btn.pause': '⏸ Pause',

        'device.detecting': 'Detecting…',
        'device.gpu': 'GPU: <b>{name}</b>',
        'device.ready': 'GPU: ready',

        'log.init': 'Initializing WebGPU…',
        'log.adapter': 'Adapter: {name}',
        'log.loading': 'Loading shaders…',
        'log.ready': 'Ready',
        'log.switch': 'Switched to {name}',
        'log.exported': 'PNG exported',
        'log.exportFail': 'Export failed: {msg}',
        'log.shaderErr': 'Shader error: {msg}',

        'fatal.secure.title': 'Not a secure context',
        'fatal.secure.body': 'WebGPU requires https or http://localhost.<br>Please open this app via <b>启动.bat</b> instead of double-clicking the HTML file.',
        'fatal.secure.detail': 'current page is not a secure context',
        'fatal.nogpu.title': 'WebGPU not supported',
        'fatal.nogpu.body': 'This browser exposes no <code>navigator.gpu</code>.<br>Please use <b>Edge 113+</b> or <b>Chrome 113+</b>, and make sure hardware acceleration is enabled.',
        'fatal.nogpu.detail': 'navigator.gpu is undefined',
        'fatal.noadapter.title': 'No GPU adapter found',
        'fatal.noadapter.body': 'The browser supports WebGPU but no adapter is available.<br>Please check your graphics driver.',
        'fatal.noadapter.detail': 'requestAdapter returned null',
        'fatal.init.title': 'Initialization failed',
        'fatal.shader.title': 'Shader compilation failed',
        'fatal.start.title': 'Failed to start',
        'fatal.tip': 'Note: this app must be opened through <code>启动.bat</code> (to provide a localhost origin). Double-clicking the HTML file disables WebGPU.',

        'preset.mandelbrot.name': 'Mandelbrot Set',
        'preset.mandelbrot.hint': 'The classic fractal — infinitely self-similar along its boundary',
        'preset.julia.name': 'Julia Set',
        'preset.julia.hint': 'Drag “real / imaginary” to watch the shape morph',
        'preset.julia2.name': 'Julia · Rabbit',
        'preset.julia2.hint': 'c = −0.123 + 0.745i, the classic Douady rabbit',
        'preset.julia3.name': 'Julia · Cactus',
        'preset.julia3.hint': 'c = 0.285 + 0.01i, fine-grained fractal structure',
        'preset.zoom.name': 'Mandelbrot · Deep Zoom',
        'preset.zoom.hint': 'The same set — still self-similar as you zoom in forever',
        'preset.newton.name': "Newton's Method",
        'preset.newton.hint': 'Solving z³ − 1 = 0 — each root owns a basin; zoom into the borders for self-similarity',

        'preset.trig.name': 'Sine & Cosine',
        'preset.trig.hint': 'y = a·sin(bx + c) and y = a·cos(bx + c) — drag for amplitude, frequency and phase',
        'preset.quadratic.name': 'Quadratic Function',
        'preset.quadratic.hint': 'y = a·x² + b·x + c — the parabola morphs as you drag the coefficients',
        'preset.riemann.name': 'Riemann Sum · Integral',
        'preset.riemann.hint': 'Riemann sum of y = x² over [0, 2] — finer rectangles approach the integral',
        'preset.integral.name': 'Area Under a Curve',
        'preset.integral.hint': 'Area under y = x² from 0 to b — drag the upper limit and watch it grow',

        'preset.vortex.name': 'Vortex',
        'preset.vortex.hint': 'F = (−y, x) — streamlines are concentric circles, colour shows speed',
        'preset.attractor.name': 'Point Attractor',
        'preset.attractor.hint': 'F = −(x, y) — every streamline runs straight into the origin',
        'preset.dipole.name': 'Dipole',
        'preset.dipole.hint': 'One source plus one sink — streamlines leave the source and curve into the sink',
        'preset.dualvortex.name': 'Twin Vortices',
        'preset.dualvortex.hint': 'Two counter-rotating vortices squeeze an upward channel between them',

        'preset.sphere.name': 'Sphere',
        'preset.sphere.hint': 'A sphere whose mesh is derived on the fly from a grid of latitudes and longitudes',
        'preset.torus.name': 'Torus',
        'preset.torus.hint': 'A doughnut surface — turn on the wireframe to see both families of circles',
        'preset.mobius.name': 'Möbius Strip',
        'preset.mobius.hint': 'One face, one edge: walk the band once and you come back on the "other" side',
        'preset.icosa.name': 'Icosahedron',
        'preset.icosa.hint': 'Twenty triangular faces, each shaded flat on its own',

        'preset.lln.name': 'Law of Large Numbers',
        'preset.lln.hint': 'The running average of flips converges to p; the green band is the ±σ/√n range — drag p to move the true value',
        'preset.clt.name': 'Central Limit Theorem',
        'preset.clt.hint': 'A standardised sum of n uniform variables turns into a bell — drag n or press play to watch it happen',
        'preset.walk.name': 'Random Walk',
        'preset.walk.hint': 'Each step picks a random direction; after n steps the typical distance is ≈ √n · step length (grey circle)',
    },
};

function detectLang() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && DICT[saved]) return saved;
    } catch { /* localStorage 可能被禁用 */ }
    const nav = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
}

let current = detectLang();
const listeners = new Set();

export function getLang() {
    return current;
}

export function setLang(lang) {
    if (!DICT[lang] || lang === current) return;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const fn of listeners) fn(lang);
}

/** 订阅语言变化；返回取消订阅函数 */
export function onLangChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * 取词。缺失时回退到中文，再回退到 key 本身（便于发现漏翻）。
 * @param {string} key
 * @param {Record<string, unknown>} [vars] 形如 { name: 'Intel' }，替换 {name}
 */
export function t(key, vars) {
    const table = DICT[current] ?? DICT.zh;
    let s = table[key] ?? DICT.zh[key] ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            s = s.split(`{${k}}`).join(String(v));
        }
    }
    return s;
}

/** 填充所有 data-i18n / data-i18n-html 元素，并同步文档标题 */
export function applyStaticI18n(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.dataset.i18n);
    }
    for (const el of root.querySelectorAll('[data-i18n-html]')) {
        el.innerHTML = t(el.dataset.i18nHtml);
    }
    document.title = t('app.docTitle');
}

export const LANGS = [
    { id: 'zh', label: '中' },
    { id: 'en', label: 'EN' },
];
