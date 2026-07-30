const crypto = require('node:crypto');
const fs = require('node:fs');

const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_MAX_INLINE_LINE_CHARS = 180;
const DEFAULT_MAX_TEX_CHARS = 4000;
const FORMULA_CANVAS_WIDTH = 1000;
const FORMULA_CANVAS_PADDING_X = 40;
const FORMULA_CANVAS_PADDING_Y = 20;
const FORMULA_RENDER_ZOOM = 3.4;
const INLINE_FORMULA_RENDER_ZOOM = 2.6;
const INLINE_TEXT_FONT_SIZE = 30;
const FORMULA_BACKGROUND = '#f8fafc';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let mathJaxPromise;
let resvgPromise;
let systemTextFontBuffers;
const renderCache = new Map();

function parseLatexContent(text, options = {}) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const nodes = [];
  const markdownLines = [];
  const maxInlineLineChars = positiveInteger(
    options.maxInlineLineChars,
    DEFAULT_MAX_INLINE_LINE_CHARS
  );
  let fenceMarker = '';

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return;
    nodes.push({ type: 'markdown', text: markdownLines.join('\n') });
    markdownLines.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0];
      if (!fenceMarker) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = '';
      markdownLines.push(line);
      continue;
    }
    if (fenceMarker) {
      markdownLines.push(line);
      continue;
    }

    const block = readLatexBlock(lines, index);
    if (block) {
      flushMarkdown();
      nodes.push({
        type: 'formula',
        display: true,
        latex: block.latex,
        source: lines.slice(index, block.endLine + 1).join('\n')
      });
      index = block.endLine;
      continue;
    }

    const inlineSegments = parseInlineLatex(line);
    if (!inlineSegments.some((segment) => segment.type === 'formula')) {
      markdownLines.push(line);
      continue;
    }

    flushMarkdown();
    if (line.length <= maxInlineLineChars) {
      nodes.push({
        type: 'inline_formula_line',
        display: false,
        segments: inlineSegments,
        source: line
      });
      continue;
    }

    for (const segment of inlineSegments) {
      if (segment.type === 'formula') {
        nodes.push({
          type: 'formula',
          display: false,
          latex: segment.latex,
          source: segment.source
        });
      } else if (segment.text) {
        nodes.push({ type: 'markdown', text: segment.text });
      }
    }
  }

  flushMarkdown();
  return nodes;
}

function readLatexBlock(lines, startLine) {
  const line = String(lines[startLine] || '');
  const compact = line.trim();
  const singleLine = [
    { regex: /^\\\[([\s\S]+)\\\]$/, delimiter: 'escaped_bracket' },
    { regex: /^\$\$([\s\S]+)\$\$$/, delimiter: 'double_dollar' },
    { regex: /^\[([\s\S]+)\]$/, delimiter: 'bare_bracket' }
  ];

  for (const candidate of singleLine) {
    const match = compact.match(candidate.regex);
    if (!match) continue;
    const latex = match[1].trim();
    if (!isValidLatexCandidate(latex, candidate.delimiter === 'bare_bracket')) continue;
    return { endLine: startLine, latex };
  }

  const delimiters = {
    '\\[': { close: '\\]', bare: false },
    '$$': { close: '$$', bare: false },
    '[': { close: ']', bare: true }
  };
  const delimiter = delimiters[compact];
  if (!delimiter) return null;

  const content = [];
  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (String(lines[index] || '').trim() !== delimiter.close) {
      content.push(lines[index]);
      continue;
    }
    const latex = content.join('\n').trim();
    if (!isValidLatexCandidate(latex, delimiter.bare)) return null;
    return { endLine: index, latex };
  }
  return null;
}

function parseInlineLatex(line) {
  const source = String(line || '');
  const matches = [];
  const patterns = [
    { regex: /\\\((.+?)\\\)/g, group: 1, requireMathSignal: false },
    { regex: /(^|[^\\$])\$(?!\$)(.+?)(?<!\\)\$(?!\$)/g, group: 2, requireMathSignal: true }
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(source))) {
      const latex = String(match[pattern.group] || '').trim();
      if (!isValidLatexCandidate(latex, pattern.requireMathSignal)) continue;
      const prefixChars = pattern.group === 2 ? String(match[1] || '').length : 0;
      const start = match.index + prefixChars;
      const raw = match[0].slice(prefixChars);
      matches.push({ start, end: start + raw.length, latex, source: raw });
    }
  }

  matches.sort((left, right) => left.start - right.start || left.end - right.end);
  const nonOverlapping = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start < lastEnd) continue;
    nonOverlapping.push(match);
    lastEnd = match.end;
  }
  if (nonOverlapping.length === 0) return [{ type: 'text', text: source }];

  const segments = [];
  let cursor = 0;
  for (const match of nonOverlapping) {
    if (match.start > cursor) {
      segments.push({ type: 'text', text: source.slice(cursor, match.start) });
    }
    segments.push({
      type: 'formula',
      latex: match.latex,
      source: match.source
    });
    cursor = match.end;
  }
  if (cursor < source.length) {
    segments.push({ type: 'text', text: source.slice(cursor) });
  }
  return segments;
}

