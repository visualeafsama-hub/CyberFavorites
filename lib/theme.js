// 主题：预设 + 补丁校验。AI 改 UI 只能走这里，未知字段直接报错，方便它自己纠正。

export const COLOR_KEYS = ['bg', 'paper', 'card', 'accent', 'accentHi', 'accentSoft',
  'accentPale', 'accentInk', 'ink', 'muted', 'line', 'danger'];

export const PRESETS = {
  laterano: {
    label: '拉特兰 · 天青', dark: false,
    colors: { bg: '#e6ecf3', paper: '#f3f7fb', card: '#ffffff', accent: '#3b97d3', accentHi: '#9fd6f7',
      accentSoft: '#d2e6f5', accentPale: '#eef6fc', accentInk: '#1d6aa3', ink: '#172338',
      muted: '#6c7d92', line: '#dfe7f0', danger: '#b5465f' },
  },
  'laterano-gold': {
    label: '拉特兰 · 白金', dark: false,
    colors: { bg: '#ece7db', paper: '#f7f3ea', card: '#fffefb', accent: '#b08a3c', accentHi: '#d9b867',
      accentSoft: '#eadcb6', accentPale: '#f6eedb', accentInk: '#7d5f22', ink: '#1d2340',
      muted: '#7c8096', line: '#e9e1cf', danger: '#b5465f' },
  },
  abyss: {
    label: '深海 · 夜', dark: true,
    colors: { bg: '#0b1220', paper: '#101a2c', card: '#14203a', accent: '#5cc8ff', accentHi: '#a8e4ff',
      accentSoft: '#22406a', accentPale: '#172a48', accentInk: '#8fd9ff', ink: '#e6eefb',
      muted: '#8a9bb8', line: '#22314f', danger: '#ff7a93' },
  },
};

export const ENUMS = {
  font: ['serif', 'sans', 'mono'],
  layout: ['grid', 'list', 'compact'],
};

export function defaultTheme() {
  return {
    preset: 'laterano',
    dark: false,
    colors: { ...PRESETS.laterano.colors },
    font: 'serif',
    layout: 'grid',
    cardWidth: 300,
    radius: 6,
    decor: { rose: true, rays: true },
    title: 'CyberFavorites',
    subtitle: '赛博收藏夹 · 那些暂时用不上的好东西',
    customCss: '',
  };
}

const COLOR_RE = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla|oklch)\([\d\s.,%/+-]+\))$/i;

export class ThemeError extends Error {}
const bad = (msg) => new ThemeError(msg);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function num(k, v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${k} 必须是 ${min}–${max} 的数字`);
  return Math.round(v);
}
function str(k, v, max) {
  if (typeof v !== 'string' || v.length > max) throw bad(`${k} 必须是不超过 ${max} 字符的字符串`);
  return v;
}

// 把补丁合并进 theme，返回新对象；preset 先应用，其余字段覆盖在它上面
export function applyThemePatch(theme, patch) {
  if (!isObj(patch)) throw bad('主题补丁必须是 JSON 对象');
  const next = structuredClone(theme);
  if ('preset' in patch) {
    const p = PRESETS[patch.preset];
    if (!p) throw bad(`未知预设 "${patch.preset}"，可选：${Object.keys(PRESETS).join(', ')}`);
    next.preset = patch.preset;
    next.colors = { ...p.colors };
    next.dark = p.dark;
  }
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'preset': break;
      case 'colors':
        if (!isObj(v)) throw bad('colors 必须是对象');
        for (const [ck, cv] of Object.entries(v)) {
          if (!COLOR_KEYS.includes(ck)) throw bad(`未知颜色 "${ck}"，可选：${COLOR_KEYS.join(', ')}`);
          if (typeof cv !== 'string' || !COLOR_RE.test(cv.trim())) throw bad(`颜色 ${ck} 格式不对：用 #rrggbb、rgb()、hsl() 或 oklch()`);
          next.colors[ck] = cv.trim();
        }
        next.preset = 'custom';
        break;
      case 'dark':
        if (typeof v !== 'boolean') throw bad('dark 必须是布尔值');
        next.dark = v; break;
      case 'font': case 'layout':
        if (!ENUMS[k].includes(v)) throw bad(`${k} 可选：${ENUMS[k].join(', ')}`);
        next[k] = v; break;
      case 'cardWidth': next.cardWidth = num(k, v, 220, 520); break;
      case 'radius': next.radius = num(k, v, 0, 28); break;
      case 'decor':
        if (!isObj(v)) throw bad('decor 必须是对象，例如 {"rose": false}');
        for (const [dk, dv] of Object.entries(v)) {
          if (!['rose', 'rays'].includes(dk)) throw bad(`未知装饰 "${dk}"，可选：rose, rays`);
          if (typeof dv !== 'boolean') throw bad(`decor.${dk} 必须是布尔值`);
          next.decor[dk] = dv;
        }
        break;
      case 'title': next.title = str(k, v, 60); break;
      case 'subtitle': next.subtitle = str(k, v, 120); break;
      case 'customCss': next.customCss = str(k, v, 50000); break;
      default:
        throw bad(`未知字段 "${k}"。可改：preset, colors, dark, font, layout, cardWidth, radius, decor, title, subtitle, customCss`);
    }
  }
  return next;
}
