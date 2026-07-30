const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseInlineLatex,
  parseLatexContent,
  renderInlineFormulaLineToPng,
  renderLatexToPng
} = require('../src/latexRenderer');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function main() {
  const source = [
    '质能关系：',
    '',
    '\\[',
    'E = mc^2',
    '\\]',
    '',
    '高斯积分：',
    '',
    '[',
    '\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    ']',
    '',
    '行内关系 $a^2+b^2=c^2$ 仍应保持在一句话里。',
    '',
    '```latex',
    '$this^2$ must stay in the code fence',
    '```'
  ].join('\n');
  const nodes = parseLatexContent(source);
  assert.deepEqual(
    nodes.filter((node) => node.type === 'formula').map((node) => node.latex),
    [
      'E = mc^2',
      '\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}'
    ]
  );
  const inlineNode = nodes.find((node) => node.type === 'inline_formula_line');
  assert.ok(inlineNode, 'inline formula line should be recognized');
  assert.equal(inlineNode.segments.find((segment) => segment.type === 'formula').latex, 'a^2+b^2=c^2');
  assert.match(
    nodes.filter((node) => node.type === 'markdown').map((node) => node.text).join('\n'),
    /\$this\^2\$ must stay in the code fence/
  );

  assert.deepEqual(parseInlineLatex('价格是 $20，不是公式'), [
    { type: 'text', text: '价格是 $20，不是公式' }
  ]);
  assert.equal(
    parseInlineLatex('变量 \\(m\\) 与李群 \\(SE(3)\\)')
      .filter((segment) => segment.type === 'formula').length,
    2,
    'explicit inline delimiters must not require an operator or subscript'
  );

  const display = await renderLatexToPng(
    '\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}'
  );
  assertPng(display);

  const inline = await renderInlineFormulaLineToPng(inlineNode.segments);
  assertPng(inline);
  assert.ok(inline.width > inline.height, 'inline formula sentence should render horizontally');
  assert.ok(inline.png.length > 5000, 'Chinese text must be present in the inline formula image');

  const cached = await renderLatexToPng(
    '\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}'
  );
  assert.equal(cached.cacheKey, display.cacheKey);
  assert.deepEqual(cached.png, display.png);

  const slamAnswer = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'feishu-latex-slam.md'),
    'utf8'
  );
  const slamNodes = parseLatexContent(slamAnswer);
  const slamFormulas = slamNodes.filter((node) => node.type !== 'markdown');
  assert.equal(slamFormulas.length, 23, 'the captured SLAM answer must expose every formula line');
  for (const node of slamFormulas) {
    const rendered = node.type === 'inline_formula_line'
      ? await renderInlineFormulaLineToPng(node.segments)
      : await renderLatexToPng(node.latex, { display: node.display !== false });
    assertPng(rendered);
  }

  process.stdout.write('LaTeX renderer tests passed.\n');
}

function assertPng(rendered) {
  assert.ok(rendered.width > 0);
  assert.ok(rendered.height > 0);
  assert.ok(rendered.png.length > PNG_SIGNATURE.length);
  assert.deepEqual(rendered.png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.ok(rendered.png.length < 10 * 1024 * 1024);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