function isValidLatexCandidate(latex, requireMathSignal = false) {
  const value = String(latex || '').trim();
  if (!value || value.length > DEFAULT_MAX_TEX_CHARS) return false;
  if (!requireMathSignal) return true;
  if (/\\[A-Za-z]+|[\^_{}=]|(?:^|\s)[+*/<>](?:\s|$)/.test(value)) return true;
  return /\d\s*[+\-*/=<>]\s*\d/.test(value);
}

async function renderLatexToPng(latex, options = {}) {
  const source = String(latex || '').trim();
  if (!source) throw new Error('LaTeX source is empty.');
  if (source.length > DEFAULT_MAX_TEX_CHARS) {
    throw new Error(`LaTeX source exceeds ${DEFAULT_MAX_TEX_CHARS} characters.`);
  }
  return renderTexToPng(source, {
    cacheKey: `formula:${options.display === false ? 'inline' : 'display'}:${source}`,
    display: options.display !== false
  });
}

async function renderInlineFormulaLineToPng(segments) {
  const normalized = Array.isArray(segments) ? segments : [];
  if (!normalized.some((segment) => segment?.type === 'formula')) {
    throw new Error('Inline formula line does not contain a formula.');
  }
  const cacheKey = normalized
    .map((segment) => `${segment?.type || 'text'}:${segment?.latex || segment?.text || ''}`)
    .join('\u0000');
  const key = crypto.createHash('sha256').update(`mixed-line-v1:${cacheKey}`).digest('hex');
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cloneRenderResult(cached);
  }

  const [MathJax, resvg] = await Promise.all([getMathJax(), getResvg()]);
  const parts = [];
  for (const segment of normalized) {
    if (segment?.type === 'formula') {
      parts.push(await renderMathJaxContent(MathJax, resvg, segment.latex, {
        display: false,
        zoom: INLINE_FORMULA_RENDER_ZOOM
      }));
      continue;
    }
    const text = normalizeInlineDisplayText(segment?.text);
    if (text) parts.push(renderPlainTextContent(resvg, text));
  }
  const result = renderPartsOnCanvas(resvg, parts, { paddingY: 12, cacheKey: key });
  rememberRender(key, result);
  return cloneRenderResult(result);
}

async function renderTexToPng(tex, { cacheKey, display }) {
  const key = crypto.createHash('sha256').update(`canvas-v2:${cacheKey}`).digest('hex');
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cloneRenderResult(cached);
  }

  const [MathJax, resvg] = await Promise.all([getMathJax(), getResvg()]);
  const content = await renderMathJaxContent(MathJax, resvg, tex, {
    display,
    zoom: FORMULA_RENDER_ZOOM
  });
  const result = renderPartsOnCanvas(resvg, [content], { cacheKey: key });
  rememberRender(key, result);
  return cloneRenderResult(result);
}

