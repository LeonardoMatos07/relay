import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { escapeHtml, placeholders, renderTemplate } from './template';

describe('renderTemplate', () => {
  it('fills placeholders, tolerating spaces inside the braces', () => {
    assert.equal(
      renderTemplate('Hi {{name}}, code {{ code }}', { name: 'Ana', code: 123456 }, 'text'),
      'Hi Ana, code 123456',
    );
  });

  it('escapes values in HTML and leaves them alone in text', () => {
    const vars = { name: '<b>Ana & "Co"</b>' };
    assert.equal(renderTemplate('<p>{{name}}</p>', vars, 'html'), '<p>&lt;b&gt;Ana &amp; &quot;Co&quot;&lt;/b&gt;</p>');
    assert.equal(renderTemplate('Hi {{name}}', vars, 'text'), 'Hi <b>Ana & "Co"</b>');
  });

  it('does not expand placeholders that appear inside a value', () => {
    assert.equal(renderTemplate('{{a}}', { a: '{{b}}', b: 'secret' }, 'text'), '{{b}}');
  });

  it('keeps braces that are not placeholders', () => {
    assert.equal(renderTemplate('a {x} {{ 1x }} {{}}', {}, 'text'), 'a {x} {{ 1x }} {{}}');
  });
});

describe('placeholders', () => {
  it('lists each name once', () => {
    assert.deepEqual(placeholders('{{a}} {{b}} {{a}}'), ['a', 'b']);
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});
