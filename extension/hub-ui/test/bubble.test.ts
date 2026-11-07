import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeBubble } from '../src/bubble.ts';

const vp = { width: 800, height: 600 };
const size = { width: 200, height: 40 };

test('bubble: above the clicked button by default, centered on it, the tail clear of the button text', () => {
  const p = placeBubble({ left: 300, right: 400, top: 100, bottom: 124 }, size, vp);
  assert.deepEqual(p, { left: 250, top: 100 - 12 - 40, side: 'above', arrowX: 100 });
  // 꼬리(바깥으로 약 8px)가 단추 위 테두리에 닿지 않아요
  assert.ok(p.top + size.height + 8 < 100);
});

test('bubble: below when there is no room above; pushed inside the window edges', () => {
  const high = placeBubble({ left: 300, right: 400, top: 20, bottom: 44 }, size, vp);
  assert.equal(high.side, 'below');
  assert.equal(high.top, 44 + 12);
  const leftEdge = placeBubble({ left: 0, right: 30, top: 100, bottom: 120 }, size, vp);
  assert.equal(leftEdge.left, 8);
  assert.ok(leftEdge.arrowX >= 12 && leftEdge.arrowX <= 15, 'tail still points at the button');
  const rightEdge = placeBubble({ left: 780, right: 800, top: 100, bottom: 120 }, size, vp);
  assert.equal(rightEdge.left, 800 - 8 - 200);
  assert.equal(rightEdge.arrowX, 200 - 12, 'tail clamped inside the bubble');
});

test('bubble: a point (button gone) works too; tiny windows keep it on screen', () => {
  const p = placeBubble({ left: 50, right: 50, top: 100, bottom: 100 }, size, vp);
  assert.equal(p.side, 'above');
  const tiny = placeBubble({ left: 10, right: 20, top: 5, bottom: 15 }, size, { width: 150, height: 50 });
  assert.equal(tiny.side, 'below', 'no room either way: below, clamped');
  assert.ok(tiny.top >= 8);
});
