const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const feishuModule = require('../src/plugins/feishu');
const realLatexRenderer = require('../src/latexRenderer');
const { normalizeConfig } = require('../src/config');

async function main() {
  const normalizedConfig = normalizeConfig({
    plugins: { feishu: { latexMaxFormulas: 64 } }
  }, '/tmp/remote-codex-test-config.json');
  assert.equal(
    normalizedConfig.plugins.feishu.latexMaxFormulas,
    64,
    'config normalization must not silently restore the old 20-formula cap'
  );

  const uploads = [];
  const cardkitRequests = [];
  const fakeLatexRenderer = {
    parseLatexContent: realLatexRenderer.parseLatexContent,
    async renderLatexToPng(latex, options) {
      return {
        png: Buffer.from(`png:${latex}`),
        cacheKey: `formula:${options.display}:${latex}`,
        width: 120,
        height: 40
      };
    },
    async renderInlineFormulaLineToPng(segments) {
      const source = segments.map((segment) => segment.latex || segment.text).join('');
      return {
        png: Buffer.from(`png:${source}`),
        cacheKey: `line:${source}`,
        width: 320,
        height: 40
      };
    }
  };
  const plugin = feishuModule.create({
    config: {},
    pluginConfig: {
      mode: 'long_connection',
      appId: 'app-id',
      appSecret: 'app-secret',
      latexRenderingEnabled: true,
      latexMaxFormulas: 64
    },
    services: { latexRenderer: fakeLatexRenderer },
    logger: { event() {}, warn() {} }
  });
  plugin.client = {
    im: {
      v1: {
        image: {
          async create(payload) {
            uploads.push(payload);
            return { image_key: `img_formula_${uploads.length}` };
          }
        }
      }
    }
  };
  plugin.cardkitRequest = async (path, request) => {
    cardkitRequests.push({ path, request });
    return { data: {} };
  };

  const stream = new feishuModule.__private.FeishuReplyStream({
    plugin,
    cardId: 'card-1',
    elementId: 'content',
    title: 'Remote Codex',
    renderLatex: true,
    logger: { event() {}, warn() {} }
  });
  const answer = [
    '质能关系如下：',
    '',
    '\\[',
    'E = mc^2',
    '\\]',
    '',
    '并且行内公式 $a^2+b^2=c^2$ 不应泄漏原始标记。'
  ].join('\n');
  await stream.finish(answer);

  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].data.image_type, 'message');
  assert.ok(Buffer.isBuffer(uploads[0].data.image));
  assert.equal(cardkitRequests.length, 1, 'formula finalization should close once without raw final update');
  assert.equal(cardkitRequests[0].path, '/cardkit/v1/cards/card-1');

  const card = JSON.parse(cardkitRequests[0].request.body.card.data);
  const elements = card.body.elements;
  assert.deepEqual(elements.map((element) => element.tag), ['markdown', 'img', 'img']);
  assert.equal(elements[1].img_key, 'img_formula_1');
  assert.equal(elements[2].img_key, 'img_formula_2');
  assert.doesNotMatch(JSON.stringify(card), /a\^2\+b\^2|E = mc\^2|\\\\\[/);

  const cached = await plugin.prepareFinalCardContent(answer);
  assert.equal(cached.renderedCount, 2);
  assert.equal(uploads.length, 2, 'the same rendered formulas should reuse image keys');

  const slamAnswer = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'feishu-latex-slam.md'),
    'utf8'
  );
  const preparedSlam = await plugin.prepareFinalCardContent(slamAnswer);
  assert.equal(preparedSlam.formulaCount, 23);
  assert.equal(preparedSlam.renderedCount, 23, 'the default limit must cover the captured answer');
  assert.equal(
    preparedSlam.elements.filter((element) => element.tag === 'img').length,
    23
  );
  assert.doesNotMatch(
    JSON.stringify(preparedSlam.elements),
    /\\\\\[|\\\\\(|\\\\mathcal|\\\\operatorname|\\\\boxed/
  );

  const slamStream = new feishuModule.__private.FeishuReplyStream({
    plugin,
    cardId: 'card-slam',
    elementId: 'content',
    title: 'Remote Codex',
    renderLatex: true,
    logger: { event() {}, warn() {} }
  });
  await slamStream.finish(slamAnswer);
  assert.equal(cardkitRequests.length, 2);
  assert.equal(cardkitRequests[1].path, '/cardkit/v1/cards/card-slam');
  const slamCard = JSON.parse(cardkitRequests[1].request.body.card.data);
  assert.equal(
    slamCard.body.elements.filter((element) => element.tag === 'img').length,
    23
  );
  assert.doesNotMatch(
    JSON.stringify(slamCard),
    /\\\\\[|\\\\\(|\\\\mathcal|\\\\operatorname|\\\\boxed/
  );

  const fiftyFiveFormulas = Array.from({ length: 55 }, (_, index) => [
    `公式 ${index + 1}：`,
    '',
    '\\[',
    `x_{${index + 1}} = ${index + 1}`,
    '\\]'
  ].join('\n')).join('\n\n');
  const preparedFiftyFive = await plugin.prepareFinalCardContent(fiftyFiveFormulas);
  assert.equal(preparedFiftyFive.formulaCount, 55);
  assert.equal(preparedFiftyFive.renderedCount, 55);
  assert.equal(preparedFiftyFive.cappedCount, 0);
  assert.equal(preparedFiftyFive.failedCount, 0);
  assert.equal(
    preparedFiftyFive.elements.filter((element) => element.tag === 'img').length,
    55
  );
  const fiftyFiveStream = new feishuModule.__private.FeishuReplyStream({
    plugin,
    cardId: 'card-55-formulas',
    elementId: 'content',
    title: 'Remote Codex',
    renderLatex: true,
    logger: { event() {}, warn() {} }
  });
  await fiftyFiveStream.finish(fiftyFiveFormulas);
  assert.equal(cardkitRequests.length, 3);
  const fiftyFiveCard = JSON.parse(cardkitRequests[2].request.body.card.data);
  assert.equal(
    fiftyFiveCard.body.elements.filter((element) => element.tag === 'img').length,
    55
  );
  assert.doesNotMatch(JSON.stringify(fiftyFiveCard), /\\\\\[|x_\{/);

  process.stdout.write('Feishu LaTeX card tests passed.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
