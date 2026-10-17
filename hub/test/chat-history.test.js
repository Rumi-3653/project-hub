'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create, atBoundary } = require('../public/chat-history');

test('history boundary handles empty lines, line ends, selections and single-line instructions', () => {
  const check = (value, position, direction, end=position) => atBoundary({value, selectionStart:position, selectionEnd:end},direction);
  for (const text of ['', 'one']) for (let i=0;i<=text.length;i++) {
    assert.equal(check(text,i,-1),true); assert.equal(check(text,i,1),true);
  }
  for (const [text,pos,up,down] of [['first\nmiddle\nlast',5,true,false],['first\nmiddle\nlast',6,false,false],['first\nmiddle\nlast',13,false,true],['\n',0,true,false],['\n',1,false,true],['\n\n',1,false,false],['last\n',5,false,true]]) {
    assert.equal(check(text,pos,-1),up); assert.equal(check(text,pos,1),down);
  }
  assert.equal(check('selected',0,-1,3),false); assert.equal(check('selected',0,1,3),false);
});

test('soft-wrap positions require both adjacent characters to be on the boundary line', () => {
  let removed = 0;
  const ta = {value:'abcdef', selectionStart:0, selectionEnd:0, clientWidth:300};
  ta.ownerDocument = {
    defaultView:{getComputedStyle:()=>({})}, body:{appendChild(){}},
    createElement:()=>({style:{},appendChild(){},remove(){removed++;}}),
    createTextNode:text=>({text}),
    createRange:()=>({
      setStart(node,index){this.from=index;}, setEnd(node,index){this.to=index;}, collapse(){this.to=this.from;},
      getBoundingClientRect(){
        // A collapsed range chooses the previous line at offsets 2 and 4.
        const index = this.from === this.to ? Math.max(0,this.from-1) : this.from;
        return {top:Math.floor(index/2)*20,height:20};
      }
    })
  };
  for (const [position, up, down] of [[0,true,false],[1,true,false],[2,false,false],[3,false,false],[4,false,false],[5,false,true],[6,false,true]]) {
    ta.selectionStart=ta.selectionEnd=position;
    assert.equal(atBoundary(ta,-1),up,`up at ${position}`);
    assert.equal(atBoundary(ta,1),down,`down at ${position}`);
  }
  assert.equal(removed,14);
});

test('history recalls exactly the last three submitted instructions without trimming or wrapping', () => {
  const h = create();
  for (const text of ['oldest', '  one\n\nline  ', 'two', 'three']) h.record('task', text);
  assert.equal(h.move('task', -1, 'draft').text, 'three');
  assert.equal(h.move('task', -1, 'three').text, 'two');
  assert.equal(h.move('task', -1, 'two').text, '  one\n\nline  ');
  assert.equal(h.move('task', -1, '  one\n\nline  ').text, '  one\n\nline  ');
});
test('down restores the exact draft and selection, while edits to recalled text remain temporary', () => {
  const h = create(); h.record('task', 'first'); h.record('task', 'second');
  h.move('task', -1, '変換済み\n途中の文章', 2, 4);
  h.move('task', -1, 'second edited', 3, 5);
  assert.deepEqual(h.move('task', 1, 'first'), { text: 'second edited', start: 3, end: 5 });
  assert.deepEqual(h.move('task', 1, 'second edited', 3, 5), { text: '変換済み\n途中の文章', start: 2, end: 4 });
  assert.equal(h.move('task', 1, 'draft'), null);
  assert.equal(h.move('task', -1, 'draft').text, 'second');
});
test('successful submissions persist per work, blank input is omitted, and reload retains three', () => {
  const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v) };
  const h = create(storage); h.record('a', 'one'); h.record('a', 'two'); h.record('a', ' '); h.record('b', 'other');
  const reloaded = create(storage);
  assert.equal(reloaded.move('a', -1, '').text, 'two');
  assert.equal(reloaded.move('b', -1, '').text, 'other');
  assert.equal(reloaded.move('absent', -1, ''), null);
});
test('storage failure or invalid stored data never prevents restoring the current draft', () => {
  for (const raw of ['bad json', '{}', '[null,42,"","saved"]']) {
    const h = create({ getItem: () => raw, setItem() { throw Error('full'); } });
    h.record('task', 'accepted');
    assert.equal(h.move('task', -1, 'current').text, 'accepted');
    assert.equal(h.move('task', 1, 'accepted').text, 'current');
  }
});
test('history is frozen while browsing, so a concurrent send cannot shift the restoration target', () => {
  const h = create(); h.record('task', 'old'); h.move('task', -1, 'new draft'); h.record('task', 'sent meanwhile');
  assert.equal(h.move('task', 1, 'old').text, 'new draft');
  assert.equal(h.move('task', -1, 'new draft').text, 'sent meanwhile');
});