async function renderMathJaxContent(MathJax, resvg, tex, { display, zoom }) {
  const adaptor = MathJax.startup.adaptor;
  // MathJax v4 may line-break inline SVG into several sibling <svg> nodes when
  // no browser layout metrics exist. A standalone display SVG is deterministic;
  // the mixed-line compositor controls its final size and baseline placement.
  const markup = adaptor.outerHTML(
    await MathJax.tex2svgPromise(String(tex || ''), { display: true })
  );
  if (/data-mml-node=["']merror["']|data-mjx-error/i.test(markup)) {
    throw new Error('MathJax could not parse the LaTeX source.');
  }
  const svgMatch = markup.match(/<svg[\s\S]*<\/svg>/i);
  if (!svgMatch) throw new Error('MathJax did not produce SVG output.');

  const renderOptions = {
    fitTo: { mode: 'zoom', value: zoom },
    font: getFontOptions()
  };
  let image = new resvg.Resvg(svgMatch[0], renderOptions).render();
  const maxContentWidth = FORMULA_CANVAS_WIDTH - (FORMULA_CANVAS_PADDING_X * 2);
  if (image.width > maxContentWidth) {
    image = new resvg.Resvg(svgMatch[0], {
      ...renderOptions,
      fitTo: { mode: 'width', value: maxContentWidth }
    }).render();
  }
  return {
    png: Buffer.from(image.asPng()),
    width: image.width,
    height: image.height
  };
}

function renderPlainTextContent(resvg, text) {
  const fontOptions = getFontOptions();
  if (!fontOptions.fontBuffers?.length) {
    throw new Error('No local font is available for inline formula text rendering.');
  }
  const value = String(text || '');
  const width = Math.max(2, Math.ceil(estimateTextWidth(value, INLINE_TEXT_FONT_SIZE)) + 4);
  const height = Math.ceil(INLINE_TEXT_FONT_SIZE * 1.5);
  const baseline = Math.ceil(INLINE_TEXT_FONT_SIZE * 1.12);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<text x="2" y="${baseline}" fill="#111827" font-family="Noto Sans CJK SC, Noto Sans, sans-serif" font-size="${INLINE_TEXT_FONT_SIZE}px">${escapeXmlText(value)}</text>`,
    '</svg>'
  ].join('');
  const image = new resvg.Resvg(svg, { font: fontOptions }).render();
  return {
    png: Buffer.from(image.asPng()),
    width: image.width,
    height: image.height
  };
}

function renderPartsOnCanvas(resvg, parts, options = {}) {
  const contentParts = parts.filter((part) => part?.png?.length && part.width > 0 && part.height > 0);
  if (contentParts.length === 0) throw new Error('LaTeX renderer produced no visible content.');
  const paddingY = Number.isFinite(Number(options.paddingY))
    ? Math.max(0, Number(options.paddingY))
    : FORMULA_CANVAS_PADDING_Y;
  const naturalWidth = contentParts.reduce((total, part) => total + part.width, 0);
  const naturalHeight = Math.max(...contentParts.map((part) => part.height));
  const maxContentWidth = FORMULA_CANVAS_WIDTH - (FORMULA_CANVAS_PADDING_X * 2);
  const scale = Math.min(1, maxContentWidth / naturalWidth);
  const contentWidth = naturalWidth * scale;
  const contentHeight = naturalHeight * scale;
  const canvasHeight = Math.max(1, Math.ceil(contentHeight + (paddingY * 2)));
  let x = (FORMULA_CANVAS_WIDTH - contentWidth) / 2;
  const imageElements = contentParts.map((part) => {
    const width = part.width * scale;
    const height = part.height * scale;
    const y = paddingY + ((contentHeight - height) / 2);
    const element = `<image x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" href="data:image/png;base64,${part.png.toString('base64')}"/>`;
    x += width;
    return element;
  });
  const canvasSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FORMULA_CANVAS_WIDTH}" height="${canvasHeight}" viewBox="0 0 ${FORMULA_CANVAS_WIDTH} ${canvasHeight}">`,
    `<rect width="100%" height="100%" fill="${FORMULA_BACKGROUND}"/>`,
    ...imageElements,
    '</svg>'
  ].join('');
  const canvas = new resvg.Resvg(canvasSvg, { font: getFontOptions() }).render();
  const png = Buffer.from(canvas.asPng());
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('LaTeX rasterizer did not produce a PNG image.');
  }

  return {
    png,
    width: canvas.width,
    height: canvas.height,
    cacheKey: options.cacheKey || ''
  };
}

function getFontOptions() {
  const options = {
    loadSystemFonts: true,
    defaultFontFamily: 'Noto Sans CJK SC'
  };
  const fontBuffers = getSystemTextFontBuffers();
  if (fontBuffers.length > 0) options.fontBuffers = fontBuffers;
  return options;
}

function getSystemTextFontBuffers() {
  if (systemTextFontBuffers) return systemTextFontBuffers;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Windows\\Fonts\\msyh.ttc',
        'C:\\Windows\\Fonts\\msyh.ttf',
        'C:\\Windows\\Fonts\\simhei.ttf'
      ]
    : process.platform === 'darwin'
      ? [
          '/System/Library/Fonts/PingFang.ttc',
          '/System/Library/Fonts/STHeiti Light.ttc',
          '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
        ]
      : [
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-VF.ttf',
          '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
        ];
  const fontPath = candidates.find((candidate) => fs.existsSync(candidate));
  systemTextFontBuffers = fontPath ? [fs.readFileSync(fontPath)] : [];
  return systemTextFontBuffers;
}

function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const character of String(text || '')) {
    if (/\s/.test(character)) units += 0.34;
    else if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(character)) units += 1;
    else if (/[A-Z0-9]/.test(character)) units += 0.64;
    else if (/[a-z]/.test(character)) units += 0.56;
    else units += 0.48;
  }
  return units * fontSize;
}

function escapeXmlText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getMathJax() {
  if (!mathJaxPromise) {
    mathJaxPromise = require('mathjax').init({
      loader: { load: ['input/tex', 'output/svg'] }
    });
  }
  return mathJaxPromise;
}

async function getResvg() {
  if (!resvgPromise) {
    resvgPromise = (async () => {
      const resvg = require('@resvg/resvg-wasm');
      const wasm = fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
      await resvg.initWasm(wasm);
      return resvg;
    })();
  }
  return resvgPromise;
}

function rememberRender(key, result) {
  renderCache.set(key, result);
  while (renderCache.size > DEFAULT_MAX_CACHE_ENTRIES) {
    renderCache.delete(renderCache.keys().next().value);
  }
}

function cloneRenderResult(result) {
  return { ...result, png: Buffer.from(result.png) };
}

function normalizeInlineDisplayText(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/(^|\s)[*_~](?=\S)|(?<=\S)[*_~](?=\s|$)/g, '$1');
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  DEFAULT_MAX_INLINE_LINE_CHARS,
  DEFAULT_MAX_TEX_CHARS,
  parseInlineLatex,
  parseLatexContent,
  renderInlineFormulaLineToPng,
  renderLatexToPng
};
